function bindTasksTab() {
  document.getElementById('pat-toggle').addEventListener('change', e => {
    state.pat.enabled = e.target.checked;
    document.getElementById('pat-card').classList.toggle('enabled', state.pat.enabled);
    document.getElementById('pat-settings').classList.toggle('hidden', !state.pat.enabled);
    schedulePreview();
  });

  const bindNum = (id, setter) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => setter(parseFloat(el.value)||0));
  };
  bindNum('pat-trials',    v => state.pat.trials = v);
  bindNum('pat-trial-dur', v => state.pat.trial_duration_sec = v);
  bindNum('pat-retries',   v => state.pat.retry_budget = v);
  bindNum('pat-sqi',       v => state.pat.sqi_threshold = v);

  document.getElementById('pat-conf').addEventListener('change', e => state.pat.confidence_ratings = e.target.checked);
  document.getElementById('pat-practice').addEventListener('change', e => state.pat.two_phase_practice = e.target.checked);
}
