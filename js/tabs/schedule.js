function bindScheduleTab() {
  const bindNum = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { setter(parseInt(el.value)||0); schedulePreview(); });
  };
  bindNum('study-days', v => state.ema.scheduling.study_days = v);
  bindNum('daily-prompts', v => state.ema.scheduling.daily_prompts = v);
  bindNum('window-expiry', v => state.ema.scheduling.timing.expiry_minutes = v);
  bindNum('grace-period', v => state.ema.scheduling.timing.grace_minutes = v);

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
    state.ema.scheduling.windows.push({ id: wId, label: `Window ${state.ema.scheduling.windows.length + 1}`, start: "12:00", end: "13:00" });
    renderWindows();
    if(typeof renderGreetings === 'function') renderGreetings();
    if(typeof renderPreviewTabs === 'function') renderPreviewTabs();
    schedulePreview();
  });
}

function renderWindows() {
  const list = document.getElementById('window-list');
  list.innerHTML = '';
  state.ema.scheduling.windows.forEach((w, i) => {
    const el = document.createElement('div');
    el.className = 'window-item drag-item';
    
    // Add structural inline styles to ensure the grid/flex layout doesn't break
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.gap = '16px';
    el.style.background = 'var(--bg-surface)';
    el.style.padding = '16px';
    el.style.border = '1px solid var(--border)';
    el.style.borderRadius = 'var(--radius)';
    el.style.marginBottom = '12px';

    el.innerHTML = `
      <div class="drag-handle" style="cursor:grab; color:var(--fg-muted); font-weight:bold; padding-right:8px;">⋮⋮</div>
      <div class="window-content" style="flex:1; display:flex; flex-direction:column; gap:10px;">
        <input type="text" class="win-label" value="${escH(w.label)}" style="width:100%; padding:10px 12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--fg); font-family:var(--font); font-size:1rem; outline:none;">
        <div style="display:flex; gap:12px; align-items:center;">
          <input type="time" class="win-start" value="${w.start}" style="flex:1; padding:10px 12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--fg); font-family:var(--font-mono); font-size:0.95rem; outline:none;">
          <span style="color:var(--fg-muted); font-size:0.9rem; font-weight:500;">to</span>
          <input type="time" class="win-end" value="${w.end}" style="flex:1; padding:10px 12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--fg); font-family:var(--font-mono); font-size:0.95rem; outline:none;">
        </div>
      </div>
      <button class="icon-btn del-btn" title="Remove window" style="background:none; border:none; color:var(--accent-red); font-size:1.4rem; cursor:pointer; padding:8px; opacity:0.7; transition:opacity 0.2s;">✕</button>
    `;
    
    // Hover effect for the delete button
    el.querySelector('.del-btn').addEventListener('mouseover', e => e.target.style.opacity = '1');
    el.querySelector('.del-btn').addEventListener('mouseout', e => e.target.style.opacity = '0.7');

    el.querySelector('.win-label').addEventListener('input', e => { 
      w.label = e.target.value; 
      if(typeof renderGreetings === 'function') renderGreetings();
      if(typeof renderPreviewTabs === 'function') renderPreviewTabs();
      schedulePreview(); 
    });
    el.querySelector('.win-start').addEventListener('input', e => { w.start = e.target.value; schedulePreview(); });
    el.querySelector('.win-end').addEventListener('input', e => { w.end = e.target.value; schedulePreview(); });
    
    el.querySelector('.del-btn').addEventListener('click', () => {
      state.ema.scheduling.windows.splice(i, 1);
      // Fallback preview session if we delete the active one
      if (previewSession === w.id) previewSession = 'onboarding';
      renderWindows();
      if(typeof renderGreetings === 'function') renderGreetings();
      if(typeof renderPreviewTabs === 'function') renderPreviewTabs();
      schedulePreview();
    });
    list.appendChild(el);
  });
}