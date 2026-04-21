// ==========================================================
// HR CAPTURE MODULE — v1.0
// ==========================================================
// Handles phase tokens of the form "hr:<store_as>:<duration_sec>".
// Uses ePATCore.BeatDetector (requires ePAT module to be enabled, which
// ensures the core is loaded). If ePATCore is unavailable, skips gracefully.
//
// Screen used: screen-hr-capture (defined in export.js buildHtmlShell)
// Data emitted to sessionData.data:
//   {
//     type:        "hr_capture",
//     question_id: store_as,     ← the ID referenced in task conditions
//     bpm:         78.4,         ← average BPM over capture window
//     sqi:         0.042,
//     ibi_series:  [823, 756, ...],
//     duration_ms: 30000,
//     capturedAt:  "2026-..."
//   }
// ==========================================================

const HRCapture = (function() {
  const core = window.ePATCore;

  function start(storeAs, durationSec) {
    if (!core) {
      // No ePATCore — record a null result and advance
      sessionData.data.push({
        type: 'hr_capture', question_id: storeAs,
        bpm: null, sqi: null, ibi_series: [],
        duration_ms: durationSec * 1000, capturedAt: new Date().toISOString(),
        skipped: true, reason: 'ePATCore unavailable'
      });
      advancePhase();
      return;
    }

    show('screen-hr-capture');

    const titleEl    = document.getElementById('hr-capture-title');
    const subtitleEl = document.getElementById('hr-capture-subtitle');
    const bpmEl      = document.getElementById('hr-capture-bpm');
    const ringFill   = document.getElementById('hr-capture-ring-fill');
    const overlayEl  = document.getElementById('hr-capture-sensor-overlay');
    const overlayMsg = document.getElementById('hr-capture-overlay-msg');
    const videoEl    = document.getElementById('video-feed');
    const canvasEl   = document.getElementById('sampling-canvas');
    const previewEl  = document.getElementById('hr-capture-preview');

    if (titleEl) titleEl.textContent = 'Heart Rate';
    if (subtitleEl) subtitleEl.textContent = `Measuring for ${durationSec} seconds`;

    const circ = 2 * Math.PI * 85;
    if (ringFill) ringFill.style.strokeDashoffset = String(circ);

    const startMs  = Date.now();
    const bpms     = [];
    const ibiSeries = [];
    let timerInterval = null;
    let isFingerPresent = false, currentSqi = 0;

    // Setup preview canvas
    let previewCtx = null;
    if (previewEl) {
      const dpr = window.devicePixelRatio || 1;
      previewEl.width  = 120 * dpr;
      previewEl.height = 120 * dpr;
      previewCtx = previewEl.getContext('2d');
    }

    function updateOverlay() {
      if (!overlayEl) return;
      if (!isFingerPresent) {
        overlayEl.classList.add('visible');
        if (overlayMsg) overlayMsg.innerHTML = "Place finger on camera<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Cover both lens and flash completely</span>";
      } else {
        overlayEl.classList.remove('visible');
      }
    }

    function finish() {
      clearInterval(timerInterval);
      core.BeatDetector.setCallbacks({ onBeatCb: null, onFingerChangeCb: null, onSqiUpdateCb: null, onPPGSampleCb: null });
      core.BeatDetector.stop().then(() => {
        const avgBpm = bpms.length > 0
          ? Math.round((bpms.reduce((a,b) => a+b, 0) / bpms.length) * 10) / 10
          : null;
        sessionData.data.push({
          type:        'hr_capture',
          question_id: storeAs,
          bpm:         avgBpm,
          sqi:         Math.round(currentSqi * 100000) / 100000,
          ibi_series:  [...ibiSeries],
          duration_ms: Date.now() - startMs,
          capturedAt:  new Date().toISOString()
        });
        if (overlayEl) overlayEl.classList.remove('visible');
        advancePhase();
      });
    }

    timerInterval = setInterval(() => {
      const elapsed = (Date.now() - startMs) / 1000;
      const remaining = Math.max(0, durationSec - elapsed);
      if (subtitleEl) subtitleEl.textContent = `${Math.ceil(remaining)}s remaining`;
      if (ringFill) ringFill.style.strokeDashoffset = String(circ * (1 - Math.min(1, elapsed / durationSec)));
      if (remaining <= 0) finish();
    }, 250);

    core.WakeLockCtrl.request().catch(() => {});

    core.BeatDetector.start({
      video:  videoEl,
      canvas: canvasEl,
      onBeatCb: (beat) => {
        bpms.push(beat.averageBPM);
        ibiSeries.push(Math.round(beat.instantPeriod * 1000));
        if (bpmEl) bpmEl.textContent = Math.round(beat.averageBPM);
      },
      onFingerChangeCb: (present) => {
        isFingerPresent = present;
        updateOverlay();
      },
      onSqiUpdateCb: (sqi) => { currentSqi = sqi; },
      onPPGSampleCb: () => {
        if (videoEl && videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && previewCtx) {
          const dpr = window.devicePixelRatio || 1;
          previewCtx.drawImage(videoEl, 0, 0, 120 * dpr, 120 * dpr);
        }
      }
    }).catch(err => {
      console.error('HRCapture BeatDetector start failed:', err);
      clearInterval(timerInterval);
      sessionData.data.push({
        type: 'hr_capture', question_id: storeAs,
        bpm: null, sqi: null, ibi_series: [],
        duration_ms: 0, capturedAt: new Date().toISOString(),
        skipped: true, reason: String(err)
      });
      advancePhase();
    });

    updateOverlay();
  }

  return { start };
})();