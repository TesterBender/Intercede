/**
 * Original-versus-revised comparison view (§8.5, §17.6).
 */

import { getCtx } from '../stcontext.js';
import { getChainAncestry, getCommittedTipRecord } from '../transaction.js';
import { el, notify } from '../utils.js';
import { computePreservation } from '../validator.js';
import { vaultGet } from '../vault.js';
import { showModal } from './modal.js';

/**
 * Show the comparison for the committed intercession at the chat tail.
 */
export async function showCompare() {
    const ctx = getCtx();
    const record = getCommittedTipRecord(ctx);
    if (!record) {
        notify('info', 'No completed intercession at the chat tail to compare.');
        return;
    }
    const vaultRecord = await vaultGet(record.vaultKey);
    if (!vaultRecord) {
        notify('warning', 'The stored snapshot for this intercession is no longer available.');
        return;
    }

    const revised = String(ctx.chat[ctx.chat.length - 1]?.mes ?? vaultRecord.revisedSuffix ?? '');
    const original = String(vaultRecord.discardedSuffix ?? '');
    const preservation = computePreservation(original, revised);

    const content = el('div', 'intercede-compare');

    // In a chain the "original continuation" below is the previous
    // intercession's revised continuation, not the character's first draft.
    const ancestry = getChainAncestry(ctx, record.transactionId);
    if (ancestry.length) {
        content.appendChild(el('div', 'intercede-compare-meter',
            `Intercession ${ancestry.length + 1} in a chain — the continuation shown below as "original" is what intercession ${ancestry.length} produced.`));
    }

    const meter = el('div', 'intercede-compare-meter',
        `Textual overlap with the original continuation: ~${preservation}% (an overlap indicator, not a quality score)`);
    content.appendChild(meter);

    const insertionBlock = el('div', 'intercede-compare-section');
    insertionBlock.appendChild(el('div', 'intercede-compare-heading', 'Your inserted response'));
    insertionBlock.appendChild(el('div', 'intercede-compare-text intercede-compare-insertion', String(vaultRecord.insertion ?? '')));
    content.appendChild(insertionBlock);

    const originalBlock = el('div', 'intercede-compare-section');
    originalBlock.appendChild(el('div', 'intercede-compare-heading', 'Original continuation (discarded, non-canonical)'));
    originalBlock.appendChild(el('div', 'intercede-compare-text intercede-compare-original', original));
    content.appendChild(originalBlock);

    const revisedBlock = el('div', 'intercede-compare-section');
    revisedBlock.appendChild(el('div', 'intercede-compare-heading', 'Revised continuation (canonical)'));
    revisedBlock.appendChild(el('div', 'intercede-compare-text intercede-compare-revised', revised));
    content.appendChild(revisedBlock);

    await showModal({
        title: 'Intercede — comparison',
        content,
        buttons: [{ label: 'Close', value: null, primary: true }],
    });
}
