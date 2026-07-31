/**
 * Minimal self-contained modal/confirm dialogs.
 * @see docs/RATIONALE.md#UI-07 why this does not use SillyTavern's popup API
 */

import { el } from '../utils.js';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {HTMLElement | string} options.content element, or plain text (escaped)
 * @param {{ label: string, value: any, primary?: boolean }[]} options.buttons
 * @param {any} [options.dismissValue] resolved value for Escape / backdrop click (default null)
 * @returns {Promise<any>} the chosen button's value
 */
export function showModal({ title, content, buttons, dismissValue = null }) {
    return new Promise(resolve => {
        const backdrop = el('div', 'intercede-backdrop intercede-modal-backdrop');
        const panel = el('div', 'intercede-panel intercede-modal');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');

        const header = el('div', 'intercede-modal-title', title);
        const body = el('div', 'intercede-modal-body');
        if (typeof content === 'string') {
            body.textContent = content;
        } else if (content) {
            body.appendChild(content);
        }

        const footer = el('div', 'intercede-modal-buttons');
        const close = (value) => {
            document.removeEventListener('keydown', onKeydown, true);
            backdrop.remove();
            resolve(value);
        };
        for (const button of buttons) {
            const node = el('button', 'menu_button' + (button.primary ? ' intercede-primary' : ''), button.label);
            node.type = 'button';
            node.addEventListener('click', () => close(button.value));
            footer.appendChild(node);
        }

        const onKeydown = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                event.preventDefault();
                close(dismissValue);
            }
        };
        document.addEventListener('keydown', onKeydown, true);
        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop) close(dismissValue);
        });

        panel.append(header, body, footer);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        footer.querySelector('.intercede-primary')?.focus();
    });
}

/**
 * @returns {Promise<boolean>}
 */
export function showConfirm(title, content, { confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
    return showModal({
        title,
        content,
        dismissValue: false,
        buttons: [
            { label: confirmLabel, value: true, primary: true },
            { label: cancelLabel, value: false },
        ],
    });
}
