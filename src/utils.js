/**
 * Small dependency-free helpers.
 */

/** FNV-1a 32-bit hash, returned as a fixed-width hex string. */
export function hashText(text) {
    let hash = 0x811c9dc5;
    const str = String(text ?? '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

export function uuid() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * DOM element helper.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text] textContent (always escaped by the DOM)
 */
export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll until predicate() is truthy or the timeout elapses. Resolves to the predicate result. */
export async function waitUntil(predicate, timeoutMs = 5000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = predicate();
        if (result) return result;
        if (Date.now() >= deadline) return result;
        await delay(intervalMs);
    }
}

export function debounce(fn, ms = 250) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

/** Collapse all whitespace runs to single spaces and lowercase — for fuzzy overlap comparisons. */
export function normalizeForComparison(text) {
    return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Truncate for display, keeping whole characters and adding an ellipsis. */
export function truncate(text, max = 120) {
    const str = String(text ?? '');
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

const TOAST_TITLE = 'Intercede';

export function notify(kind, message, options = {}) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[kind] === 'function') {
        toastr[kind](message, TOAST_TITLE, { timeOut: kind === 'error' ? 10000 : 5000, ...options });
    } else {
        console[kind === 'error' ? 'error' : 'log'](`[${TOAST_TITLE}] ${message}`);
    }
}
