/**
 * Settings drawer (§23), rendered into the Extensions panel.
 * @see docs/RATIONALE.md#UI-13 the sectioning, and why no `id` here may move
 */

import { DEFAULT_SETTINGS, PROMPT_PRESETS, REWRITE_MODES } from '../constants.js';
import { resolvePromptConfig } from '../prompt-config.js';
import { BUILT_IN_PRESETS, DEFAULT_PRESET, getPreset } from '../prompt-presets.js';
import { buildRewritePrompt } from '../prompt.js';
import { getCtx, getSettings, saveSettings } from '../stcontext.js';
import { cleanupSnapshots } from '../transaction.js';
import { debounce, notify } from '../utils.js';
import { vaultKeys } from '../vault.js';
import { refreshButtonVisibility } from './message-button.js';

/** Mode → its textarea id and settings key. @see docs/RATIONALE.md#CFG-04 */
const PROMPT_MODE_FIELDS = [
    [REWRITE_MODES.PRESERVE, 'intercede_prompt_mode_preserve', 'promptModePreserve'],
    [REWRITE_MODES.ADAPTIVE, 'intercede_prompt_mode_adaptive', 'promptModeAdaptive'],
    [REWRITE_MODES.REIMAGINE, 'intercede_prompt_mode_reimagine', 'promptModeReimagine'],
];

/** Stand-in for the set-aside continuation, so the preview reads like a real prompt. */
const PREVIEW_SAMPLE = 'She turned back toward the door, one hand still resting on the frame.';

const FALLBACK_NOTICE = {
    empty: 'Your template is empty, so the default instruction is being used.',
    'missing-suffix': 'Your template has no {{suffix}} marker — the set-aside continuation would be dropped entirely, so the default instruction is being used instead.',
};

