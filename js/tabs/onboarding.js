function bindOnboardingTab() {
  const toggle = document.getElementById('ob-toggle');
  const schedToggle = document.getElementById('ob-schedule-toggle');
  const settings = document.getElementById('ob-settings');
  const textInput = document.getElementById('ob-consent-text');

  if (toggle) {
    toggle.checked = state.onboarding.enabled;
    settings.style.display = state.onboarding.enabled ? 'block' : 'none';
    
    toggle.addEventListener('change', e => {
      state.onboarding.enabled = e.target.checked;
      settings.style.display = state.onboarding.enabled ? 'block' : 'none';
      if (typeof renderPreviewTabs === 'function') renderPreviewTabs();
      schedulePreview();
    });
  }

  if (schedToggle) {
    schedToggle.checked = state.onboarding.ask_schedule !== false; // Default true
    schedToggle.addEventListener('change', e => {
      state.onboarding.ask_schedule = e.target.checked;
      schedulePreview();
    });
  }

  if (textInput) {
    textInput.value = state.onboarding.consent_text;
    textInput.addEventListener('input', e => {
      state.onboarding.consent_text = e.target.value;
      schedulePreview();
    });
  }
}