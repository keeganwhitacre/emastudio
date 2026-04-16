/**
 * EMA Studio - Project Storage & Management
 * Handles Auto-saving, Importing, Exporting, and Resetting the studio state.
 */

const StorageManager = {
    STORAGE_KEY: 'ema_studio_project_state',

    init() {
        this.bindUI();
        this.loadLocalState();
        
        // Auto-save every 2 seconds by checking if the state object changed
        setInterval(() => this.saveLocalState(), 2000);
    },

    bindUI() {
        const btnSave = document.getElementById('btn-save-project');
        const btnImport = document.getElementById('btn-import');
        const fileInput = document.getElementById('import-file');
        const btnReset = document.getElementById('btn-reset');

        if (btnSave) btnSave.addEventListener('click', () => this.exportProject());
        if (btnImport) btnImport.addEventListener('click', () => fileInput.click());
        if (fileInput) fileInput.addEventListener('change', (e) => this.importProject(e));
        if (btnReset) btnReset.addEventListener('click', () => this.resetProject());
    },

    saveLocalState() {
        if (typeof state === 'undefined') return;
        
        const currentStateStr = JSON.stringify(state);
        const savedStateStr = localStorage.getItem(this.STORAGE_KEY);
        
        if (currentStateStr !== savedStateStr) {
            localStorage.setItem(this.STORAGE_KEY, currentStateStr);
            const status = document.getElementById('save-status');
            if (status) {
                const d = new Date();
                status.textContent = `Auto-saved ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
            }
        }
    },

    loadLocalState() {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (saved) {
            try {
                const parsedState = JSON.parse(saved);
                // Silently restore state on load
                state = parsedState;
                this.triggerUIRefresh();
                
                const status = document.getElementById('save-status');
                if (status) status.textContent = "Restored previous session";
            } catch (e) {
                console.error("Failed to parse saved state", e);
            }
        }
    },

    exportProject() {
        if (typeof state === 'undefined') return;
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "ema_project_backup.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    },

    importProject(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importedState = JSON.parse(e.target.result);
                state = importedState;
                this.saveLocalState();
                this.triggerUIRefresh();
                
                const status = document.getElementById('save-status');
                if (status) status.textContent = "Project imported";
            } catch (error) {
                alert("Error parsing JSON file. Please ensure it is a valid EMA Studio backup.");
            }
        };
        reader.readAsText(file);
        event.target.value = ''; // Reset input
    },

    resetProject() {
        if (confirm("Are you sure you want to completely restart? All unsaved progress will be lost.")) {
            localStorage.removeItem(this.STORAGE_KEY);
            location.reload(); // Reloading the page will pull defaults from state.js
        }
    },

    triggerUIRefresh() {
        // Force all tabs to sync with the newly loaded 'state' variable
        
        // 1. Study Tab
        if (document.getElementById('study-name')) document.getElementById('study-name').value = state.study.name;
        if (document.getElementById('institution')) document.getElementById('institution').value = state.study.institution;
        if (document.getElementById('greeting-morning')) document.getElementById('greeting-morning').value = state.study.greetings.morning;
        if (document.getElementById('greeting-afternoon')) document.getElementById('greeting-afternoon').value = state.study.greetings.afternoon;
        if (document.getElementById('greeting-evening')) document.getElementById('greeting-evening').value = state.study.greetings.evening;
        if (document.getElementById('accent-color')) {
            document.getElementById('accent-color').value = state.study.accent_color;
            document.getElementById('color-preview-swatch').style.background = state.study.accent_color;
        }
        document.querySelectorAll('#format-ctrl .seg-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.fmt === state.study.output_format);
        });

        // 2. Schedule Tab
        if (document.getElementById('study-days')) document.getElementById('study-days').value = state.ema.scheduling.study_days;
        if (document.getElementById('daily-prompts')) document.getElementById('daily-prompts').value = state.ema.scheduling.daily_prompts;
        if (document.getElementById('window-expiry')) document.getElementById('window-expiry').value = state.ema.scheduling.timing.expiry_minutes;
        if (document.getElementById('grace-period')) document.getElementById('grace-period').value = state.ema.scheduling.timing.grace_minutes;
        
        document.querySelectorAll('.dow-chip').forEach(chip => {
            const dow = parseInt(chip.dataset.dow);
            chip.classList.toggle('on', state.ema.scheduling.days_of_week.includes(dow));
        });
        if (typeof renderWindows === 'function') renderWindows();

        // 3. Tasks Tab
        if (document.getElementById('pat-toggle')) {
            document.getElementById('pat-toggle').checked = state.pat.enabled;
            document.getElementById('pat-card').classList.toggle('enabled', state.pat.enabled);
            document.getElementById('pat-settings').classList.toggle('hidden', !state.pat.enabled);
        }
        if (document.getElementById('pat-trials')) document.getElementById('pat-trials').value = state.pat.trials;
        if (document.getElementById('pat-trial-dur')) document.getElementById('pat-trial-dur').value = state.pat.trial_duration_sec;
        if (document.getElementById('pat-retries')) document.getElementById('pat-retries').value = state.pat.retry_budget;
        if (document.getElementById('pat-sqi')) document.getElementById('pat-sqi').value = state.pat.sqi_threshold;
        if (document.getElementById('pat-conf')) document.getElementById('pat-conf').checked = state.pat.confidence_ratings;
        if (document.getElementById('pat-practice')) document.getElementById('pat-practice').checked = state.pat.two_phase_practice;

        // 4. Questions Tab & Preview
        if (typeof renderQuestions === 'function') renderQuestions();
        if (typeof schedulePreview === 'function') schedulePreview();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StorageManager.init();
});
