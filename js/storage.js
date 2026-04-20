"use strict";

// ---------------------------------------------------------------------------
// EMA Studio — StorageManager
// v1.3.0
//
// Changes from v1.2:
//   - No more monkey-patching of window.schedulePreview. Instead, StorageManager
//     exposes a debouncedSave() method that preview.js calls directly. This
//     removes the load-order fragility where auto-save silently broke if
//     storage.js loaded before preview.js.
//   - triggerUIRefresh calls renderModules() if present (no hardcoded IDs).
//   - Legacy `state.pat` migration retained — useful for anyone upgrading from
//     a pre-1.2 project backup.
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

        // Wire top-bar buttons
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
    // mergeState — overlays saved data onto the live state object.
    // -----------------------------------------------------------------------
    mergeState(saved) {
        ['study', 'onboarding', 'ema'].forEach(key => {
            if (saved[key] !== undefined) state[key] = saved[key];
        });

        // modules: merge by id so new modules defined in state.js appear even
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
    },

    // -----------------------------------------------------------------------
    // debouncedSave — called by preview.js/schedulePreview(). The 800ms
    // debounce piggybacks on the preview debounce (600ms) so we save shortly
    // after the preview updates without running a second timer in parallel.
    // -----------------------------------------------------------------------
    debouncedSave() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.saveLocalState(), 800);
    },

    saveLocalState() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
            const status = document.getElementById('save-status');
            if (status) status.textContent = 'Up to date';
        } catch (e) {
            console.warn('EMA Studio: localStorage save failed.', e);
        }
    },

    saveProject() {
        if (typeof state === 'undefined') return;
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
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

    // -----------------------------------------------------------------------
    // triggerUIRefresh — re-syncs every tab's DOM with the current state.
    // -----------------------------------------------------------------------
    triggerUIRefresh() {
        // 1. Study Tab
        const el = id => document.getElementById(id);
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

        // 2. Onboarding Tab
        if (el('ob-toggle')) {
            el('ob-toggle').checked = state.onboarding.enabled;
            const settings = el('ob-settings');
            if (settings) settings.style.display = state.onboarding.enabled ? 'block' : 'none';
        }
        if (el('ob-schedule-toggle')) el('ob-schedule-toggle').checked = state.onboarding.ask_schedule !== false;
        if (el('ob-consent-text'))    el('ob-consent-text').value = state.onboarding.consent_text;

        // 3. Schedule Tab
        if (el('study-days'))    el('study-days').value = state.ema.scheduling.study_days;
        if (el('daily-prompts')) el('daily-prompts').value = state.ema.scheduling.daily_prompts;
        if (el('window-expiry')) el('window-expiry').value = state.ema.scheduling.timing.expiry_minutes;
        if (el('grace-period'))  el('grace-period').value = state.ema.scheduling.timing.grace_minutes;
        document.querySelectorAll('.dow-chip').forEach(chip => {
            chip.classList.toggle('on', state.ema.scheduling.days_of_week.includes(parseInt(chip.dataset.dow)));
        });
        if (typeof renderWindows === 'function') renderWindows();

        // 4. Tasks Tab (dynamic)
        if (typeof renderModules === 'function') renderModules();

        // 5. Questions Tab + Preview + Greetings
        if (typeof renderGreetings === 'function') renderGreetings();
        if (typeof renderQuestions === 'function') renderQuestions();
        if (typeof schedulePreview === 'function') schedulePreview();
    }
};

// Initialize immediately so state is loaded BEFORE the inline script in builder.html triggers renders
StorageManager.init();