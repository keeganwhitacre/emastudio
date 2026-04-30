"use strict";

// ---------------------------------------------------------------------------
// Tasks Tab
//
// Renders entirely from state.modules — no hardcoded module HTML.
// To add a new module, define its settings schema here in SETTINGS_RENDERERS
// and push its entry into state.modules in state.js. Nothing else needs
// touching in this file.
//
// Architecture:
//   bindTasksTab()     — called once on page load; renders initial cards
//   renderModules()    — tears down and rebuilds the module list from state
//   buildModuleCard()  — creates one card DOM element for a given module
//   SETTINGS_RENDERERS — map of module id → function that returns settings HTML
//                        and a bind function to wire events
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SETTINGS_RENDERERS
// Each entry: { html(mod) → htmlString, bind(card, mod) → void }
// html()  — returns the inner HTML for the settings panel
// bind()  — attaches event listeners after the card is inserted into the DOM
// ---------------------------------------------------------------------------
const SETTINGS_RENDERERS = {

  epat: {
    html(mod) {
      const s = mod.settings;
      return `
        <div class="field-row">
          <div class="field-group">
            <label class="field-label">Valid Trials Target</label>
            <input type="number" class="ms-trials" value="${s.trials}" min="5" max="40">
          </div>
          <div class="field-group">
            <label class="field-label">Trial Duration (s)</label>
            <input type="number" class="ms-trial-dur" value="${s.trial_duration_sec}" min="15" max="60">
          </div>
        </div>
        <div class="field-row">
          <div class="field-group">
            <label class="field-label">Retry Budget</label>
            <input type="number" class="ms-retries" value="${s.retry_budget}" min="20" max="60">
            <div class="field-hint">Max attempts covering SQI + trial quality failures.</div>
          </div>
          <div class="field-group">
            <label class="field-label">SQI Threshold</label>
            <input type="number" class="ms-sqi" value="${s.sqi_threshold}" min="0.1" max="1.0" step="0.05">
            <div class="field-hint">Perfusion index floor for trial acceptance.</div>
          </div>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Include Body Map Sensation Tracker</span>
          <label class="toggle">
            <input type="checkbox" class="ms-bodymap" ${s.body_map ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Per-trial confidence ratings</span>
          <label class="toggle">
            <input type="checkbox" class="ms-conf" ${s.confidence_ratings ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">Two-phase practice (tone-to-tone + tone-to-heartbeat)</span>
          <label class="toggle">
            <input type="checkbox" class="ms-practice" ${s.two_phase_practice ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
      `;
    },

    bind(card, mod) {
      const s = mod.settings;
      const num = (sel, key) => {
        const el = card.querySelector(sel);
        if (el) el.addEventListener('input', () => { s[key] = parseFloat(el.value) || 0; schedulePreview(); });
      };
      num('.ms-trials', 'trials');
      num('.ms-trial-dur', 'trial_duration_sec');
      num('.ms-retries', 'retry_budget');
      num('.ms-sqi', 'sqi_threshold');

      const chk = (sel, key) => {
        const el = card.querySelector(sel);
        if (el) el.addEventListener('change', () => { s[key] = el.checked; schedulePreview(); });
      };
      chk('.ms-bodymap', 'body_map');
      chk('.ms-conf', 'confidence_ratings');
      chk('.ms-practice', 'two_phase_practice');
    }
  },

  hct: {
    html(mod) {
      const s = mod.settings;
      // Render the intervals array as a comma-separated string for the
      // editable field. Researchers can paste e.g. "25, 35, 45, 50, 55, 100"
      // straight from a methods section.
      const intervalsStr = (s.intervals || []).join(', ');
      return `
<div class="field-row">
<div class="field-group" style="flex: 2;">
<label class="field-label">Counting Intervals (seconds)</label>
<input type="text" class="ms-hct-intervals" value="${intervalsStr}" placeholder="25, 35, 45">
<div class="field-hint">Comma-separated. Schandry's classic set: 25, 35, 45, 50, 55, 100.</div>
</div>
<div class="field-group">
<label class="field-label">Practice Duration (s)</label>
<input type="number" class="ms-hct-practice-dur" value="${s.practice_duration_sec}" min="5" max="60">
</div>
</div>
<div class="field-row">
<div class="field-group">
<label class="field-label">Retry Budget</label>
<input type="number" class="ms-hct-retries" value="${s.retry_budget}" min="0" max="30">
<div class="field-hint">Max silent retries for noise-failed intervals.</div>
</div>
<div class="field-group">
<label class="field-label">Body Map Every N Intervals</label>
<input type="number" class="ms-hct-bodymap-every" value="${s.body_map_every}" min="1" max="20">
<div class="field-hint">Only used if body map is enabled below.</div>
</div>
</div>
    <div class="field-row">
      <div class="field-group" style="flex:2;">
        <label class="field-label">Instruction Variant</label>
        <select class="ms-hct-variant" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;">
          <option value="count" ${s.instruction_variant === 'count' ? 'selected' : ''}>Count perceived heartbeats (Schandry)</option>
          <option value="estimate" ${s.instruction_variant === 'estimate' ? 'selected' : ''}>Estimate heartbeats (Brener/Ring)</option>
        </select>
        <div class="field-hint">Methodologically non-equivalent — see Desmedt et al. (2018).</div>
      </div>
      <div class="field-group">
        <label class="field-label">Counting Screen</label>
        <select class="ms-hct-display" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;">
          <option value="blank">Minimal (blank)</option>
          <option value="ring">Subtle progress ring</option>
          <option value="timer">Elapsed timer</option>
          <option value="both">Ring + timer</option>
        </select>
        <div class="field-hint">What participants see during counting.</div>
      </div>
    </div>

    <div class="field-group">
      <label class="field-label">Custom Instructions <span style="color:var(--fg-muted); font-weight:400;">(optional, overrides variant default)</span></label>
      <textarea class="ms-hct-instructions" rows="3"
        style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;resize:vertical;"
        placeholder="Leave blank to use the standard wording for the selected variant.">${escH(s.instructions || '')}</textarea>
      <div class="field-hint">Wording matters — different labs run different instruction sets. Keep blank to use the validated defaults.</div>
    </div>

    <div class="toggle-row">
      <span class="toggle-label">Randomize interval order</span>
      <label class="toggle">
        <input type="checkbox" class="ms-hct-randomize" ${s.randomize_order ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Include practice interval</span>
      <label class="toggle">
        <input type="checkbox" class="ms-hct-practice" ${s.include_practice ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Per-interval confidence ratings</span>
      <label class="toggle">
        <input type="checkbox" class="ms-hct-conf" ${s.confidence_ratings ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Include Body Map Sensation Tracker</span>
      <label class="toggle">
        <input type="checkbox" class="ms-hct-bodymap" ${s.body_map ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
  `;
    },

    bind(card, mod) {
      const s = mod.settings;

      // Intervals: parse comma-separated string into a number array on the fly.
      // Tolerates trailing commas, whitespace, and non-numeric tokens (which
      // are silently dropped). Empty parses to [] which the runtime treats as
      // a config error and falls back to the default set.
      const intervalsEl = card.querySelector('.ms-hct-intervals');
      if (intervalsEl) {
        intervalsEl.addEventListener('input', () => {
          s.intervals = intervalsEl.value
            .split(',')
            .map(t => parseFloat(t.trim()))
            .filter(n => Number.isFinite(n) && n >= 5 && n <= 300);
          schedulePreview();
        });
      }

      const num = (sel, key) => {
        const el = card.querySelector(sel);
        if (el) el.addEventListener('input', () => { s[key] = parseFloat(el.value) || 0; schedulePreview(); });
      };
      num('.ms-hct-practice-dur', 'practice_duration_sec');
      num('.ms-hct-retries', 'retry_budget');
      num('.ms-hct-bodymap-every', 'body_map_every');

      const chk = (sel, key) => {
        const el = card.querySelector(sel);
        if (el) el.addEventListener('change', () => { s[key] = el.checked; schedulePreview(); });
      };
      chk('.ms-hct-randomize', 'randomize_order');
      chk('.ms-hct-practice', 'include_practice');
      chk('.ms-hct-conf', 'confidence_ratings');
      chk('.ms-hct-bodymap', 'body_map');

      const variantEl = card.querySelector('.ms-hct-variant');
      if (variantEl) variantEl.addEventListener('change', () => { s.instruction_variant = variantEl.value; schedulePreview(); });

      const instrEl = card.querySelector('.ms-hct-instructions');
      if (instrEl) instrEl.addEventListener('input', () => { s.instructions = instrEl.value; schedulePreview(); });

      // Counting-screen display dropdown maps to two booleans for cleaner
      // runtime checks. We initialize the dropdown to match current state.
      const displayEl = card.querySelector('.ms-hct-display');
      if (displayEl) {
        const current = s.show_timer && s.show_progress_ring ? 'both'
          : s.show_timer ? 'timer'
            : s.show_progress_ring ? 'ring'
              : 'blank';
        displayEl.value = current;
        displayEl.addEventListener('change', () => {
          const v = displayEl.value;
          s.show_timer = (v === 'timer' || v === 'both');
          s.show_progress_ring = (v === 'ring' || v === 'both');
          schedulePreview();
        });
      }
    }
  },
  // To add Stroop, IAT, etc.:
  // stroop: { html(mod) { ... }, bind(card, mod) { ... } }
};

