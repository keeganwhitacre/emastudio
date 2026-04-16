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
  bind('greeting-morning', v => state.study.greetings.morning = v);
  bind('greeting-afternoon', v => state.study.greetings.afternoon = v);
  bind('greeting-evening', v => state.study.greetings.evening = v);

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
