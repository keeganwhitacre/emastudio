"use strict";

// ---------------------------------------------------------------------------
// Questions Tab — v1.5
//
// Changes from v1.4:
//   - Added heart_rate question type. Shows a camera-based PPG capture
//     for duration_sec seconds; stores {bpm, sqi, ibi_series} but
//     surfaces the BPM number for conditional logic comparisons.
//     Builder fields: duration (seconds), report_as ("bpm" only for now).
//   - heart_rate questions created via the Schedule tab HR step are shown
//     here but labelled as auto-managed (editing duration syncs back to
//     the step).
// ---------------------------------------------------------------------------

function renderQuestions() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';
  
  let displayNum = 1; // Track the visual question number
  
  state.ema.questions.forEach((q, i) => {
    // Pass the displayNum to the card builder
    list.appendChild(buildQCard(q, i, displayNum));
    
    // Only increment the number if it's an actual question
    if (q.type !== 'page_break') {
      displayNum++;
    }
  });
}

// Add displayNum as the third argument here
function buildQCard(q, index, displayNum) {
  const card = document.createElement('div');
  card.className = 'q-card';
  card.dataset.qid = q.id;

  // Schema migrations
  if (!q.block && q.type !== 'page_break') q.block = 'both';
  if (q.windows === undefined) q.windows = null;
  if (q.type === 'affect_grid') {
    if (!q.valence_labels) q.valence_labels = ['Unpleasant', 'Pleasant'];
    if (!q.arousal_labels) q.arousal_labels = ['Deactivated', 'Activated'];
    if (q.show_quadrant_labels === undefined) q.show_quadrant_labels = true;
  }
  if (q.type === 'heart_rate') {
    if (!q.duration_sec) q.duration_sec = 30;
    if (!q.report_as)    q.report_as    = 'bpm';
  }

  if (q.type === 'page_break') {
    card.classList.add('page-break');
    card.innerHTML = `
      <div class="q-header" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;">
        <span class="q-drag-handle" style="cursor:grab;flex-shrink:0;">⠿</span>
        <span style="flex:1;text-align:center;font-size:11px;font-weight:700;letter-spacing:0.1em;color:var(--accent);">--- PAGE BREAK ---</span>
        <button class="q-del-btn" style="flex-shrink:0;padding:2px 8px;border:1px solid var(--border);border-radius:var(--radius);background:transparent;color:var(--fg-3);cursor:pointer;">✕</button>
      </div>
    `;
    card.querySelector('.q-del-btn').addEventListener('click', () => {
      state.ema.questions = state.ema.questions.filter(x => x.id !== q.id);
      renderQuestions(); schedulePreview();
    });
    return card;
  }

  let typeLabel = q.type.charAt(0).toUpperCase() + q.type.slice(1).replace('_', ' ');
  if (q.type === 'choice')      typeLabel = 'Single Choice';
  if (q.type === 'checkbox')    typeLabel = 'Multi Select';
  if (q.type === 'affect_grid') typeLabel = 'Affect Grid';
  if (q.type === 'heart_rate')  typeLabel = 'Heart Rate';

  const blockOpts = [
    { value: 'pre',  label: 'Pre-task only'  },
    { value: 'both', label: 'Pre & Post'     },
    { value: 'post', label: 'Post-task only' }
  ].map(o => `<option value="${o.value}" ${q.block === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

  card.innerHTML = `
    <div class="q-header">
      <span class="q-drag-handle">⠿</span>
      <span class="q-num">${displayNum}</span>
      <span class="q-preview-text">${escH(q.text) || '<em style="color:var(--fg-3)">(no text)</em>'}</span>
      <span class="q-type-badge ${q.type}" style="${q.type==='heart_rate'?'background:rgba(246,201,14,0.12);color:#f6c90e;':''}"> ${typeLabel}</span>
      <svg class="q-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l4 4 4-4"/></svg>
    </div>
    <div class="q-body">
      <div class="field-group" style="padding-top:10px">
        <div style="display: flex; justify-content: space-between; align-items: flex-end;">
            <label class="field-label">Label / Caption</label>
            <span style="font-size: 10px; color: var(--fg-muted); font-family: monospace;">ID: ${q.id}</span>
        </div>
        <input type="text" class="q-text" value="${escH(q.text)}" placeholder="${q.type === 'heart_rate' ? 'e.g. Measuring your heart rate…' : 'Enter question…'}">
        <div class="field-hint" style="margin-top:4px">
          To display this answer in later questions, type <code style="color:var(--accent)">{{${q.id}}}</code>
        </div>
      </div>

      ${q.type === 'slider'                              ? buildSliderFields(q)     : ''}
      ${(q.type === 'choice' || q.type === 'checkbox')   ? buildChoiceFields(q)     : ''}
      ${q.type === 'affect_grid'                         ? buildAffectGridFields(q) : ''}
      ${q.type === 'heart_rate'                          ? buildHeartRateFields(q)  : ''}
      ${(q.type === 'text' || q.type === 'numeric')
        ? `<div class="field-hint" style="margin-top:6px">Participants type a ${q.type === 'numeric' ? 'number' : 'text'} response.</div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px;">
        <div class="field-group" style="margin:0">
          <label class="field-label">Show In (Phase)</label>
          <select class="q-block-select" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;">
            ${blockOpts}
          </select>
        </div>
        <div class="field-group" style="margin:0">
          <label class="field-label">Active Sessions</label>
          <div class="q-session-checks">${buildSessionSelector(q)}</div>
        </div>
      </div>

      <div class="field-group" style="margin-top:10px;">
        <label class="field-label">Skip Logic</label>
        ${buildConditionBlock(q, index)}
      </div>
      <div class="toggle-row">
        <span class="toggle-label">Required</span>
        <label class="toggle">
          <input type="checkbox" class="q-required" ${q.required ? 'checked' : ''}>
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="q-footer">
        <button class="q-del-btn-full">Delete Question</button>
      </div>
    </div>
  `;

  card.querySelector('.q-header').addEventListener('click', e => {
    if (e.target.closest('.q-drag-handle')) return;
    card.classList.toggle('expanded');
  });
  card.querySelector('.q-text').addEventListener('input', e => {
    q.text = e.target.value;
    card.querySelector('.q-preview-text').textContent = q.text || '(no text)';
    schedulePreview();
  });
  const blockSel = card.querySelector('.q-block-select');
  if (blockSel) blockSel.addEventListener('change', e => { q.block = e.target.value; schedulePreview(); });
  const reqChk = card.querySelector('.q-required');
  if (reqChk) reqChk.addEventListener('change', e => { q.required = e.target.checked; schedulePreview(); });
  const delBtn = card.querySelector('.q-del-btn-full');
  if (delBtn) delBtn.addEventListener('click', () => {
    state.ema.questions = state.ema.questions.filter(x => x.id !== q.id);
    renderQuestions(); schedulePreview();
  });

  if (q.type === 'slider')                              bindSliderFields(card, q);
  if (q.type === 'choice' || q.type === 'checkbox')     bindChoiceFields(card, q);
  if (q.type === 'affect_grid')                         bindAffectGridFields(card, q);
  if (q.type === 'heart_rate')                          bindHeartRateFields(card, q);

  bindConditionBlock(card, q);
  bindSessionSelector(card, q);

  return card;
}

// ---------------------------------------------------------------------------
// Heart Rate fields
// ---------------------------------------------------------------------------
function buildHeartRateFields(q) {
  return `
    <div class="field-hint" style="margin-top:6px;margin-bottom:8px;">
      Captures PPG via the rear camera for the specified duration. The resulting BPM value
      is stored and can be referenced in conditional task logic. Requires ePATCore — make sure the ePAT module is enabled.
    </div>
    <div class="q-row-2">
      <div class="field-group">
        <label class="field-label">Duration (seconds)</label>
        <input type="number" class="hr-duration" value="${q.duration_sec || 30}" min="10" max="120" step="5">
        <div class="field-hint">10–120 sec. Longer = more stable BPM estimate.</div>
      </div>
      <div class="field-group">
        <label class="field-label">Report As</label>
        <select class="hr-report-as" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;">
          <option value="bpm" ${q.report_as === 'bpm' ? 'selected' : ''}>BPM (for conditions)</option>
        </select>
        <div class="field-hint">BPM is stored as the condition-comparable value. Full IBI series is always saved in the JSON output.</div>
      </div>
    </div>
    <div style="padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:0.78rem;color:var(--fg-muted);">
      Question ID: <code style="color:var(--accent)">${q.id}</code> — use this ID in task step conditions to reference the captured BPM.
    </div>
  `;
}

function bindHeartRateFields(card, q) {
  const durEl = card.querySelector('.hr-duration');
  const repEl = card.querySelector('.hr-report-as');
  if (durEl) durEl.addEventListener('input', e => {
    q.duration_sec = parseInt(e.target.value) || 30;
    // Sync to any HR step in any window that references this question
    state.ema.scheduling.windows.forEach(w => {
      (w.phase_sequence || []).forEach(s => {
        if (s.kind === 'hr' && s.store_as === q.id) s.duration_sec = q.duration_sec;
      });
    });
    schedulePreview();
  });
  if (repEl) repEl.addEventListener('change', e => { q.report_as = e.target.value; schedulePreview(); });
}

// ---------------------------------------------------------------------------
// Slider fields
// ---------------------------------------------------------------------------
function buildSliderFields(q) {
  return `
    <div class="q-row-3">
      <div class="field-group"><label class="field-label">Min</label><input type="number" class="q-min" value="${q.min}"></div>
      <div class="field-group"><label class="field-label">Max</label><input type="number" class="q-max" value="${q.max}"></div>
      <div class="field-group"><label class="field-label">Step</label><input type="number" class="q-step" value="${q.step}" min="0.01" step="0.5"></div>
    </div>
    <div class="q-row-2">
      <div class="field-group"><label class="field-label">Left Anchor</label><input type="text" class="q-anchor-l" value="${escH((q.anchors||['',''])[0])}"></div>
      <div class="field-group"><label class="field-label">Right Anchor</label><input type="text" class="q-anchor-r" value="${escH((q.anchors||['',''])[1])}"></div>
    </div>
    <div class="field-group"><label class="field-label">Unit Suffix</label><input type="text" class="q-unit" value="${escH(q.unit||'')}" placeholder="e.g. hrs, bpm"></div>
  `;
}

function bindSliderFields(card, q) {
  const n = (sel, key) => {
    const el = card.querySelector(sel);
    if (el) el.addEventListener('input', () => { q[key] = parseFloat(el.value)||0; schedulePreview(); });
  };
  n('.q-min','min'); n('.q-max','max'); n('.q-step','step');
  const al = card.querySelector('.q-anchor-l');
  const ar = card.querySelector('.q-anchor-r');
  const un = card.querySelector('.q-unit');
  if (al) al.addEventListener('input', e => { q.anchors[0] = e.target.value; schedulePreview(); });
  if (ar) ar.addEventListener('input', e => { q.anchors[1] = e.target.value; schedulePreview(); });
  if (un) un.addEventListener('input', e => { q.unit = e.target.value || null; schedulePreview(); });
}

// ---------------------------------------------------------------------------
// Choice / Checkbox fields
// ---------------------------------------------------------------------------
function buildChoiceFields(q) {
  const opts = (q.options||[]).map((o,i) => `
    <div class="option-row" data-oi="${i}">
      <input type="text" class="opt-text" value="${escH(o)}" placeholder="Option ${i+1}">
      <button class="option-del">×</button>
    </div>`).join('');
  return `
    <div class="field-group" style="margin-top:10px;">
      <label class="field-label">Options</label>
      <div class="options-list">${opts}</div>
      <button class="btn add-opt-btn" style="margin-top:6px;font-size:11px">+ Add option</button>
    </div>
  `;
}

function bindChoiceFields(card, q) {
  const list = card.querySelector('.options-list');
  if (!list) return;
  function refresh() {
    list.innerHTML = (q.options||[]).map((o,i) => `
      <div class="option-row" data-oi="${i}">
        <input type="text" class="opt-text" value="${escH(o)}" placeholder="Option ${i+1}">
        <button class="option-del">×</button>
      </div>`).join('');
    list.querySelectorAll('.opt-text').forEach((inp,i) => inp.addEventListener('input', e => { q.options[i] = e.target.value; schedulePreview(); }));
    list.querySelectorAll('.option-del').forEach((btn,i) => btn.addEventListener('click', () => { q.options.splice(i,1); refresh(); schedulePreview(); }));
  }
  const addBtn = card.querySelector('.add-opt-btn');
  if (addBtn) addBtn.addEventListener('click', () => { q.options = q.options||[]; q.options.push(''); refresh(); schedulePreview(); });
  refresh();
}

// ---------------------------------------------------------------------------
// Affect Grid fields
// ---------------------------------------------------------------------------
function buildAffectGridFields(q) {
  return `
    <div class="field-hint" style="margin-top:6px;margin-bottom:8px;">
      A 2D tap-target for valence × arousal. Responses stored as <code>{valence, arousal}</code> each in [−1, 1].
    </div>
    <div class="q-row-2">
      <div class="field-group"><label class="field-label">Valence — Low</label><input type="text" class="q-vlo" value="${escH((q.valence_labels||[])[0]||'')}" placeholder="Unpleasant"></div>
      <div class="field-group"><label class="field-label">Valence — High</label><input type="text" class="q-vhi" value="${escH((q.valence_labels||[])[1]||'')}" placeholder="Pleasant"></div>
    </div>
    <div class="q-row-2">
      <div class="field-group"><label class="field-label">Arousal — Low</label><input type="text" class="q-alo" value="${escH((q.arousal_labels||[])[0]||'')}" placeholder="Deactivated"></div>
      <div class="field-group"><label class="field-label">Arousal — High</label><input type="text" class="q-ahi" value="${escH((q.arousal_labels||[])[1]||'')}" placeholder="Activated"></div>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Show quadrant labels</span>
      <label class="toggle"><input type="checkbox" class="q-quadrants" ${q.show_quadrant_labels?'checked':''}><span class="toggle-track"></span></label>
    </div>
  `;
}

function bindAffectGridFields(card, q) {
  const bind = (sel, setter) => { const el = card.querySelector(sel); if (el) el.addEventListener('input', e => { setter(e.target.value); schedulePreview(); }); };
  bind('.q-vlo', v => q.valence_labels[0] = v);
  bind('.q-vhi', v => q.valence_labels[1] = v);
  bind('.q-alo', v => q.arousal_labels[0] = v);
  bind('.q-ahi', v => q.arousal_labels[1] = v);
  const qd = card.querySelector('.q-quadrants');
  if (qd) qd.addEventListener('change', () => { q.show_quadrant_labels = qd.checked; schedulePreview(); });
}

// ---------------------------------------------------------------------------
// Skip Logic / Condition block
// ---------------------------------------------------------------------------
function buildConditionBlock(q, index) {
  const priors = state.ema.questions.slice(0, index).filter(p => p.type !== 'page_break' && p.type !== 'checkbox' && p.type !== 'affect_grid');
  if (priors.length === 0) return `<div style="font-size:11px;color:var(--fg-3);padding:4px 0">No prior questions available.</div>`;
  const has   = !!q.condition;
  const src   = q.condition?.question_id || priors[0]?.id || '';
  const qOpts = priors.map(p => `<option value="${p.id}" ${p.id===src?'selected':''}>${escH(p.text?.slice(0,40)||p.id)}</option>`).join('');
  const ops   = ['eq','neq','gt','gte','lt','lte'].map(op => `<option value="${op}" ${q.condition?.operator===op?'selected':''}>${op}</option>`).join('');
  const val   = q.condition?.value ?? '';
  return `
    <div class="q-condition-block">
      <div class="toggle-row">
        <span class="toggle-label" style="font-size:11px;">Enable skip logic</span>
        <label class="toggle"><input type="checkbox" class="cond-enable" ${has?'checked':''}><span class="toggle-track"></span></label>
      </div>
      <div class="cond-fields" style="display:${has?'flex':'none'};flex-direction:column;gap:6px;margin-top:8px;">
        <div class="condition-row">
          <select class="cond-q">${qOpts}</select>
          <select class="cond-op">${ops}</select>
          <input type="text" class="cond-val" value="${escH(String(val))}" placeholder="value">
        </div>
      </div>
    </div>
  `;
}

function bindConditionBlock(card, q) {
  const toggle  = card.querySelector('.cond-enable');
  const fields  = card.querySelector('.cond-fields');
  const qSel    = card.querySelector('.cond-q');
  const opSel   = card.querySelector('.cond-op');
  const valInp  = card.querySelector('.cond-val');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      q.condition = { question_id: qSel?.value||'', operator: opSel?.value||'eq', value: valInp?.value||0 };
      if (fields) fields.style.display = 'flex';
    } else {
      q.condition = null;
      if (fields) fields.style.display = 'none';
    }
    schedulePreview();
  });
  if (qSel) qSel.addEventListener('change', () => { if (!q.condition) return; q.condition.question_id = qSel.value; schedulePreview(); });
  if (opSel) opSel.addEventListener('change', () => { if (!q.condition) return; q.condition.operator = opSel.value; schedulePreview(); });
  if (valInp) valInp.addEventListener('input', () => {
    if (!q.condition) return;
    const v = valInp.value;
    if (v.includes(',')) q.condition.value = v.split(',').map(x => x.trim());
    else if (v !== '' && !isNaN(Number(v))) q.condition.value = Number(v);
    else q.condition.value = v;
    schedulePreview();
  });
}

