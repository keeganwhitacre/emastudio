"use strict";

// ---------------------------------------------------------------------------
// EMA Studio — StorageManager
// v1.4.0
//
// Changes from v1.3:
//   - mergeState now checks schema_version on loaded data. If the saved
//     backup is older than the current runtime, we log the migration at
//     the console and still apply it (the merge is forward-compatible by
//     design). If the saved backup is NEWER, we refuse to load and warn
//     the user — blindly loading a newer schema can corrupt data.
//   - New v1.4 study fields (completion_lock, resume_enabled) get
//     default values on load if the backup predates them.
// ---------------------------------------------------------------------------

const StorageManager = {
    STORAGE_KEY: 'ema_studio_project_v1',
    _saveTimer: null,

    init() {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                this.mergeState(parsed);
            } catch (e) {
                console.warn('EMA Studio: could not parse saved state, using defaults.', e);
            }
        }

        const saveBtn   = document.getElementById('btn-save-project');
        const importBtn = document.getElementById('btn-import');
        const importIn  = document.getElementById('import-file');
        const resetBtn  = document.getElementById('btn-reset');

        if (saveBtn)   saveBtn.addEventListener('click', () => this.saveProject());
        if (importBtn) importBtn.addEventListener('click', () => importIn && importIn.click());
        if (importIn)  importIn.addEventListener('change', e => this.importProject(e));
        if (resetBtn)  resetBtn.addEventListener('click', () => this.resetProject());
    },

    // -----------------------------------------------------------------------
    // Schema version compare — returns -1 / 0 / 1 like strcmp for "a.b.c"
    // -----------------------------------------------------------------------
    _compareVersions(a, b) {
        const pa = (a || '0.0.0').split('.').map(n => parseInt(n) || 0);
        const pb = (b || '0.0.0').split('.').map(n => parseInt(n) || 0);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) < (pb[i] || 0)) return -1;
            if ((pa[i] || 0) > (pb[i] || 0)) return  1;
        }
        return 0;
    },

    // -----------------------------------------------------------------------
    // mergeState — overlays saved data onto the live state object.
    // Handles schema migrations forward; refuses to load backups from the future.
    // -----------------------------------------------------------------------
    mergeState(saved) {
        const savedVer = saved.schema_version || saved._schema_version || '1.0.0';
        const cmp = this._compareVersions(savedVer, SCHEMA_VERSION);

        if (cmp > 0) {
            console.warn(`EMA Studio: saved project is schema v${savedVer}, runtime is v${SCHEMA_VERSION}. Refusing to load to avoid data corruption. Export a backup from the newer builder version, or reset this project.`);
            const status = document.getElementById('save-status');
            if (status) { status.textContent = 'Incompatible backup'; status.style.color = 'var(--accent-red)'; }
            return;
        }

        if (cmp < 0) {
            console.info(`EMA Studio: migrating project from schema v${savedVer} to v${SCHEMA_VERSION}.`);
        }

        ['study', 'onboarding', 'ema'].forEach(key => {
            if (saved[key] !== undefined) state[key] = saved[key];
        });

        // Modules: merge by id so new modules defined in state.js appear even
        // in projects saved before they existed.
        if (Array.isArray(saved.modules)) {
            saved.modules.forEach(savedMod => {
                const live = state.modules.find(m => m.id === savedMod.id);
                if (live) {
                    live.enabled  = savedMod.enabled;
                    live.settings = Object.assign({}, live.settings, savedMod.settings);
                }
            });
        }

        // Legacy (pre-1.2) compat: state.pat → state.modules.epat
        if (saved.pat && !Array.isArray(saved.modules)) {
            const epatMod = state.modules.find(m => m.id === 'epat');
            if (epatMod) {
                epatMod.enabled  = saved.pat.enabled || false;
                epatMod.settings = Object.assign({}, epatMod.settings, {
                    trials:              saved.pat.trials,
                    trial_duration_sec:  saved.pat.trial_duration_sec,
                    retry_budget:        saved.pat.retry_budget,
                    sqi_threshold:       saved.pat.sqi_threshold,
                    confidence_ratings:  saved.pat.confidence_ratings,
                    two_phase_practice:  saved.pat.two_phase_practice,
                    body_map:            saved.pat.body_map
                });
            }
        }

        // v1.4 field defaults — fill in if missing
        if (state.study.completion_lock === undefined) state.study.completion_lock = true;
        if (state.study.resume_enabled  === undefined) state.study.resume_enabled  = true;
    },

    debouncedSave() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveLocalState(), 800);
    },

    saveLocalState() {
        try {
            // Stamp the schema version into the saved state so future loads
            // can version-check.
            const toSave = Object.assign({}, state, { schema_version: SCHEMA_VERSION });
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(toSave));
            const status = document.getElementById('save-status');
            if (status) { status.textContent = 'Up to date'; status.style.color = ''; }
        } catch (e) {
            console.warn('EMA Studio: localStorage save failed.', e);
        }
    },

    saveProject() {
        if (typeof state === 'undefined') return;
        const toSave = Object.assign({}, state, { schema_version: SCHEMA_VERSION });
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(toSave, null, 2));
        const a = document.createElement('a');
        a.setAttribute("href", dataStr);
        a.setAttribute("download", "ema_project_backup.json");
        document.body.appendChild(a);
        a.click();
        a.remove();
    },

    importProject(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const imported = JSON.parse(e.target.result);
                this.mergeState(imported);
                this.saveLocalState();
                this.triggerUIRefresh();
                const status = document.getElementById('save-status');
                if (status) status.textContent = 'Project imported';
            } catch (err) {
                alert("Error parsing JSON file. Please ensure it is a valid EMA Studio backup.");
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    },

    resetProject() {
        if (confirm("Are you sure you want to completely restart? All unsaved progress will be lost.")) {
            localStorage.removeItem(this.STORAGE_KEY);
            location.reload();
        }
    },

    triggerUIRefresh() {
        const el = id => document.getElementById(id);

        // 1. Study Tab
        if (el('study-name'))    el('study-name').value = state.study.name || '';
        if (el('institution'))   el('institution').value = state.study.institution || '';
        if (el('accent-color')) {
            el('accent-color').value = state.study.accent_color || '#e8716a';
            const sw = el('color-preview-swatch');
            if (sw) sw.style.background = state.study.accent_color || '#e8716a';
        }
        if (el('study-theme'))   el('study-theme').value = state.study.theme || 'oled';
        document.querySelectorAll('#format-ctrl .seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.fmt === state.study.output_format);
        });

        // v1.4 study-level flags
        if (el('study-completion-lock')) el('study-completion-lock').checked = !!state.study.completion_lock;
        if (el('study-resume-enabled'))  el('study-resume-enabled').checked  = !!state.study.resume_enabled;

        // 2. Onboarding tab
        if (el('ob-toggle'))        el('ob-toggle').checked = !!state.onboarding.enabled;
        if (el('ob-schedule-toggle')) el('ob-schedule-toggle').checked = state.onboarding.ask_schedule !== false;
        if (el('ob-consent-text'))  el('ob-consent-text').value = state.onboarding.consent_text || '';

        // 3. Schedule tab numeric fields
        if (el('study-days'))      el('study-days').value    = state.ema.scheduling.study_days || 14;
        if (el('daily-prompts'))   el('daily-prompts').value = state.ema.scheduling.daily_prompts || 3;
        if (el('window-expiry'))   el('window-expiry').value = state.ema.scheduling.timing?.expiry_minutes || 60;
        if (el('grace-period'))    el('grace-period').value  = state.ema.scheduling.timing?.grace_minutes  || 10;
        document.querySelectorAll('#dow-grid .dow-chip').forEach(chip => {
            const dow = parseInt(chip.dataset.dow);
            chip.classList.toggle('on', (state.ema.scheduling.days_of_week || []).includes(dow));
        });

        // 4. Re-render panels
        if (typeof renderWindows      === 'function') renderWindows();
        if (typeof renderQuestions    === 'function') renderQuestions();
        if (typeof renderGreetings    === 'function') renderGreetings();
        if (typeof renderModules      === 'function') renderModules();
        if (typeof renderPreviewTabs  === 'function') renderPreviewTabs();
        if (typeof schedulePreview    === 'function') schedulePreview();
    }
};

// Kick off storage initialization at page load — exposed as a one-liner so
// builder.html can choose ordering.
document.addEventListener('DOMContentLoaded', () => StorageManager.init());