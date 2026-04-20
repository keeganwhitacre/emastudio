function schedulePreview() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(renderPreview, 600);
    const status = document.getElementById('save-status');
    if (status) status.textContent = 'Unsaved changes';
    // Tell storage to persist shortly after the preview updates.
    if (typeof StorageManager !== 'undefined' && StorageManager.debouncedSave) {
      StorageManager.debouncedSave();
    }
  }

function renderPreviewTabs() {
  const container = document.getElementById('preview-session-tabs');
  if (!container) return;
  container.innerHTML = '';

  // Add Onboarding Tab if enabled
  if (state.onboarding.enabled) {
    const obBtn = document.createElement('button');
    obBtn.className = `preview-session-tab ${previewSession === 'onboarding' ? 'active' : ''}`;
    obBtn.dataset.session = 'onboarding';
    obBtn.textContent = 'Setup';
    container.appendChild(obBtn);
  }

  // Add Tabs for every defined window in the schedule
  state.ema.scheduling.windows.forEach(w => {
    // If current previewSession isn't valid anymore, fallback to the first window
    if (previewSession !== 'onboarding' && !state.ema.scheduling.windows.find(win => win.id === previewSession)) {
       previewSession = w.id;
    }
    const btn = document.createElement('button');
    btn.className = `preview-session-tab ${previewSession === w.id ? 'active' : ''}`;
    btn.dataset.session = w.id;
    // Map window label to a short tab name
    btn.textContent = w.label.split(' ')[0];
    container.appendChild(btn);
  });

  // Re-bind click events
  document.querySelectorAll('.preview-session-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preview-session-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      previewSession = btn.dataset.session;
      renderPreview();
    });
  });
}

async function renderPreview() {
  if (!window.buildStudyHtml) return;
  
  // Re-build tabs if windows changed
  if (document.querySelectorAll('.preview-session-tab').length !== (state.onboarding.enabled ? 1 : 0) + state.ema.scheduling.windows.length) {
      renderPreviewTabs();
  }

  try {
    const html = await buildStudyHtml({ configInline: true, previewMode: true, previewSession });
    const iframe = document.getElementById('preview-iframe');
    if (iframe) {
      iframe.srcdoc = html;
    }
  } catch(e) {
    console.error("Preview render failed:", e);
  }
}

document.getElementById('preview-reset-btn').addEventListener('click', renderPreview);