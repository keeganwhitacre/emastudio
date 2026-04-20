"use strict";

// ---------------------------------------------------------------------------
// Questions Tab — v1.4
//
// Changes from v1.2.1:
//   - Added affect_grid question type. UI lets the researcher customize
//     the valence + arousal axis labels and toggle quadrant labels.
//     The underlying data shape for responses is {valence, arousal} where
//     both live in [-1, 1]. See templates/module-ema.js for rendering.
//   - Schema migration: any question without a windows field gets null;
//     any question without a block gets 'both'; affect_grid gets
//     reasonable axis-label defaults if missing.
// ---------------------------------------------------------------------------

function renderQuestions() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';
  state.ema.questions.forEach((q, i) => list.appendChild(buildQCard(q, i)));
}

function buildQCard(q, index) {
  const card = document.createElement('div');
  card.className = 'q-card';
  card.dataset.qid = q.id;

  // Schema migrations
  if (!q.block && q.type !== 'page_break')   q.block   = 'both';
  if (q.windows === undefined)               q.windows = null;
  if (q.type === 'affect_grid') {
    if (!q.valence_labels) q.valence_labels = ['Unpleasant', 'Pleasant'];
    if (!q.arousal_labels) q.arousal_labels = ['Deactivated', 'Activated'];
    if (q.show_quadrant_labels === undefined) q.show_quadrant_labels = true;
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

  let typeLabel = q.type.charAt(0).toUpperCase() + q.type.slice(1);
  if (q.type === 'choice')      typeLabel = 'Single Choice';
  if (q.type === 'checkbox')    typeLabel = 'Multi Select';
  if (q.type === 'affect_grid') typeLabel = 'Affect Grid';

  const blockOpts = [
    { value: 'pre',  label: 'Pre-task only' },
    { value: 'both', label: 'Pre & Post'    },
    { value: 'post', label: 'Post-task only' }
  ].map(o => `<option value="${o.value}" ${q.block === o.value ? 'selected' : ''}>${o.label}</option>`).join('');

  card.innerHTML = `
    <div class="q-header">
      <span class="q-drag-handle">⠿</span>
      <span class="q-num">${index + 1}</span>
      <span class="q-preview-text">${escH(q.text) || '<em style="color:var(--fg-3)">(no text)</em>'}</span>
      <span class="q-type-badge ${q.type}">${typeLabel}</span>
      <svg class="q-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l4 4 4-4"/></svg>
    </div>
    <div class="q-body">
      <div class="field-group" style="padding-top:10px">
        <label class="field-label">Question Text</label>
        <input type="text" class="q-text" value="${escH(q.text)}" placeholder="Enter question…">
      </div>
      ${q.type === 'slider' ? buildSliderFields(q) : ''}
      ${(q.type === 'choice' || q.type === 'checkbox') ? buildChoiceFields(q) : ''}
      ${q.type === 'affect_grid' ? buildAffectGridFields(q) : ''}
      ${(q.type === 'text' || q.type === 'numeric') ? `<div class="field-hint" style="margin-top:6px">Participants will be given a ${q.type === 'numeric' ? 'number pad' : 'text box'} to answer this question.</div>` : ''}

      <!-- Scheduling controls -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px;">
        <div class="field-group" style="margin:0">
          <label class="field-label">Show In (Phase)
            <span class="field-hint" style="display:inline;margin-left:4px;">Which EMA block when a task is present.</span>
          </label>
          <select class="q-block-select" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--fg);font-family:var(--font);font-size:0.88rem;outline:none;">
            ${blockOpts}
          </select>
        </div>
        <div class="field-group" style="margin:0">
          <label class="field-label">Active Sessions
            <span class="field-hint" style="display:inline;margin-left:4px;">Uncheck to exclude from a session.</span>
          </label>
          <div class="q-session-checks">
            ${buildSessionSelector(q)}
          </div>
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

  // ---- Common bindings ----
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

  // ---- Type-specific bindings ----
  if (q.type === 'slider')                                 bindSliderFields(card, q);
  if (q.type === 'choice' || q.type === 'checkbox')        bindChoiceFields(card, q);
  if (q.type === 'affect_grid')                            bindAffectGridFields(card, q);

  bindConditionBlock(card, q);
  bindSessionSelector(card, q);

  return card;
}

// ---------------------------------------------------------------------------
// buildSessionSelector / bindSessionSelector
// ---------------------------------------------------------------------------
function buildSessionSelector(q) {
  const windows = state.ema.scheduling.windows || [];
  if (windows.length === 0) {
    return `<div style="font-size:0.8rem;color:var(--fg-3);">No sessions defined yet.</div>`;
  }
  const currentSelection = q.windows;  // null = all selected
  return windows.map(w => {
    const checked = (currentSelection === null || currentSelection === undefined || currentSelection.includes(w.id));
    return `
      <label class="session-check-row">
        <input type="checkbox" class="session-chk" data-wid="${w.id}" ${checked ? 'checked' : ''}>
        <span>${escH(w.label)}</span>
      </label>
    `;
  }).join('');
}

function bindSessionSelector(card, q) {
  card.querySelectorAll('.session-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const allChecks = [...card.querySelectorAll('.session-chk')];
      const checked   = allChecks.filter(c => c.checked).map(c => c.dataset.wid);
      q.windows = checked.length === allChecks.length ? null : checked;
      schedulePreview();
    });
  });
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
    <div class="field-group"><label class="field-label">Unit Suffix (optional)</label><input type="text" class="q-unit" value="${escH(q.unit||'')}" placeholder="e.g. bpm, hrs"></div>
  `;
}

function bindSliderFields(card, q) {
  const n = (sel, key) => {
    const el = card.querySelector(sel);
    if (el) el.addEventListener('input', () => { q[key] = parseFloat(el.value)||0; schedulePreview(); });
  };
  n('.q-min','min'); n('.q-max','max'); n('.q-step','step');
  card.querySelector('.q-anchor-l').addEventListener('input', e => { q.anchors[0] = e.target.value; schedulePreview(); });
  card.querySelector('.q-anchor-r').addEventListener('input', e => { q.anchors[1] = e.target.value; schedulePreview(); });
  card.querySelector('.q-unit').addEventListener('input',     e => { q.unit = e.target.value || null; schedulePreview(); });
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
  card.querySelector('.add-opt-btn').addEventListener('click', () => { q.options = q.options||[]; q.options.push(''); refresh(); schedulePreview(); });
  refresh();
}

// ---------------------------------------------------------------------------
// Affect Grid fields (new in v1.4)
// ---------------------------------------------------------------------------
function buildAffectGridFields(q) {
  return `
    <div class="field-hint" style="margin-top:6px;margin-bottom:8px;">
      A 2D tap-target for valence × arousal. Participants tap a point on the grid;
      responses are stored as <code>{valence, arousal}</code>, each in [−1, 1].
    </div>
    <div class="q-row-2">
      <div class="field-group">
        <label class="field-label">Valence — Low Anchor</label>
        <input type="text" class="q-vlo" value="${escH((q.valence_labels||[])[0] || '')}" placeholder="Unpleasant">
      </div>
      <div class="field-group">
        <label class="field-label">Valence — High Anchor</label>
        <input type="text" class="q-vhi" value="${escH((q.valence_labels||[])[1] || '')}" placeholder="Pleasant">
      </div>
    </div>
    <div class="q-row-2">
      <div class="field-group">
        <label class="field-label">Arousal — Low Anchor</label>
        <input type="text" class="q-alo" value="${escH((q.arousal_labels||[])[0] || '')}" placeholder="Deactivated">
      </div>
      <div class="field-group">
        <label class="field-label">Arousal — High Anchor</label>
        <input type="text" class="q-ahi" value="${escH((q.arousal_labels||[])[1] || '')}" placeholder="Activated">
      </div>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">Show quadrant labels (Tense, Excited, Calm, Depressed)</span>
      <label class="toggle">
        <input type="checkbox" class="q-quadrants" ${q.show_quadrant_labels ? 'checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    </div>
  `;
}

function bindAffectGridFields(card, q) {
  const vLo = card.querySelector('.q-vlo');
  const vHi = card.querySelector('.q-vhi');
  const aLo = card.querySelector('.q-alo');
  const aHi = card.querySelector('.q-ahi');
  const qd  = card.querySelector('.q-quadrants');
  if (vLo) vLo.addEventListener('input', () => { q.valence_labels[0] = vLo.value; schedulePreview(); });
  if (vHi) vHi.addEventListener('input', () => { q.valence_labels[1] = vHi.value; schedulePreview(); });
  if (aLo) aLo.addEventListener('input', () => { q.arousal_labels[0] = aLo.value; schedulePreview(); });
  if (aHi) aHi.addEventListener('input', () => { q.arousal_labels[1] = aHi.value; schedulePreview(); });
  if (qd)  qd.addEventListener('change', () => { q.show_quadrant_labels = qd.checked; schedulePreview(); });
}

// ---------------------------------------------------------------------------
// Skip Logic / Condition block
// ---------------------------------------------------------------------------
function buildConditionBlock(q, index) {
  const priors = state.ema.questions.slice(0, index).filter(p => p.type !== 'page_break');
  if (priors.length === 0) return `<div style="font-size:11px;color:var(--fg-3);padding:4px 0">No prior questions available for logic.</div>`;
  const has    = !!q.condition;
  const src    = q.condition ? q.condition.question_id : (priors[0]?.id || '');
  const qOpts  = priors.map(p => `<option value="${p.id}" ${p.id===src?'selected':''}>${escH(p.text || p.id)}</option>`).join('');
  const op     = q.condition ? q.condition.operator : 'eq';
  const val    = q.condition ? (Array.isArray(q.condition.value) ? q.condition.value.join(',') : q.condition.value) : '';

  return `
    <div class="toggle-row" style="margin-top:0">
      <span class="toggle-label">Only show this question if…</span>
      <label class="toggle">
        <input type="checkbox" class="cond-on" ${has?'checked':''}>
        <span class="toggle-track"></span>
      </label>
    </div>
    <div class="cond-body" style="display:${has?'grid':'none'};grid-template-columns:2fr 1fr 1.5fr;gap:8px;margin-top:8px;">
      <select class="cond-qid">${qOpts}</select>
      <select class="cond-op">
        <option value="eq"  ${op==='eq' ?'selected':''}>equals</option>
        <option value="neq" ${op==='neq'?'selected':''}>not equals</option>
        <option value="gt"  ${op==='gt' ?'selected':''}>&gt;</option>
        <option value="gte" ${op==='gte'?'selected':''}>&gt;=</option>
        <option value="lt"  ${op==='lt' ?'selected':''}>&lt;</option>
        <option value="lte" ${op==='lte'?'selected':''}>&lt;=</option>
        <option value="includes" ${op==='includes'?'selected':''}>includes</option>
      </select>
      <input type="text" class="cond-val" value="${escH(val)}" placeholder="value">
    </div>
  `;
}

function bindConditionBlock(card, q) {
  const toggle = card.querySelector('.cond-on');
  const body   = card.querySelector('.cond-body');
  const qSel   = card.querySelector('.cond-qid');
  const opSel  = card.querySelector('.cond-op');
  const valInp = card.querySelector('.cond-val');

  if (!toggle) return;
  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      if (!q.condition) q.condition = { question_id: qSel.value, operator: 'eq', value: '' };
      body.style.display = 'grid';
    } else {
      q.condition = null;
      body.style.display = 'none';
    }
    schedulePreview();
  });
  if (qSel)   qSel.addEventListener('change',   () => { if (q.condition) q.condition.question_id = qSel.value; schedulePreview(); });
  if (opSel)  opSel.addEventListener('change',  () => { if (q.condition) q.condition.operator    = opSel.value; schedulePreview(); });
  if (valInp) valInp.addEventListener('input',  () => {
    if (!q.condition) return;
    const v = valInp.value;
    if (v.includes(','))                    q.condition.value = v.split(',').map(x => x.trim());
    else if (v !== '' && !isNaN(Number(v))) q.condition.value = Number(v);
    else                                    q.condition.value = v;
    schedulePreview();
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

// Button wiring — guarded with if (el) because not all buttons exist on every page
(function wireAddButtons() {
  const wire = (id, factory) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => addQ(factory()));
  };
  wire('add-slider-btn',  () => ({ id: genQId(), type: 'slider',   text: '', min: 0, max: 100, step: 1, unit: null, anchors: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-choice-btn',  () => ({ id: genQId(), type: 'choice',   text: '', options: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-check-btn',   () => ({ id: genQId(), type: 'checkbox', text: '', options: ['',''], required: true, condition: null, block: 'both', windows: null }));
  wire('add-text-btn',    () => ({ id: genQId(), type: 'text',     text: '', required: true, condition: null, block: 'both', windows: null }));
  wire('add-num-btn',     () => ({ id: genQId(), type: 'numeric',  text: '', required: true, condition: null, block: 'both', windows: null }));
  wire('add-affect-btn',  () => ({ id: genQId(), type: 'affect_grid', text: 'Right now, how are you feeling?',
                                    valence_labels: ['Unpleasant', 'Pleasant'],
                                    arousal_labels: ['Deactivated', 'Activated'],
                                    show_quadrant_labels: true,
                                    required: true, condition: null, block: 'both', windows: null }));
  wire('add-page-btn',    () => ({ id: genQId(), type: 'page_break' }));
})();