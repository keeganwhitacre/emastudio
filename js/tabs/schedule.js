"use strict";

// ---------------------------------------------------------------------------
// Schedule Tab — v1.5
//
// Changes from v1.2:
//   - Phase Sequencer replaced by a full step list. Each window has an
//     ordered array of steps: EMA block, Task, HR Capture.
//   - Multiple tasks per window are supported — add as many task steps
//     as needed in any order.
//   - Each Task step has an optional condition (question_id + operator + value)
//     that gates whether it runs at all (evaluated against prior EMA responses
//     at runtime). Useful for e.g. "only run ePAT if HR > 80".
//   - HR Capture steps let you specify a duration; they store BPM inline
//     which other conditions can reference.
//   - The legacy phases: {pre, task, post} triple is still kept on each window
//     for backward compat but is no longer the primary authoring surface.
//     buildConfig() always emits phase_sequence.
// ---------------------------------------------------------------------------

function bindScheduleTab() {
  const bindNum = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { setter(parseInt(el.value)||0); schedulePreview(); });
  };
  bindNum('study-days',    v => state.ema.scheduling.study_days = v);
  bindNum('daily-prompts', v => state.ema.scheduling.daily_prompts = v);
  bindNum('window-expiry', v => state.ema.scheduling.timing.expiry_minutes = v);
  bindNum('grace-period',  v => state.ema.scheduling.timing.grace_minutes = v);

  document.querySelectorAll('#dow-grid .dow-chip').forEach(chip => {
    const dow = parseInt(chip.dataset.dow);
    chip.classList.toggle('on', state.ema.scheduling.days_of_week.includes(dow));
    chip.addEventListener('click', () => {
      const active = chip.classList.toggle('on');
      if (active) state.ema.scheduling.days_of_week.push(dow);
      else state.ema.scheduling.days_of_week = state.ema.scheduling.days_of_week.filter(d => d !== dow);
      state.ema.scheduling.days_of_week.sort();
      schedulePreview();
    });
  });

  document.getElementById('add-window-btn').addEventListener('click', () => {
    const wId = genWId();
    state.ema.scheduling.windows.push({
      id: wId,
      label: `Window ${state.ema.scheduling.windows.length + 1}`,
      start: "12:00",
      end: "13:00",
      phases: { pre: true, task: null, post: false },
      phase_sequence: [{ kind: "ema", block: "pre" }]
    });
    renderWindows();
    if (typeof renderGreetings === 'function') renderGreetings();
    if (typeof renderPreviewTabs === 'function') renderPreviewTabs();
    if (typeof renderQuestions === 'function') renderQuestions();
    schedulePreview();
  });
}

// ---------------------------------------------------------------------------
// renderWindows — rebuilds the window list from state
// ---------------------------------------------------------------------------
function renderWindows() {
  const list = document.getElementById('window-list');
  list.innerHTML = '';
  state.ema.scheduling.windows.forEach((w, i) => {
    migrateWindow(w);
    list.appendChild(buildWindowCard(w, i));
  });
}

// Ensure every window has a valid phase_sequence (schema migration)
function migrateWindow(w) {
  if (!w.phases) w.phases = { pre: true, task: null, post: false };
  if (!Array.isArray(w.phase_sequence) || w.phase_sequence.length === 0) {
    w.phase_sequence = phasesToSequence(w);
  }
}