// ---------------------------------------------------------------------------
// Session selector
// ---------------------------------------------------------------------------
function buildSessionSelector(q) {
  const windows = state.ema.scheduling.windows || [];
  if (windows.length === 0) return `<div style="font-size:0.8rem;color:var(--fg-3);">No sessions defined.</div>`;
  return windows.map(w => {
    const checked = (q.windows === null || q.windows === undefined || q.windows.includes(w.id));
    return `<label class="session-check-row"><input type="checkbox" class="session-chk" data-wid="${w.id}" ${checked?'checked':''}><span>${escH(w.label)}</span></label>`;
  }).join('');
}

function bindSessionSelector(card, q) {
  card.querySelectorAll('.session-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const all = [...card.querySelectorAll('.session-chk')];
      const checked = all.filter(c => c.checked).map(c => c.dataset.wid);
      q.windows = checked.length === all.length ? null : checked;
      schedulePreview();
    });
  });
}

// ---------------------------------------------------------------------------
// Add question helpers
// ---------------------------------------------------------------------------
function addQ(obj) {
  state.ema.questions.push(obj);
  renderQuestions(); schedulePreview();
  const cards = document.querySelectorAll('.q-card');
  if (cards.length && obj.type !== 'page_break') cards[cards.length-1].classList.add('expanded');
}