// ---------------------------------------------------------------------------
// buildModuleCard(mod) — creates the full card DOM element for one module
// ---------------------------------------------------------------------------
function buildModuleCard(mod) {
  const card = document.createElement('div');
  card.className = `task-card${mod.enabled ? ' enabled' : ''}`;
  card.dataset.modId = mod.id;

  const badgeHtml = mod.badge
    ? `<span class="badge badge-blue" style="margin-left:6px">${escH(mod.badge)}</span>`
    : '';

  const renderer = SETTINGS_RENDERERS[mod.id];
  const settingsHtml = renderer ? renderer.html(mod) : '';

  card.innerHTML = `
    <div class="task-header">
      <div>
        <div class="task-name">${escH(mod.label)}${badgeHtml}</div>
        <div class="task-desc">${escH(mod.desc)}</div>
      </div>
      <label class="toggle" style="margin-top:2px; flex-shrink:0;">
        <input type="checkbox" class="mod-toggle" ${mod.enabled ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="task-settings${mod.enabled ? '' : ' hidden'}" id="mod-settings-${mod.id}">
      ${settingsHtml}
    </div>
  `;

  // Wire the enable/disable toggle
  card.querySelector('.mod-toggle').addEventListener('change', e => {
    mod.enabled = e.target.checked;
    card.classList.toggle('enabled', mod.enabled);
    card.querySelector(`#mod-settings-${mod.id}`).classList.toggle('hidden', !mod.enabled);
    // Re-render windows so the task dropdowns reflect newly enabled/disabled modules
    if (typeof renderWindows === 'function') renderWindows();
    schedulePreview();
  });

  // Wire settings-specific events
  if (renderer) renderer.bind(card, mod);

  return card;
}

// ---------------------------------------------------------------------------
// renderModules() — rebuilds the full module list from state.modules
// Called by bindTasksTab() and by triggerUIRefresh() in storage.js
// ---------------------------------------------------------------------------
function renderModules() {
  const list = document.getElementById('module-list');
  if (!list) return;
  list.innerHTML = '';
  state.modules.forEach(mod => list.appendChild(buildModuleCard(mod)));
}

// ---------------------------------------------------------------------------
// bindTasksTab() — entry point, called once from builder.html on load
// ---------------------------------------------------------------------------
function bindTasksTab() {
  renderModules();
}