// ---------------------------------------------------------------------------
// buildWindowCard
// ---------------------------------------------------------------------------
function buildWindowCard(w, i) {
  const el = document.createElement('div');
  el.className = 'window-item drag-item';
  el.style.cssText = 'display:flex;align-items:flex-start;gap:16px;background:var(--bg-surface);padding:16px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;';

  el.innerHTML = `
    <div style="cursor:grab;color:var(--fg-muted);font-weight:bold;padding-top:12px;flex-shrink:0;">⋮⋮</div>
    <div class="window-content" style="flex:1;display:flex;flex-direction:column;gap:10px;">

      <input type="text" class="win-label" value="${escH(w.label)}"
        style="width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-family:var(--font);font-size:1rem;outline:none;">

      <div style="display:flex;gap:12px;align-items:center;">
        <input type="time" class="win-start" value="${w.start}"
          style="flex:1;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-family:var(--font-mono);font-size:0.95rem;outline:none;">
        <span style="color:var(--fg-muted);font-size:0.9rem;font-weight:500;">to</span>
        <input type="time" class="win-end" value="${w.end}"
          style="flex:1;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--fg);font-family:var(--font-mono);font-size:0.95rem;outline:none;">
      </div>

      <div class="phase-sequencer-container" style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <span style="font-size:0.75rem;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.07em;">Session Sequence</span>
          <div style="display:flex;gap:6px;">
            <button class="add-step-btn" data-kind="ema"  style="padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;color:#63b3ed;font-family:var(--font);font-size:10px;font-weight:700;cursor:pointer;letter-spacing:0.05em;">+ EMA</button>
            <button class="add-step-btn" data-kind="task" style="padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--accent);font-family:var(--font);font-size:10px;font-weight:700;cursor:pointer;letter-spacing:0.05em;">+ Task</button>
          </div>
        </div>
        <div class="step-list"></div>
        <div class="field-hint" style="margin-top:6px;margin-bottom:0;">Steps run top to bottom. Conditions on task steps are evaluated against prior EMA responses in the same session.</div>
      </div>

    </div>
    <button class="del-btn" title="Remove window"
      style="background:none;border:none;color:var(--accent-red);font-size:1.4rem;cursor:pointer;padding:8px;opacity:0.7;flex-shrink:0;">✕</button>
  `;

  // Wire label + time
  el.querySelector('.win-label').addEventListener('input', e => {
    w.label = e.target.value;
    if (typeof renderGreetings === 'function') renderGreetings();
    if (typeof renderPreviewTabs === 'function') renderPreviewTabs();
    if (typeof renderQuestions === 'function') renderQuestions();
    schedulePreview();
  });
  el.querySelector('.win-start').addEventListener('input', e => { w.start = e.target.value; schedulePreview(); });
  el.querySelector('.win-end').addEventListener('input',   e => { w.end   = e.target.value; schedulePreview(); });

  // Delete window
  el.querySelector('.del-btn').addEventListener('click', () => {
    const idx = state.ema.scheduling.windows.indexOf(w);
    if (idx !== -1) state.ema.scheduling.windows.splice(idx, 1);
    if (previewSession === w.id) previewSession = 'onboarding';
    renderWindows();
    if (typeof renderGreetings === 'function') renderGreetings();
    if (typeof renderPreviewTabs === 'function') renderPreviewTabs();
    if (typeof renderQuestions === 'function') renderQuestions();
    schedulePreview();
  });

  // Add step buttons
  el.querySelectorAll('.add-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      if (kind === 'ema') {
        // Determine next block label: if already have a pre, use post; otherwise pre
        const hasPost = w.phase_sequence.some(s => s.kind === 'ema' && s.block === 'post');
        const block = hasPost ? 'pre' : (w.phase_sequence.some(s => s.kind === 'ema' && s.block === 'pre') ? 'post' : 'pre');
        w.phase_sequence.push({ kind: 'ema', block });
      } else if (kind === 'task') {
        const enabledMods = state.modules.filter(m => m.enabled);
        const defaultId = enabledMods.length > 0 ? enabledMods[0].id : null;
        w.phase_sequence.push({ kind: 'task', id: defaultId, condition: null });
      }
      renderStepList(el.querySelector('.step-list'), w);
      syncLegacyPhases(w);
      schedulePreview();
    });
  });

  renderStepList(el.querySelector('.step-list'), w);
  return el;
}

