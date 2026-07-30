/**
 * Shared commit pipeline for both selection interfaces (floating window and
 * in-place). Owns drafts, compatibility warnings, the §8.4 confirmation
 * preview, and running the transaction with user feedback.
 */

import { createAnchor } from '../anchors.js';
import { REWRITE_MODE_LABELS } from '../constants.js';
import { splitAtOffset } from '../segmentation.js';
import { getCtx } from '../stcontext.js';
import { IntercedeTransaction } from '../transaction.js';
import { el, notify, truncate } from '../utils.js';
import { showCompare } from './compare.js';
import { showConfirm } from './modal.js';

/** Drafts survive a failed or cancelled intercession so the user can retry (§18). */
const drafts = new Map();

function draftKey(chatId, targetIndex) {
    return `${chatId}::${targetIndex}`;
}

export function getDraft(chatId, targetIndex) {
    return drafts.get(draftKey(chatId, targetIndex)) ?? null;
}

/** @param {{ text: string, mode?: string, boundaryOffset?: number | null } | null} draft */
export function setDraft(chatId, targetIndex, draft) {
    const key = draftKey(chatId, targetIndex);
    if (draft?.text?.trim()) {
        drafts.set(key, draft);
    } else {
        drafts.delete(key);
    }
}

/**
 * Resolve a stored draft's boundary back to an index in the caller's boundary
 * list. Drafts store the raw-text offset — stable across the two interfaces,
 * which may filter their boundary lists differently — never a positional index.
 */
export function findDraftBoundaryIndex(draft, boundaries) {
    if (!draft || !Number.isFinite(draft.boundaryOffset)) return null;
    const index = boundaries.findIndex(boundary => boundary.offset === draft.boundaryOffset);
    return index === -1 ? null : index;
}

const KNOWN_MESSAGE_KEYS = new Set([
    'name', 'is_user', 'is_system', 'is_name', 'send_date', 'mes', 'extra',
    'swipe_id', 'swipes', 'swipe_info', 'gen_started', 'gen_finished',
    'force_avatar', 'original_avatar', 'title', 'variables',
]);

/** Best-effort detection of another extension's continuation/branch metadata (§16.4). */
export function detectForeignContinuationData(message) {
    const suspicious = [];
    for (const key of Object.keys(message ?? {})) {
        if (!KNOWN_MESSAGE_KEYS.has(key) && /continu|branch|tree/i.test(key)) suspicious.push(key);
    }
    for (const key of Object.keys(message?.extra ?? {})) {
        if (/continu|branch|tree/i.test(key)) suspicious.push(`extra.${key}`);
    }
    return suspicious;
}

const MEMORY_EXTENSION_KEYS = ['memory', 'vectors', 'vectors_enhanced', 'smart_memory', 'qvink_memory'];

export function detectMemoryExtensions(ctx) {
    const store = ctx?.extensionSettings ?? ctx?.extension_settings ?? {};
    return MEMORY_EXTENSION_KEYS.filter(key => store[key] && typeof store[key] === 'object');
}

/**
 * Confirm (per settings) and run the intercession transaction.
 * `closeMode()` is invoked after confirmation, before any mutation, so the
 * selection UI can restore the message's native rendering first.
 * @returns {Promise<boolean>} true when committed
 */
export async function confirmAndCommit({ chatId, targetIndex, raw, boundary, insertionText, rewriteMode, message, settings, closeMode }) {
    const anchor = createAnchor(raw, boundary.offset, boundary.type);
    const { prefix, suffix } = splitAtOffset(raw, boundary.offset);

    if (settings.confirmBeforeCommit) {
        const ctx = getCtx();
        const warnings = [];
        if (settings.warnExtensions) {
            const foreign = detectForeignContinuationData(message);
            if (foreign.length) {
                warnings.push(`This message carries continuation metadata from another extension (${foreign.join(', ')}). Only the visible text becomes the prefix; the full message is preserved for undo.`);
            }
            const memory = detectMemoryExtensions(ctx);
            if (memory.length) {
                warnings.push(`Memory-related extensions are active (${memory.join(', ')}). Memories already derived from this message are not automatically recalculated.`);
            }
        }

        const preview = el('div', 'intercede-confirm');
        const addSection = (heading, text, className) => {
            const section = el('div', 'intercede-compare-section');
            section.appendChild(el('div', 'intercede-compare-heading', heading));
            section.appendChild(el('div', `intercede-compare-text ${className}`, text));
            preview.appendChild(section);
        };
        addSection('Preserved (ends with)', '…' + prefix.slice(-240), 'intercede-compare-revised');
        addSection('Your response', insertionText, 'intercede-compare-insertion');
        addSection('Rewritten from here (originally)', truncate(suffix, 300), 'intercede-compare-original');
        preview.appendChild(el('div', 'intercede-compare-heading', `Rewrite mode: ${REWRITE_MODE_LABELS[rewriteMode]}`));
        for (const warning of warnings) {
            preview.appendChild(el('div', 'intercede-confirm-warning', '⚠ ' + warning));
        }

        const confirmed = await showConfirm('Commit this intercession?', preview, {
            confirmLabel: 'Intercede',
            cancelLabel: 'Back',
        });
        if (!confirmed) return false;
    }

    closeMode();

    notify('info', 'Interceding — rewriting the continuation…');
    const transaction = new IntercedeTransaction({ targetIndex, anchor, insertionText, rewriteMode });
    try {
        const result = await transaction.run();
        drafts.delete(draftKey(chatId, targetIndex));
        notify('success', 'Intercession committed. Swipe the new continuation for other adaptations; /intercede undo restores the original.');
        for (const warning of result.warnings) {
            notify('warning', warning, { timeOut: 8000 });
        }
        if (settings.compareAfterCommit) {
            await showCompare();
        }
        return true;
    } catch (error) {
        notify('error', `Intercession failed and was rolled back: ${error?.message ?? error}. Your response text was kept — open Intercede again to retry.`);
        return false;
    }
}
