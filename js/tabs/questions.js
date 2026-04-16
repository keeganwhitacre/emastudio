function renderQuestions() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';
  state.ema.questions.forEach((q, i) => list.appendChild(buildQCard(q, i)));
}

function buildQCard(q, index) {
  const card = document.createElement('div');
  card.className = 'q-card';
  card.dataset.qid = q.id;

  // Handle Page Break UI entirely differently
  if (q.type === 'page_break') {
    card.classList.add('page-break');
    card.innerHTML = `
      <div class="q-header">
        <span class="q-drag-handle" style="position:absolute;left:12px;cursor:grab;">⠿</span>
        <span style="font-size:11px;font-weight:700;letter-spacing:0.1em;color:var(--accent);">--- PAGE BREAK ---</span>
        <button class="q-del-btn" style="position:absolute;right:12px;">✕</button>
      </div>
    `;
    card.querySelector('.q-del-btn').addEventListener('click', () => {
      state.ema.questions = state.ema.questions.filter(x => x.id !== q.id);
      renderQuestions(); schedulePreview();
    });
    return card;
  }

  // Handle standard questions
  let typeLabel = q.type.charAt(0).toUpperCase() + q.type.slice(1);
  if (q.type === 'choice') typeLabel = 'Single Choice';
  if (q.type === 'checkbox') typeLabel = 'Multi Select';

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
      ${(q.type === 'text' || q.type === 'numeric') ? `<div class="field-hint" style="margin-top:6px">Participants will be given a ${q.type === 'numeric' ? 'number pad' : 'text box'} to answer this question.</div>` : ''}
      <div class="field-group" style="margin-top: 10px;">
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
      <button class="q-del-btn">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM5 3V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75V3h3.25a.75.75 0 010 1.5H.75A.75.75 0 010 4.5H3zm1.5 0h3v1H6.5V3zM3.074 5.5l.75 7.5a.75.75 0 00.746.676h6.86a.75.75 0 00.745-.676l.75-7.5H3.074z"/></svg>
        Remove
      </button>
    </div>
  `;

  card.querySelector('.q-header').addEventListener('click', () => card.classList.toggle('expanded'));
  card.querySelector('.q-text').addEventListener('input', e => {
    q.text = e.target.value;
    card.querySelector('.q-preview-text').innerHTML = escH(q.text) || '<em style="color:var(--fg-3)">(no text)</em>';
    schedulePreview();
  });
  card.querySelector('.q-required').addEventListener('change', e => { q.required = e.target.checked; schedulePreview(); });
  card.querySelector('.q-del-btn').addEventListener('click', () => {
    state.ema.questions = state.ema.questions.filter(x => x.id !== q.id);
    renderQuestions(); schedulePreview();
  });

  if (q.type === 'slider') bindSliderFields(card, q);
  if (q.type === 'choice' || q.type === 'checkbox') bindChoiceFields(card, q);
  bindConditionFields(card, q, index);

  return card;
}

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
    <div class="field-group"><label class="field-label">Unit Suffix (optional)</label><input type="text" class="q-unit" value="${escH(q.unit||'')}" placeholder="e.g. hrs"></div>
  `;
}

function bindSliderFields(card, q) {
  const n = (sel, key) => { const el = card.querySelector(sel); if(el) el.addEventListener('input', () => { q[key] = parseFloat(el.value)||0; schedulePreview(); }); };
  n('.q-min','min'); n('.q-max','max'); n('.q-step','step');
  card.querySelector('.q-anchor-l').addEventListener('input', e => { q.anchors[0] = e.target.value; schedulePreview(); });
  card.querySelector('.q-anchor-r').addEventListener('input', e => { q.anchors[1] = e.target.value; schedulePreview(); });
  card.querySelector('.q-unit').addEventListener('input', e => { q.unit = e.target.value || null; schedulePreview(); });
}

