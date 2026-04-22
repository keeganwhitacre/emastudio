"use strict";

// ---------------------------------------------------------------------------
// Study Tab — v1.4
//
// Changes from v1.3:
//   - Format segmented control now syncs its "active" class from state on
//     init rather than relying on the hardcoded `active` in builder.html.
//     Fixes the minor bug where a fresh load showed JSON as active while
//     state.study.output_format defaulted to "csv".
//   - Format-hint text regenerated on init too (was drifting from active state).
//   - Added bindings for study.completion_lock and study.resume_enabled
//     if the corresponding checkboxes exist in builder.html.
// ---------------------------------------------------------------------------

// Tab Navigation (unchanged)
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.config-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const section = document.getElementById(`tab-${btn.dataset.tab}`);
    if (section) section.classList.add('active');
  });
});

function formatHintTextFor(fmt) {
  return fmt === 'json'
    ? 'Each submission downloads a .json file with the full session including any task signal data.'
    : 'Each submission downloads a .csv with one row per question. Easy to concatenate across participants. Task signal data (e.g. ePAT) downloads alongside as a separate .json.';
}

function syncFormatCtrl() {
  const fmt = state.study.output_format || 'csv';
  document.querySelectorAll('#format-ctrl .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === fmt);
  });
  const hint = document.getElementById('format-hint');
  if (hint) hint.textContent = formatHintTextFor(fmt);
}

function bindStudyTab() {
  const bind = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { setter(el.value); schedulePreview(); });
  };
  bind('study-name',  v => state.study.name = v);
  bind('institution', v => state.study.institution = v);
  bind('study-webhook', v => state.study.webhook_url = v);

  const themeEl = document.getElementById('study-theme');
  if (themeEl) {
    themeEl.value = state.study.theme;
    themeEl.addEventListener('change', e => {
      state.study.theme = e.target.value;
      schedulePreview();
    });
  }

  const accent = document.getElementById('accent-color');
  const swatch = document.getElementById('color-preview-swatch');
  if (accent) {
    accent.addEventListener('input', e => {
      state.study.accent_color = e.target.value;
      if (swatch) swatch.style.background = e.target.value;
      schedulePreview();
    });
  }
  if (swatch) swatch.style.background = state.study.accent_color;

  // Format segmented control
  const fmtCtrl = document.getElementById('format-ctrl');
  if (fmtCtrl) {
    fmtCtrl.addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.study.output_format = btn.dataset.fmt;
      syncFormatCtrl();
      schedulePreview();
    });
    // Sync on init — ensures the active class reflects state, not the
    // possibly-stale hardcoded `active` attribute in builder.html.
    syncFormatCtrl();
  }

  // v1.4 study-level flags: completion lock + resume
  const lockEl = document.getElementById('study-completion-lock');
  if (lockEl) {
    lockEl.checked = !!state.study.completion_lock;
    lockEl.addEventListener('change', e => {
      state.study.completion_lock = e.target.checked;
      schedulePreview();
    });
  }
  const resumeEl = document.getElementById('study-resume-enabled');
  if (resumeEl) {
    resumeEl.checked = !!state.study.resume_enabled;
    resumeEl.addEventListener('change', e => {
      state.study.resume_enabled = e.target.checked;
      schedulePreview();
    });
  }
// v1.5 EMA Randomization
  const randEl = document.getElementById('ema-randomize');
  if (randEl) {
    randEl.checked = !!state.ema.randomize_questions;
    randEl.addEventListener('change', e => {
      state.ema.randomize_questions = e.target.checked;
      schedulePreview();
    });
  }
} 

// Dynamically generate greeting inputs based on schedule windows.
// Also prunes orphan greetings (keys whose windows no longer exist) — keeps
// state.study.greetings from accumulating cruft over the study's life.
function renderGreetings() {
  const list = document.getElementById('dynamic-greetings-list');
  if (!list) return;
  list.innerHTML = '';

  if (!state.study.greetings) state.study.greetings = {};

  // Prune orphans
  const validIds = new Set(state.ema.scheduling.windows.map(w => w.id));
  Object.keys(state.study.greetings).forEach(k => {
    if (!validIds.has(k)) delete state.study.greetings[k];
  });

  state.ema.scheduling.windows.forEach(w => {
    if (!state.study.greetings[w.id]) {
      state.study.greetings[w.id] = "Check-In";
    }

    const row = document.createElement('div');
    row.className = 'field-group';
    row.style.marginBottom = '16px';
    row.innerHTML = `
      <label class="field-label">${escH(w.label)} Greeting</label>
      <input type="text" class="greeting-input" data-wid="${w.id}" value="${escH(state.study.greetings[w.id])}">
    `;
    row.querySelector('.greeting-input').addEventListener('input', e => {
      state.study.greetings[w.id] = e.target.value;
      schedulePreview();
    });

    list.appendChild(row);
  });
}