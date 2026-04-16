// Tab Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.config-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

function bindStudyTab() {
  const bind = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { setter(el.value); schedulePreview(); });
  };
  bind('study-name', v => state.study.name = v);
  bind('institution', v => state.study.institution = v);

  const themeEl = document.getElementById('study-theme');
  if (themeEl) {
    themeEl.value = state.study.theme;
    themeEl.addEventListener('change', e => {
      state.study.theme = e.target.value;
      schedulePreview();
    });
  }

  document.getElementById('accent-color').addEventListener('input', e => {
    state.study.accent_color = e.target.value;
    document.getElementById('color-preview-swatch').style.background = e.target.value;
    schedulePreview();
  });
  document.getElementById('color-preview-swatch').style.background = state.study.accent_color;

  document.getElementById('format-ctrl').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.study.output_format = btn.dataset.fmt;
    document.querySelectorAll('#format-ctrl .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === btn.dataset.fmt));
    document.getElementById('format-hint').textContent = btn.dataset.fmt === 'json'
      ? 'Each submission downloads a .json file. One file per session per participant.'
      : 'Each submission downloads a .csv with one row per question. Easy to concatenate across participants.';
  });
}

// Dynamically generate greeting inputs based on schedule windows
function renderGreetings() {
  const list = document.getElementById('dynamic-greetings-list');
  if (!list) return;
  list.innerHTML = '';
  
  if (!state.study.greetings) state.study.greetings = {};

  state.ema.scheduling.windows.forEach(w => {
    // Ensure state exists for this window
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
    
    row.querySelector('.greeting-input').addEventListener('input', (e) => {
      state.study.greetings[w.id] = e.target.value;
      schedulePreview();
    });

    list.appendChild(row);
  });
}