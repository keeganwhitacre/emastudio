function schedulePreview() {
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(renderPreview, 200);
}

async function renderPreview() {
  const iframe = document.getElementById('preview-iframe');
  iframe.srcdoc = await buildStudyHtml({ configInline: true, previewMode: true, previewSession });
}

document.getElementById('preview-session-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.preview-session-tab');
  if (!tab) return;
  previewSession = tab.dataset.session;
  document.querySelectorAll('.preview-session-tab').forEach(t => t.classList.toggle('active', t.dataset.session === previewSession));
  renderPreview();
});

document.getElementById('preview-reset-btn').addEventListener('click', () => renderPreview());