(function wireAddButtons() {
  const wire = (id, factory) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => addQ(factory()));
  };
  wire('add-slider-btn',  () => ({ id: genQId(), type: 'slider',     text: '', min: 0, max: 100, step: 1, unit: null, anchors: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-choice-btn',  () => ({ id: genQId(), type: 'choice',     text: '', options: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-check-btn',   () => ({ id: genQId(), type: 'checkbox',   text: '', options: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-text-btn',    () => ({ id: genQId(), type: 'text',       text: '', required: true, condition: null, block: 'both', windows: null }));
  wire('add-num-btn',     () => ({ id: genQId(), type: 'numeric',    text: '', required: true, condition: null, block: 'both', windows: null }));
  wire('add-affect-btn',  () => ({ id: genQId(), type: 'affect_grid', text: 'Right now, how are you feeling?',
                                    valence_labels: ['Unpleasant', 'Pleasant'], arousal_labels: ['Deactivated', 'Activated'],
                                    show_quadrant_labels: true, required: true, condition: null, block: 'both', windows: null }));
  wire('add-page-btn',    () => ({ id: genQId(), type: 'page_break' }));
  // Heart rate can be added manually too (not just via Schedule tab)
  wire('add-hr-btn',      () => ({ id: genQId(), type: 'heart_rate', text: 'Measuring your heart rate…',
                                    duration_sec: 30, report_as: 'bpm', required: true, condition: null, block: 'both', windows: null }));
})();