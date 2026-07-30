/**
 * Settings drawer (§23), rendered into the Extensions panel.
 */

import { REWRITE_MODES } from '../constants.js';
import { getCtx, getSettings, saveSettings } from '../stcontext.js';
import { notify } from '../utils.js';
import { cleanupVault, vaultKeys } from '../vault.js';
import { refreshButtonVisibility } from './message-button.js';

const PANEL_HTML = `
<div class="intercede-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Intercede</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="intercede_enabled">
                <input type="checkbox" id="intercede_enabled">
                <span>Enabled</span>
            </label>
            <label class="checkbox_label" for="intercede_show_button">
                <input type="checkbox" id="intercede_show_button">
                <span>Show Intercede button on the eligible message</span>
            </label>
            <label for="intercede_boundaries">Selection boundaries</label>
            <select id="intercede_boundaries" class="text_pole">
                <option value="paragraph">Paragraphs only</option>
                <option value="sentence">Paragraphs and sentences</option>
            </select>
            <label for="intercede_default_mode">Default rewrite mode</label>
            <select id="intercede_default_mode" class="text_pole">
                <option value="preserve">Preserve closely</option>
                <option value="adaptive">Adapt naturally</option>
                <option value="reimagine">Reimagine remainder</option>
            </select>
            <label class="checkbox_label" for="intercede_confirm">
                <input type="checkbox" id="intercede_confirm">
                <span>Show confirmation before mutating the chat</span>
            </label>
            <label class="checkbox_label" for="intercede_compare_after">
                <input type="checkbox" id="intercede_compare_after">
                <span>Show comparison after generation</span>
            </label>
            <label class="checkbox_label" for="intercede_warn_extensions">
                <input type="checkbox" id="intercede_warn_extensions">
                <span>Warn about continuation/memory extension conflicts</span>
            </label>
            <label for="intercede_snapshot_ttl">Delete undo snapshots after (days, 0 = keep forever)</label>
            <input type="number" id="intercede_snapshot_ttl" class="text_pole" min="0" max="3650" step="1">
            <div class="intercede-settings-actions">
                <button type="button" id="intercede_cleanup_now" class="menu_button">Clean up stored snapshots now</button>
            </div>
            <small class="intercede-settings-note">
                Intercede works on the latest completed assistant message. Snapshots for undo are stored
                locally in this browser and do not travel with exported chat files.
            </small>
        </div>
    </div>
</div>`;

export function initSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', PANEL_HTML);

    const settings = getSettings();
    const byId = (id) => document.getElementById(id);

    const bindCheckbox = (id, key, onChange) => {
        const input = byId(id);
        input.checked = Boolean(settings[key]);
        input.addEventListener('change', () => {
            getSettings()[key] = input.checked;
            saveSettings();
            onChange?.();
        });
    };
    const bindSelect = (id, key) => {
        const select = byId(id);
        select.value = String(settings[key]);
        select.addEventListener('change', () => {
            getSettings()[key] = select.value;
            saveSettings();
        });
    };

    bindCheckbox('intercede_enabled', 'enabled', refreshButtonVisibility);
    bindCheckbox('intercede_show_button', 'showButton', refreshButtonVisibility);
    bindCheckbox('intercede_confirm', 'confirmBeforeCommit');
    bindCheckbox('intercede_compare_after', 'compareAfterCommit');
    bindCheckbox('intercede_warn_extensions', 'warnExtensions');
    bindSelect('intercede_boundaries', 'boundaries');
    bindSelect('intercede_default_mode', 'defaultMode');

    if (byId('intercede_default_mode').value === '') {
        byId('intercede_default_mode').value = REWRITE_MODES.ADAPTIVE;
    }

    const ttl = byId('intercede_snapshot_ttl');
    ttl.value = String(settings.snapshotTtlDays ?? 30);
    ttl.addEventListener('change', () => {
        const value = Math.max(0, Number(ttl.value) || 0);
        ttl.value = String(value);
        getSettings().snapshotTtlDays = value;
        saveSettings();
    });

    byId('intercede_cleanup_now').addEventListener('click', async () => {
        const ctx = getCtx();
        const days = getSettings(ctx).snapshotTtlDays;
        const removed = days > 0 ? await cleanupVault(days) : 0;
        const remaining = (await vaultKeys()).length;
        notify('info', days > 0
            ? `Removed ${removed} snapshot(s) older than ${days} day(s); ${remaining} remain.`
            : `Snapshot age limit is 0 (keep forever); ${remaining} snapshot(s) stored.`);
    });
}