function buildChoiceFields(q) {
  const opts = (q.options||[]).map((o,i) => `
    <div class="option-row" data-oi="${i}">
      <input type="text" class="opt-text" value="${escH(o)}" placeholder="Option ${i+1}">
      <button class="option-del">×</button>
    </div>`).join('');
  return `
    <div class="field-group" style="margin-top: 10px;">
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
  card.querySelector('.add-opt-btn').addEventListener('click', () => { q.options = q.options || []; q.options.push(''); refresh(); schedulePreview(); });
  refresh();
}

function buildConditionBlock(q, index) {
  const priors = state.ema.questions.slice(0, index).filter(p => p.type !== 'page_break');
  if (priors.length === 0) return `<div style="font-size:11px;color:var(--fg-3);padding:4px 0">No prior questions available for logic.</div>`;
  const has = !!q.condition;
  const src = q.condition ? q.condition.question_id : (priors[0]?.id || '');
  const qOpts = priors.map(p => `<option value="${p.id}" ${p.id===src?'selected':''}>${escH(p.text.slice(0,35)||p.id)}</option>`).join('');
  const opOpts = [['eq','='],['neq','≠'],['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['includes','includes']]
    .map(([v,l]) => `<option value="${v}" ${q.condition?.operator===v?'selected':''}>${l}</option>`).join('');
  return `
    <div class="toggle-row" style="margin-bottom:${has?'8px':'0'}">
      <span class="toggle-label" style="font-size:11px;color:var(--fg-3)">Enable skip condition</span>
      <label class="toggle"><input type="checkbox" class="cond-enable" ${has?'checked':''}><span class="toggle-track"></span></label>
    </div>
    <div class="q-condition-block" style="display:${has?'flex':'none'}">
      <div class="condition-row">
        <div class="field-group" style="margin:0"><select class="cond-qid">${qOpts}</select></div>
        <div class="field-group" style="margin:0"><select class="cond-op">${opOpts}</select></div>
        <div class="field-group" style="margin:0"><input type="text" class="cond-val" value="${escH(Array.isArray(q.condition?.value)?q.condition.value.join(','):String(q.condition?.value??''))}"></div>
      </div>
      <div style="font-size:10px;color:var(--fg-3)">Numerics compared by value. For includes: comma-separate multiple options.</div>
    </div>
  `;
}

function bindConditionFields(card, q, index) {
  const enableChk = card.querySelector('.cond-enable');
  const block = card.querySelector('.q-condition-block');
  if (!enableChk) return;
  enableChk.addEventListener('change', () => {
    if (enableChk.checked) {
      const priors = state.ema.questions.slice(0, index).filter(p => p.type !== 'page_break');
      q.condition = { question_id: priors[0]?.id||'', operator: 'gte', value: 50 };
      block.style.display = 'flex';
    } else { q.condition = null; block.style.display = 'none'; }
    schedulePreview();
  });
  const qidSel = card.querySelector('.cond-qid');
  const opSel  = card.querySelector('.cond-op');
  const valInp = card.querySelector('.cond-val');
  if (qidSel) qidSel.addEventListener('change', () => { if (q.condition) q.condition.question_id = qidSel.value; schedulePreview(); });
  if (opSel)  opSel.addEventListener('change',  () => { if (q.condition) q.condition.operator = opSel.value; schedulePreview(); });
  if (valInp) valInp.addEventListener('input',  () => {
    if (!q.condition) return;
    const v = valInp.value;
    if (v.includes(',')) q.condition.value = v.split(',').map(x => x.trim());
    else if (v !== '' && !isNaN(Number(v))) q.condition.value = Number(v);
    else q.condition.value = v;
    schedulePreview();
  });
}

// Button Bindings
function addQ(obj) {
  state.ema.questions.push(obj);
  renderQuestions(); schedulePreview();
  const cards = document.querySelectorAll('.q-card'); 
  if (cards.length && obj.type !== 'page_break') cards[cards.length-1].classList.add('expanded');
}

document.getElementById('add-slider-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'slider', text: '', min: 0, max: 100, step: 1, unit: null, anchors: ['',''], required: true, condition: null }));
document.getElementById('add-choice-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'choice', text: '', options: ['',''], required: true, condition: null }));
document.getElementById('add-check-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'checkbox', text: '', options: ['',''], required: true, condition: null }));
document.getElementById('add-text-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'text', text: '', required: true, condition: null }));
document.getElementById('add-num-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'numeric', text: '', required: true, condition: null }));
document.getElementById('add-page-btn').addEventListener('click', () => addQ({ id: genQId(), type: 'page_break' }));