const PANEL_HTML = `
<div class="intercede-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Intercede</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="intercede-settings-section">
                <div class="intercede-settings-heading">Behaviour</div>
                <label class="checkbox_label" for="intercede_enabled">
                    <input type="checkbox" id="intercede_enabled">
                    <span>Enabled</span>
                </label>
                <label class="checkbox_label" for="intercede_show_button">
                    <input type="checkbox" id="intercede_show_button">
                    <span>Show Intercede button on the eligible message</span>
                </label>
                <label for="intercede_interface">Selection interface</label>
                <select id="intercede_interface" class="text_pole">
                    <option value="inline">In place, on the message (glowing markers)</option>
                    <option value="window">Floating window</option>
                </select>
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
                <small class="intercede-settings-note">
                    Intercede works on the latest completed assistant message.
                </small>
            </div>
            <div class="intercede-settings-section">
                <div class="intercede-settings-heading">Prompt</div>
                <label for="intercede_prompt_preset">Rewrite instruction</label>
                <select id="intercede_prompt_preset" class="text_pole"></select>
                <div id="intercede_prompt_custom" class="intercede-prompt-custom">
                    <label for="intercede_prompt_template">Your template</label>
                    <textarea id="intercede_prompt_template" class="text_pole intercede-prompt-area" rows="12"
                        spellcheck="false"></textarea>
                    <small class="intercede-settings-note">
                        <code>{{suffix}}</code> marks where the set-aside continuation goes and is required.
                        <code>{{mode}}</code> marks where the wording below goes; leave it out and it is added
                        at the end. Empty falls back to the default.
                    </small>
                </div>
                <label for="intercede_prompt_mode_preserve">Wording — preserve closely</label>
                <textarea id="intercede_prompt_mode_preserve" class="text_pole intercede-prompt-area" rows="2"
                    spellcheck="false"></textarea>
                <label for="intercede_prompt_mode_adaptive">Wording — adapt naturally</label>
                <textarea id="intercede_prompt_mode_adaptive" class="text_pole intercede-prompt-area" rows="2"
                    spellcheck="false"></textarea>
                <label for="intercede_prompt_mode_reimagine">Wording — reimagine remainder</label>
                <textarea id="intercede_prompt_mode_reimagine" class="text_pole intercede-prompt-area" rows="2"
                    spellcheck="false"></textarea>
                <small class="intercede-settings-note">
                    An empty box uses the wording shown greyed inside it. Keep any edits phrased as scene or
                    story direction — wording that reads as instructions about reusing a model's earlier output
                    is rejected outright by some backends' filters.
                </small>
                <details class="intercede-prompt-preview-wrap">
                    <summary>Preview the assembled instruction</summary>
                    <div id="intercede_prompt_warning" class="intercede-prompt-warning" hidden></div>
                    <pre id="intercede_prompt_preview" class="intercede-prompt-preview"></pre>
                </details>
                <div class="intercede-settings-actions">
                    <button type="button" id="intercede_prompt_reset" class="menu_button">Reset prompt to default</button>
                </div>
            </div>
            <div class="intercede-settings-section">
                <div class="intercede-settings-heading">Safety</div>
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
            </div>
            <div class="intercede-settings-section">
                <div class="intercede-settings-heading">Undo snapshots</div>
                <div class="intercede-settings-row">
                    <label for="intercede_snapshot_ttl">Delete unused after</label>
                    <input type="number" id="intercede_snapshot_ttl" class="text_pole" min="0" max="3650" step="1">
                    <span>days</span>
                </div>
                <small class="intercede-settings-note">
                    0 keeps them forever. Snapshots are stored locally in this browser and do not travel
                    with exported chat files. Cleanup never removes the snapshot behind an intercession
                    that can still be undone — use <code>/intercede finalize</code> to discard that one
                    deliberately.
                </small>
                <div class="intercede-settings-actions">
                    <button type="button" id="intercede_cleanup_now" class="menu_button">Clean up now</button>
                </div>
            </div>
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
    const bindSelect = (id, key, onChange) => {
        const select = byId(id);
        select.value = String(settings[key]);
        select.addEventListener('change', () => {
            getSettings()[key] = select.value;
            saveSettings();
            onChange?.();
        });
    };

    /** Debounced on `input` so a long template is not saved per keystroke; `change` commits at once. */
    const bindTextarea = (id, key, onChange) => {
        const area = byId(id);
        area.value = String(settings[key] ?? '');
        const commit = () => {
            getSettings()[key] = area.value;
            saveSettings();
            onChange?.();
        };
        area.addEventListener('input', debounce(commit, 300));
        area.addEventListener('change', commit);
    };

    bindCheckbox('intercede_enabled', 'enabled', refreshButtonVisibility);
    bindCheckbox('intercede_show_button', 'showButton', refreshButtonVisibility);
    bindCheckbox('intercede_confirm', 'confirmBeforeCommit');
    bindCheckbox('intercede_compare_after', 'compareAfterCommit');
    bindCheckbox('intercede_warn_extensions', 'warnExtensions');
    bindSelect('intercede_interface', 'selectionInterface');
    bindSelect('intercede_boundaries', 'boundaries');
    bindSelect('intercede_default_mode', 'defaultMode');

    if (byId('intercede_default_mode').value === '') {
        byId('intercede_default_mode').value = REWRITE_MODES.ADAPTIVE;
    }

    initPromptControls({ byId, bindSelect, bindTextarea });

    const ttl = byId('intercede_snapshot_ttl');
    ttl.value = String(settings.snapshotTtlDays ?? 0);
    ttl.addEventListener('change', () => {
        const value = Math.max(0, Number(ttl.value) || 0);
        ttl.value = String(value);
        getSettings().snapshotTtlDays = value;
        saveSettings();
    });

    byId('intercede_cleanup_now').addEventListener('click', async () => {
        const ctx = getCtx();
        const days = getSettings(ctx).snapshotTtlDays;
        const result = await cleanupSnapshots(days, ctx);
        if (!result.ok) {
            notify('warning', result.reason);
            return;
        }
        const remaining = (await vaultKeys()).length;
        notify('info', days > 0
            ? `Removed ${result.removed} snapshot(s) older than ${days} day(s); ${remaining} remain.`
            : `Snapshot age limit is 0 (keep forever); ${remaining} snapshot(s) stored.`);
    });
}

/**
 * The Prompt section. Options are appended before `bindSelect` reads the stored value.
 * @see docs/RATIONALE.md#UI-13 why that order is load-bearing
 */
function initPromptControls({ byId, bindSelect, bindTextarea }) {
    const select = byId('intercede_prompt_preset');
    for (const preset of Object.values(BUILT_IN_PRESETS)) {
        select.append(promptOption(preset.id, preset.label));
    }
    select.append(promptOption(PROMPT_PRESETS.CUSTOM, 'Custom…'));

    const refresh = () => refreshPromptView(byId);

    bindSelect('intercede_prompt_preset', 'promptPreset', refresh);
    bindTextarea('intercede_prompt_template', 'promptTemplate', refresh);
    for (const [, id, key] of PROMPT_MODE_FIELDS) {
        bindTextarea(id, key, refresh);
    }

    byId('intercede_prompt_reset').addEventListener('click', () => {
        const settings = getSettings();
        settings.promptPreset = DEFAULT_SETTINGS.promptPreset;
        settings.promptTemplate = '';
        for (const [, , key] of PROMPT_MODE_FIELDS) settings[key] = '';
        saveSettings();

        byId('intercede_prompt_preset').value = settings.promptPreset;
        byId('intercede_prompt_template').value = '';
        for (const [, id] of PROMPT_MODE_FIELDS) byId(id).value = '';
        refresh();
        notify('info', 'Prompt reset to the default instruction.');
    });

    refresh();
}

function promptOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
}

/**
 * Re-render everything downstream of the prompt fields.
 * @see docs/RATIONALE.md#CFG-04 why resolved text is a `placeholder`, never a `value`
 */
function refreshPromptView(byId) {
    const settings = getSettings();
    const config = resolvePromptConfig(settings);
    const preset = getPreset(config.presetId);

    byId('intercede_prompt_custom').hidden = settings.promptPreset !== PROMPT_PRESETS.CUSTOM;
    byId('intercede_prompt_template').placeholder = DEFAULT_PRESET.template;
    for (const [mode, id] of PROMPT_MODE_FIELDS) {
        byId(id).placeholder = preset.addenda[mode] ?? '';
    }

    const warning = byId('intercede_prompt_warning');
    const notice = FALLBACK_NOTICE[config.fallback];
    warning.textContent = notice ?? '';
    warning.hidden = !notice;

    // Makes a mistyped placeholder visible before a generation spends it.
    byId('intercede_prompt_preview').textContent = buildRewritePrompt({
        suffix: PREVIEW_SAMPLE,
        mode: settings.defaultMode,
        ...config,
    });
}
