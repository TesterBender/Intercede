/**
 * Per-message actions (§8.1): an unobtrusive "Intercede" button on the eligible
 * (latest completed assistant) message, plus Undo / Compare buttons on the tail
 * of a committed intercession. Injected into the message template so every
 * rendered message carries them; visibility is toggled by eligibility.
 */

import { getCtx, getEventSource, getEventTypes, getSettings } from '../stcontext.js';
import { getCommittedTipRecord, isEligibleTarget, undoIntercession } from '../transaction.js';
import { debounce, notify } from '../utils.js';
import { showCompare } from './compare.js';
import { showConfirm } from './modal.js';
import { openIntercede } from './overlay.js';

const BUTTONS_HTML = `
    <div title="Intercede — respond inside this message (Alt+I)" class="mes_button mes_intercede fa-solid fa-reply interactable" tabindex="0"></div>
    <div title="Intercede — undo this intercession" class="mes_button mes_intercede_undo fa-solid fa-rotate-left interactable" tabindex="0"></div>
    <div title="Intercede — compare original and revised continuation" class="mes_button mes_intercede_compare fa-solid fa-code-compare interactable" tabindex="0"></div>
`;

function mesIndexFromNode(node) {
    const mes = node.closest('.mes');
    if (!mes) return null;
    const id = Number(mes.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
}

export function refreshButtonVisibility() {
    const ctx = getCtx();
    const settings = getSettings(ctx);
    document.querySelectorAll('#chat .mes.intercede-eligible').forEach(node => node.classList.remove('intercede-eligible'));
    document.querySelectorAll('#chat .mes.intercede-committed').forEach(node => node.classList.remove('intercede-committed'));
    if (!settings.enabled || !settings.showButton) return;

    const eligible = isEligibleTarget(ctx);
    if (eligible.ok) {
        document.querySelector(`#chat .mes[mesid="${eligible.targetIndex}"]`)?.classList.add('intercede-eligible');
    }
    const record = getCommittedTipRecord(ctx);
    if (record && Array.isArray(ctx?.chat)) {
        document.querySelector(`#chat .mes[mesid="${ctx.chat.length - 1}"]`)?.classList.add('intercede-committed');
    }
}

export const refreshButtonVisibilityDebounced = debounce(refreshButtonVisibility, 250);

async function onUndoClick() {
    const confirmed = await showConfirm(
        'Undo intercession?',
        'The original assistant message (text, swipes, and metadata) will be restored exactly, and your inserted response and the revised continuation will be removed.',
        { confirmLabel: 'Undo', cancelLabel: 'Keep' },
    );
    if (!confirmed) return;
    const result = await undoIntercession();
    if (!result.ok) notify('warning', result.reason);
    refreshButtonVisibility();
}

export function initMessageButtons() {
    // Inject into the message template so every future message carries the buttons.
    const template = document.querySelector('#message_template .mes_buttons .extraMesButtons');
    if (template) {
        template.insertAdjacentHTML('afterbegin', BUTTONS_HTML);
    }
    // And into already-rendered messages.
    document.querySelectorAll('#chat .mes .mes_buttons .extraMesButtons').forEach(node => {
        if (!node.querySelector('.mes_intercede')) node.insertAdjacentHTML('afterbegin', BUTTONS_HTML);
    });

    const chat = document.getElementById('chat');
    chat?.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.classList.contains('mes_intercede')) {
            openIntercede(mesIndexFromNode(target) ?? undefined);
        } else if (target.classList.contains('mes_intercede_undo')) {
            onUndoClick();
        } else if (target.classList.contains('mes_intercede_compare')) {
            showCompare();
        }
    });

    // Alt+I opens intercession mode on the latest eligible message (§24).
    document.addEventListener('keydown', (event) => {
        if (!event.altKey || event.code !== 'KeyI' || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        openIntercede();
    });

    // Keep visibility in sync with chat life-cycle events.
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    const refreshEvents = [
        eventTypes.CHAT_CHANGED,
        eventTypes.CHARACTER_MESSAGE_RENDERED,
        eventTypes.USER_MESSAGE_RENDERED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_EDITED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.GENERATION_ENDED,
        eventTypes.GENERATION_STOPPED,
        eventTypes.MORE_MESSAGES_LOADED,
    ].filter(Boolean);
    for (const name of refreshEvents) {
        eventSource?.on(name, refreshButtonVisibilityDebounced);
    }

    refreshButtonVisibility();
}
