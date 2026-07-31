/**
 * Plumbing shared by both selection interfaces.
 *
 * The two modes genuinely differ in only two things: where the markers are
 * drawn, and how the remainder is dimmed. Everything from "which message, and
 * where may it be cut" to "commit whatever the composer holds" is identical,
 * and lives here so it cannot drift apart.
 *
 * @see docs/RATIONALE.md#UI-12 one controller, two presentations
 */

import { REWRITE_MODES, REWRITE_MODE_LABELS } from '../constants.js';
import { getBoundaries } from '../segmentation.js';
import { getCtx, getCurrentChatId, getSettings } from '../stcontext.js';
import { isEligibleTarget } from '../transaction.js';
import { el, hashText, notify } from '../utils.js';
import { confirmAndCommit, setDraft } from './commit-flow.js';

/**
 * The state both interfaces keep. Each adds its own presentation fields.
 * @typedef {object} SelectionState
 * @property {string} chatId
 * @property {number} targetIndex
 * @property {object} message
 * @property {object} settings
 * @property {string} raw
 * @property {string} sourceHash identity of `raw`, so a draft cannot land on other text
 * @property {{ offset: number, type: string }[]} boundaries
 * @property {number | null} selectedIndex
 * @property {HTMLElement | null} composer
 */

/**
 * Answer "which message, and where may it be cut?" for either interface,
 * reporting the reason to the user when the answer is nowhere.
 *
 * @param {number} [index] message to target, or the latest eligible one
 * @returns {{ ok: true, ctx: object, settings: object, chatId: string, targetIndex: number,
 *   message: object, raw: string, boundaries: { offset: number, type: string }[] }
 *   | { ok: false }}
 */
export function resolveSelectionTarget(index = undefined) {
    const ctx = getCtx();
    const settings = getSettings(ctx);
    const eligible = isEligibleTarget(ctx, index);
    if (!eligible.ok) {
        notify('warning', eligible.reason);
        return { ok: false };
    }

    const raw = String(eligible.message.mes ?? '');
    const boundaries = getBoundaries(raw, settings.boundaries);
    if (!boundaries.length) {
        notify('warning', 'No safe insertion points were found in this message.');
        return { ok: false };
    }

    return {
        ok: true,
        ctx,
        settings,
        chatId: getCurrentChatId(ctx),
        targetIndex: eligible.targetIndex,
        message: eligible.message,
        raw,
        // Identity of the text the boundaries were computed from.
        // @see docs/RATIONALE.md#UI-05
        sourceHash: hashText(raw),
        boundaries,
    };
}

/**
 * Persist what the composer currently holds against the message it belongs to.
 * @see docs/RATIONALE.md#UI-05 why the boundary is stored as an offset
 * @param {SelectionState | null} state
 */
export function saveDraftFromState(state) {
    const textarea = state?.composer?.querySelector('textarea');
    if (!state || !textarea) return;
    setDraft(state, {
        text: textarea.value,
        mode: state.composer.querySelector('select')?.value,
        boundaryOffset: state.selectedIndex === null ? null : state.boundaries[state.selectedIndex]?.offset,
    });
}

/**
 * The response composer: textarea, rewrite-mode select, commit and cancel.
 *
 * @param {object} options
 * @param {SelectionState} options.state the state the draft is saved against
 * @param {{ text?: string, mode?: string } | null} options.draft restored contents
 * @param {string} [options.variant] extra class distinguishing the two placements
 * @param {() => void} options.onCommit
 * @param {() => void} options.onCancel
 * @returns {HTMLElement}
 */
export function buildComposer({ state, draft, variant, onCommit, onCancel }) {
    const composer = el('div', 'intercede-composer' + (variant ? ' ' + variant : ''));

    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole intercede-composer-text';
    textarea.placeholder = 'Your response at this point…';
    textarea.rows = 3;
    if (draft?.text) textarea.value = draft.text;
    textarea.addEventListener('input', () => saveDraftFromState(state));

    const controls = el('div', 'intercede-composer-controls');

    const select = document.createElement('select');
    select.className = 'text_pole intercede-mode-select';
    for (const mode of Object.values(REWRITE_MODES)) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = REWRITE_MODE_LABELS[mode];
        select.appendChild(option);
    }
    select.value = draft?.mode ?? state.settings.defaultMode ?? REWRITE_MODES.ADAPTIVE;

    const commitButton = el('button', 'menu_button intercede-primary', 'Intercede');
    commitButton.type = 'button';
    commitButton.title = 'Commit (Ctrl+Enter)';
    commitButton.addEventListener('click', onCommit);

    const cancelButton = el('button', 'menu_button', 'Cancel');
    cancelButton.type = 'button';
    cancelButton.addEventListener('click', onCancel);

    // The mode select is a setting; these two are the actions. Keeping them in
    // their own group lets the row anchor them right, away from the select,
    // in the same order the confirmation dialog uses.
    // @see docs/RATIONALE.md#UI-13
    const actions = el('div', 'intercede-composer-actions');
    actions.append(commitButton, cancelButton);
    controls.append(select, actions);
    composer.append(textarea, controls);
    composer.appendChild(el('div', 'intercede-composer-hint',
        'Everything above stays exactly as written. Everything dimmed below is rewritten around your response.'));
    return composer;
}

/**
 * Commit whatever the composer holds, after the same checks in both interfaces.
 * @param {SelectionState | null} state
 * @param {() => void} closeMode restores the interface before any mutation
 * @returns {Promise<boolean>} true when the intercession committed
 */
export async function commitFromState(state, closeMode) {
    if (!state || state.selectedIndex === null || !state.composer) return false;

    const textarea = state.composer.querySelector('textarea');
    const insertionText = textarea.value.trim();
    if (!insertionText) {
        notify('warning', 'Write your response first.');
        textarea.focus();
        return false;
    }

    const rewriteMode = state.composer.querySelector('select').value;
    const boundary = state.boundaries[state.selectedIndex];
    saveDraftFromState(state);

    return confirmAndCommit({
        chatId: state.chatId,
        targetIndex: state.targetIndex,
        raw: state.raw,
        boundary,
        insertionText,
        rewriteMode,
        message: state.message,
        settings: state.settings,
        closeMode,
    });
}