// ---------------------------------------------------------------------------
// renderStepList — renders the ordered step list inside a window card
// ---------------------------------------------------------------------------
function renderStepList(container, w) {
  container.innerHTML = '';
  if (!w.phase_sequence || w.phase_sequence.length === 0) {
    container.innerHTML = '<div style="font-size:0.82rem;color:var(--fg-muted);padding:6px 0;">No steps — add one above.</div>';
    return;
  }

  w.phase_sequence.forEach((step, si) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;';

    const pill = stepPill(step);
    const controls = buildStepControls(step, w, si);

    row.innerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;padding-top:2px;">${pill}</div>`;
    row.appendChild(controls);

    // Up/down + delete buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
    actions.innerHTML = `
      <button class="step-up"   style="width:22px;height:18px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg-muted);cursor:pointer;font-size:10px;line-height:1;">↑</button>
      <button class="step-down" style="width:22px;height:18px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--fg-muted);cursor:pointer;font-size:10px;line-height:1;">↓</button>
      <button class="step-del"  style="width:22px;height:18px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--accent-red);cursor:pointer;font-size:12px;line-height:1;margin-top:2px;">✕</button>
    `;
    actions.querySelector('.step-up').addEventListener('click', () => {
      if (si > 0) { [w.phase_sequence[si-1], w.phase_sequence[si]] = [w.phase_sequence[si], w.phase_sequence[si-1]]; }
      renderStepList(container, w); syncLegacyPhases(w); schedulePreview();
    });
    actions.querySelector('.step-down').addEventListener('click', () => {
      if (si < w.phase_sequence.length - 1) { [w.phase_sequence[si], w.phase_sequence[si+1]] = [w.phase_sequence[si+1], w.phase_sequence[si]]; }
      renderStepList(container, w); syncLegacyPhases(w); schedulePreview();
    });
    actions.querySelector('.step-del').addEventListener('click', () => {
      w.phase_sequence.splice(si, 1);
      renderStepList(container, w); syncLegacyPhases(w); schedulePreview();
    });
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function stepPill(step) {
  if (step.kind === 'ema')  return `<span class="phase-pill phase-pill-pre" style="${step.block==='post'?'background:rgba(154,215,160,0.15);color:#9ad7a0;border-color:rgba(154,215,160,0.3);':''}">${step.block === 'post' ? 'POST' : 'PRE'}</span>`;
  if (step.kind === 'task') return `<span class="phase-pill phase-pill-task">TASK</span>`;
  return `<span class="phase-pill">${step.kind}</span>`;
}

function buildStepControls(step, w, si) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:6px;';

  if (step.kind === 'ema') {
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:0.85rem;outline:none;';
    sel.innerHTML = `<option value="pre" ${step.block==='pre'?'selected':''}>Pre-task EMA</option><option value="post" ${step.block==='post'?'selected':''}>Post-task EMA</option>`;
    sel.addEventListener('change', e => { step.block = e.target.value; syncLegacyPhases(w); schedulePreview(); });
    wrap.appendChild(sel);

  } if (step.kind === 'task') {
    const enabledMods = state.modules.filter(m => m.enabled);
    const taskSel = document.createElement('select');
    taskSel.style.cssText = 'width:100%;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:0.85rem;outline:none;';
    const noMod = enabledMods.length === 0;
    taskSel.innerHTML = (noMod ? '<option value="">— Enable a module in Tasks tab —</option>' : '') +
      enabledMods.map(m => `<option value="${m.id}" ${step.id===m.id?'selected':''}>${escH(m.label)}</option>`).join('');
    taskSel.addEventListener('change', e => { step.id = e.target.value || null; syncLegacyPhases(w); schedulePreview(); });
    wrap.appendChild(taskSel);

    // Condition row
    const condRow = buildConditionRow(step, w);
    wrap.appendChild(condRow);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// buildConditionRow — optional gate condition for task steps
// ---------------------------------------------------------------------------
function buildConditionRow(step, w) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  // Toggle
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
  const hasCondition = !!step.condition;
  toggleRow.innerHTML = `
    <input type="checkbox" class="cond-toggle" ${hasCondition?'checked':''} style="accent-color:var(--accent);cursor:pointer;">
    <span style="font-size:0.78rem;color:var(--fg-muted);">Run conditionally</span>
  `;
  wrap.appendChild(toggleRow);

  const condFields = document.createElement('div');
  condFields.style.cssText = `display:${hasCondition?'flex':'none'};flex-direction:column;gap:4px;margin-top:2px;padding:8px;background:var(--bg-elevated);border-radius:4px;border:1px solid var(--border);`;

  function getQuestionOptions() {
    const allQ = state.ema.questions.filter(q => q.type !== 'page_break' && q.type !== 'checkbox' && q.type !== 'choice' && q.type !== 'affect_grid');
    return allQ.map(q => `<option value="${q.id}" ${step.condition?.question_id===q.id?'selected':''}>${escH(q.text?.slice(0,40)||q.id)}</option>`).join('');
  }

  condFields.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;">
      <label style="font-size:0.75rem;color:var(--fg-muted);flex-shrink:0;">If</label>
      <select class="cond-qid" style="flex:1;min-width:0;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:0.78rem;outline:none;">
        <option value="">— question —</option>
        ${getQuestionOptions()}
      </select>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <select class="cond-op" style="flex:1;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font);font-size:0.78rem;outline:none;">
        <option value="gt"  ${step.condition?.operator==='gt'?'selected':''}>&gt; greater than</option>
        <option value="gte" ${step.condition?.operator==='gte'?'selected':''}>≥ at least</option>
        <option value="lt"  ${step.condition?.operator==='lt'?'selected':''}>&lt; less than</option>
        <option value="lte" ${step.condition?.operator==='lte'?'selected':''}>≤ at most</option>
        <option value="eq"  ${step.condition?.operator==='eq'?'selected':''}>= equals</option>
        <option value="neq" ${step.condition?.operator==='neq'?'selected':''}>≠ not equals</option>
      </select>
      <input type="number" class="cond-val" value="${step.condition?.value??''}" placeholder="value"
        style="width:70px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:var(--font-mono);font-size:0.78rem;outline:none;">
    </div>
    <div style="font-size:0.72rem;color:var(--fg-muted);">Evaluates against the response collected earlier in this session. HR captures report BPM as their value.</div>
  `;
  wrap.appendChild(condFields);

  toggleRow.querySelector('.cond-toggle').addEventListener('change', e => {
    if (e.target.checked) {
      step.condition = { question_id: '', operator: 'gt', value: 0 };
      condFields.style.display = 'flex';
    } else {
      step.condition = null;
      condFields.style.display = 'none';
    }
    schedulePreview();
  });

  condFields.querySelector('.cond-qid').addEventListener('change', e => {
    if (!step.condition) step.condition = { operator: 'gt', value: 0 };
    step.condition.question_id = e.target.value;
    schedulePreview();
  });
  condFields.querySelector('.cond-op').addEventListener('change', e => {
    if (!step.condition) step.condition = { question_id: '', value: 0 };
    step.condition.operator = e.target.value;
    schedulePreview();
  });
  condFields.querySelector('.cond-val').addEventListener('input', e => {
    if (!step.condition) step.condition = { question_id: '', operator: 'gt' };
    step.condition.value = parseFloat(e.target.value) ?? 0;
    schedulePreview();
  });

  return wrap;
}

// ---------------------------------------------------------------------------
// syncLegacyPhases — keep the old phases triple loosely in sync so older
// code paths (e.g. deployment.js phaseLabel) don't crash
// ---------------------------------------------------------------------------
function syncLegacyPhases(w) {
  const seq = w.phase_sequence || [];
  const firstTask = seq.find(s => s.kind === 'task');
  w.phases = {
    pre:  seq.some(s => s.kind === 'ema' && s.block === 'pre'),
    task: firstTask ? firstTask.id : null,
    post: seq.some(s => s.kind === 'ema' && s.block === 'post')
  };
}