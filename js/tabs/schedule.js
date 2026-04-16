function bindScheduleTab() {
  const bindNum = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => setter(parseInt(el.value)||0));
  };
  bindNum('study-days', v => state.ema.scheduling.study_days = v);
  bindNum('daily-prompts', v => state.ema.scheduling.daily_prompts = v);
  bindNum('window-expiry', v => state.ema.scheduling.timing.expiry_minutes = v);
  bindNum('grace-period', v => state.ema.scheduling.timing.grace_minutes = v);

  document.getElementById('dow-grid').addEventListener('click', e => {
    const chip = e.target.closest('.dow-chip');
    if (!chip) return;
    const dow = parseInt(chip.dataset.dow);
    const idx = state.ema.scheduling.days_of_week.indexOf(dow);
    if (idx >= 0) state.ema.scheduling.days_of_week.splice(idx, 1);
    else state.ema.scheduling.days_of_week.push(dow);
    state.ema.scheduling.days_of_week.sort();
    chip.classList.toggle('on', idx < 0);
  });

  document.getElementById('add-window-btn').addEventListener('click', () => {
    state.ema.scheduling.windows.push({ id: genWId(), label: 'New Window', start: '09:00', end: '11:00' });
    renderWindows();
  });
}

function renderWindows() {
  const list = document.getElementById('window-list');
  list.innerHTML = '';
  state.ema.scheduling.windows.forEach(w => {
    const row = document.createElement('div');
    row.className = 'window-row';
    row.innerHTML = `
      <input type="text" class="wlabel" value="${escH(w.label)}" placeholder="Label">
      <input type="time" class="wstart" value="${w.start}">
      <span class="window-sep">–</span>
      <input type="time" class="wend" value="${w.end}">
      <button class="window-del" title="Remove">×</button>
    `;
    row.querySelector('.wlabel').addEventListener('input', e => { w.label = e.target.value; });
    row.querySelector('.wstart').addEventListener('input', e => { w.start = e.target.value; });
    row.querySelector('.wend').addEventListener('input', e => { w.end = e.target.value; });
    row.querySelector('.window-del').addEventListener('click', () => {
      state.ema.scheduling.windows = state.ema.scheduling.windows.filter(x => x.id !== w.id);
      renderWindows();
    });
    list.appendChild(row);
  });
}
