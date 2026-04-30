// ==========================================================
// HCT TASK — Heartbeat Counting Task (Schandry, 1981)
// ==========================================================
// Mirrors module-epat.js structure. Reuses ePATCore (BeatDetector,
// WakeLockCtrl, MotionDetector) for identical PPG/quality behavior.
//
// LIFECYCLE (exposed):
//   { startBaseline }  — called by the phase dispatcher in study-base.js
//
// RUNTIME FLOW:
//   1. screen-baseline   — resting HR capture (uses screen-baseline shell)
//   2. screen-onboarding — pre-task instructions (reuses shell, custom content)
//   3. for each interval (with optional practice first):
//        a. screen-hct-counting — count silently for interval duration
//                                 BeatDetector running, SQI watchdog active
//        b. screen-hct-count    — numeric input for reported count
//        c. (optional) confidence slider — reuses screen-onboarding shell
//        d. (optional) body map — reuses screen-bodymap
//   4. consolidate raw entries into a single hct_response envelope
//   5. advancePhase()
//
// DATA SHAPE (final hct_response envelope):
//   {
//     type: 'hct_response',
//     startedAt: ISO,
//     baseline: { recordedHR: [..], totalBeats: N, finalSqi: x, ... },
//     intervals: [
//       {
//         intervalIndex: 0, isPractice: false,
//         duration_sec: 25, durationMs_actual: 25012,   // measured
//         reportedCount: 23, actualBeats: 27,
//         accuracy: 0.852,                              // 1 - |a-r|/a
//         confidence: 6, bodyPos: 1,
//         recordedHR: [72, 71, ...], ibi_series: [810, 795, ...],
//         sqi: 0.012, qualitySummary: { ... },
//         startedAt: ISO, endedAt: ISO,
//       }, ...
//     ],
//     practices: [...],   // same shape, isPractice: true
//     summary: {
//       valid_intervals, practice_intervals,
//       mean_accuracy,            // canonical Schandry score
//       mean_confidence,
//       interoceptive_awareness,  // Pearson r(accuracy, confidence) — null if confidence off or N<3
//       mean_sqi,
//       baseline_beats, baseline_sqi
//     }
//   }
// ==========================================================
const HCT = (function() {
  const core = window.ePATCore;
  const cfg = config.modules?.hct || {};

  // ── Configurable parameters ────────────────────────────────────────────────
  // Schandry's classic intervals are [25, 35, 45, 50, 55, 100]. Reduced default
  // here keeps within-session burden ~2 min. Parsed from the comma-separated
  // string emitted by the builder.
  const DEFAULT_INTERVALS = [25, 35, 45];
  const RAW_INTERVALS     = Array.isArray(cfg.intervals) ? cfg.intervals : DEFAULT_INTERVALS;
  const INTERVALS_SEC     = RAW_INTERVALS.filter(n => Number.isFinite(n) && n >= 5 && n <= 300);

  const RANDOMIZE         = cfg.randomize_order !== false;        // default ON
  const INCLUDE_PRACTICE  = cfg.include_practice !== false;       // default ON
  const PRACTICE_DUR_SEC  = cfg.practice_duration_sec || 15;
  const SHOW_TIMER        = cfg.show_timer === true;              // default OFF (purist)
  const SHOW_PROGRESS_RING= cfg.show_progress_ring !== false;     // default ON (subtle)
  const CONF_RATINGS      = cfg.confidence_ratings !== false;     // default ON
  const BODY_MAP_EVERY    = cfg.body_map ? (cfg.body_map_every || 4) : Infinity;
  const INSTRUCTION_VARIANT = cfg.instruction_variant || 'count'; // 'count' | 'estimate'
  const CUSTOM_INSTRUCTIONS = (cfg.instructions || '').trim();    // overrides default if set
  const RETRY_BUDGET      = cfg.retry_budget || 10;

  // Shared SQI/IBI thresholds — same numbers ePAT uses, so behavior matches.
  const IBI_CHANGE_THRESHOLD = 0.30;
  const SQI_GOOD = 0.008, SQI_WARN = 0.004;

  // ── State ──────────────────────────────────────────────────────────────────
  let baselineTimer = null, baselineBPMs = [], baselineStartTime = 0;
  let isFingerPresent = false, currentSqiValue = 0;
  let lastBeatPerfTime = performance.now(), sensorCheckInterval = null;
  let detectorRunning = false;

  // Interval ordering: practice first (if any), then real intervals (possibly randomized)
  let intervalSchedule = [];
  let currentIntervalIndex = 0;
  let retriesLeft = RETRY_BUDGET;

  // Per-interval running buffers
  let intRecordedHR = [], intIbiSeries = [], intIbiFlags = [];
  let intCleanBeats = 0, intFlaggedBeats = 0, intLastIbi = 0;
  let intSqiTimeSeries = [], intSqiBadSeconds = 0, intLastSqiCheckTime = 0;
  let intStartedAt = null, intStartedPerfMs = 0;
  let intervalTimer = null;
  let intervalRunning = false;

  // ----------------------------------------------------------
  // BUILD INTERVAL SCHEDULE
  // ----------------------------------------------------------
  // Produces e.g. [{dur:15, isPractice:true}, {dur:35, ...}, {dur:25, ...}, ...]
  // Practice intervals are NOT randomized into the main set — they always come
  // first, which mirrors how ePAT handles two_phase_practice.
  function buildSchedule() {
    const real = INTERVALS_SEC.slice();
    if (RANDOMIZE) {
      // Fisher-Yates shuffle
      for (let i = real.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [real[i], real[j]] = [real[j], real[i]];
      }
    }
    const sched = [];
    if (INCLUDE_PRACTICE) sched.push({ duration_sec: PRACTICE_DUR_SEC, isPractice: true });
    real.forEach(d => sched.push({ duration_sec: d, isPractice: false }));
    return sched;
  }

  // ----------------------------------------------------------
  // SENSOR WATCHDOG — copied verbatim from module-epat.js
  // Identical UX with the existing ePAT overlay so participants
  // experience the same warning behavior across tasks.
  // ----------------------------------------------------------
  function startSensorWatchdog() {
    if (sensorCheckInterval) clearInterval(sensorCheckInterval);
    lastBeatPerfTime = performance.now();
    sensorCheckInterval = setInterval(updateSensorWarning, 250);
  }
  function stopSensorWatchdog() {
    if (sensorCheckInterval) clearInterval(sensorCheckInterval);
    const overlay = document.getElementById("sensor-warning-overlay");
    if (overlay) overlay.classList.remove("visible");
  }
  function updateSensorWarning() {
    const overlay = document.getElementById("sensor-warning-overlay");
    const text = document.getElementById("sensor-warning-text");
    const circle = document.getElementById("sensor-preview-circle");
    if (!overlay) return;

    if (!isFingerPresent) {
      overlay.classList.add("visible");
      text.innerHTML = "Place finger on camera<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Cover both lens and flash completely</span>";
      circle.style.borderColor = "var(--fg)"; circle.style.boxShadow = "none";
    } else if (currentSqiValue < SQI_WARN) {
      overlay.classList.add("visible");
      text.innerHTML = "Make the circle red<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Adjust pressure gently until the feed glows solid red</span>";
      circle.style.borderColor = "var(--accent-red)"; circle.style.boxShadow = "0 0 20px rgba(255, 69, 58, 0.3)";
    } else if (performance.now() - lastBeatPerfTime > 2500) {
      overlay.classList.add("visible");
      text.innerHTML = "Acquiring signal…<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Hold completely still</span>";
      circle.style.borderColor = "var(--fg-muted)"; circle.style.boxShadow = "none";
    } else {
      overlay.classList.remove("visible");
    }
  }

  // ----------------------------------------------------------
  // IBI QUALITY TRACKING — same logic as ePAT, but writes into
  // the interval-scoped buffers.
  // ----------------------------------------------------------
  function processIbi(beat) {
    const ibiMs = beat.instantPeriod * 1000;
    intIbiSeries.push(Math.round(ibiMs));
    let flag = null;
    if (intLastIbi > 0) {
      const changeFrac = Math.abs(ibiMs - intLastIbi) / intLastIbi;
      if (changeFrac > IBI_CHANGE_THRESHOLD) {
        flag = { type: 'successive_diff', magnitude: Math.round(changeFrac * 1000) / 10, prevIbi: Math.round(intLastIbi), currentIbi: Math.round(ibiMs) };
        intFlaggedBeats++;
      } else { intCleanBeats++; }
    } else { intCleanBeats++; }
    intLastIbi = ibiMs;
    intIbiFlags.push({ time: beat.time, ibiMs: Math.round(ibiMs * 10) / 10, flag });
  }

  // ----------------------------------------------------------
  // PRE-TASK INSTRUCTIONS — reuses screen-onboarding shell
  // Defaults track Schandry-derived wording. Researcher can override
  // entirely via cfg.instructions, and pick wording variant for the
  // count-vs-estimate methodological distinction.
  // ----------------------------------------------------------
  function showPreTaskInstructions(onContinue) {
    show("screen-onboarding");
    const container = document.getElementById("onboarding-container");
    const nextBtn   = document.getElementById("onboarding-next-btn");

    const variantBody = INSTRUCTION_VARIANT === 'estimate'
      ? `Without taking your pulse or feeling for it, silently <strong>estimate</strong> how many heartbeats you feel during each timed interval. Do not guess based on time elapsed — only count what you actually feel.`
      : `Silently <strong>count</strong> the heartbeats you feel inside your body during each timed interval. Do not take your pulse or feel for it — count only what you can perceive internally.`;

    // CUSTOM_INSTRUCTIONS (if set) replaces variantBody but keeps the camera/setup card.
    const bodyText = CUSTOM_INSTRUCTIONS || variantBody;

    container.innerHTML = `
      <div style="text-align:center; padding: 8px 0 32px;">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:20px;">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <h1 style="margin-bottom:12px;">Heartbeat Counting Task</h1>
        <p style="margin-bottom:24px; text-align:left;">${bodyText}</p>
        <p style="margin-bottom:32px; text-align:left;">Place your fingertip firmly over the
          <strong style="color:var(--fg);">rear camera and flashlight</strong> and keep it there
          for the entire task. Stay still and quiet between intervals.</p>

        <div style="width:100%; max-width:340px; margin: 0 auto 24px; text-align:left;">
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">📷</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Camera + Flashlight</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Cover the lens completely. The circle on screen should glow solid red.</div>
            </div>
          </div>
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">🤚</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Stay still</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Don't take your pulse. Rest your other hand still.</div>
            </div>
          </div>
          <div style="display:flex; align-items:flex-start; gap:14px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">🧠</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Count silently</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">After each interval, you'll be asked to enter your count.</div>
            </div>
          </div>
        </div>
      </div>
    `;

    nextBtn.textContent = "I'm ready →";
    nextBtn.disabled = false;
    nextBtn.onclick = () => {
      nextBtn.onclick = null;
      onContinue();
    };
  }

  // ----------------------------------------------------------
  // BASELINE — identical pattern to ePAT.startBaseline.
  // Uses screen-baseline shell (already in HTML, since needsCore implies it's present).
  // ----------------------------------------------------------
  async function startBaseline() {
    show("screen-baseline");
    baselineBPMs = []; baselineStartTime = Date.now();
    intervalSchedule = buildSchedule();
    currentIntervalIndex = 0;
    retriesLeft = RETRY_BUDGET;

    const bpmEl = document.getElementById("baseline-bpm");
    const progressCircle = document.getElementById("baseline-progress-circle");
    const circ = 2 * Math.PI * 85;
    const DUR = isPreview ? 3 : 60;   // 60s baseline matches ePAT defaults

    if (!core) {
      // Preview / no-core simulation
      let elapsed = 0;
      bpmEl.textContent = '65';
      baselineTimer = setInterval(() => {
        elapsed += 1;
        progressCircle.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / DUR));
        if (elapsed >= DUR) {
          clearInterval(baselineTimer);
          sessionData.data.push({
            type: "hct_baseline", recordedAt: new Date().toISOString(),
            ppgSampleRate: 30, finalSqi: 0.5
          });
          showPreTaskInstructions(() => startInterval());
        }
      }, 1000);
      return;
    }

    await core.WakeLockCtrl.request();
    const videoElement = document.getElementById("video-feed");
    const previewCanvas = document.getElementById("sensor-preview-circle");
    previewCanvas.width = 120 * (window.devicePixelRatio || 1);
    previewCanvas.height = 120 * (window.devicePixelRatio || 1);
    const previewCtx = previewCanvas.getContext("2d");

    startSensorWatchdog();

    await core.BeatDetector.start({
      video: videoElement, canvas: document.getElementById("sampling-canvas"),
      onBeatCb: (beat) => {
        baselineBPMs.push(beat.instantBPM);
        bpmEl.textContent = Math.round(beat.averageBPM);
        lastBeatPerfTime = performance.now();
      },
      onFingerChangeCb: (p) => { isFingerPresent = p; updateSensorWarning(); },
      onSqiUpdateCb: (sqi) => { currentSqiValue = sqi; updateSensorWarning(); },
      onPPGSampleCb: () => {
        if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
          previewCtx.drawImage(videoElement, 0, 0, 120 * (window.devicePixelRatio || 1), 120 * (window.devicePixelRatio || 1));
        }
      }
    });

    baselineTimer = setInterval(async () => {
      const elapsed = (Date.now() - baselineStartTime) / 1000;
      const remaining = Math.max(0, DUR - elapsed);
      progressCircle.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / DUR));

      if (remaining <= 0) {
        clearInterval(baselineTimer); stopSensorWatchdog();
        // Detach baseline-only callbacks but KEEP the detector running so we
        // don't pay another camera cold-start cost between baseline and intervals.
        core.BeatDetector.setCallbacks({ onBeatCb: null, onFingerChangeCb: null, onPPGSampleCb: null, onSqiUpdateCb: null, onDicroticRejectCb: null });
        detectorRunning = true;

        const diagnostics = core.BeatDetector.getDiagnostics();
        const finalSqi = core.BeatDetector.getSqi();

        // Same gate as ePAT: if baseline failed quality, restart silently.
        if (!isPreview && (baselineBPMs.length < 80 || diagnostics.clipRate > 20 || finalSqi < 0.002)) {
          await core.BeatDetector.stop(); detectorRunning = false;
          setTimeout(() => startBaseline(), 4000);
          return;
        }

        sessionData.data.push({
          type: "hct_baseline",
          recordedAt: new Date().toISOString(),
          recordedHR: baselineBPMs.map(Math.round),
          totalBeats: baselineBPMs.length,
          ppgSampleRate: core.BeatDetector.getActualFPS(),
          ppgDiagnostics: diagnostics,
          finalSqi: finalSqi
        });

        showPreTaskInstructions(() => startInterval());
      }
    }, 1000);
  }

  // ----------------------------------------------------------
  // INTERVAL — counting phase. The participant counts silently
  // for `duration_sec`, the BeatDetector tallies the ground-truth
  // beat count, and the SQI watchdog enforces signal quality.
  // ----------------------------------------------------------
  async function startInterval() {
    const item = intervalSchedule[currentIntervalIndex];
    if (!item) { return finishAndAdvance(); }

    show("screen-hct-counting");

    // Reset per-interval buffers
    intRecordedHR = []; intIbiSeries = []; intIbiFlags = [];
    intCleanBeats = 0; intFlaggedBeats = 0; intLastIbi = 0;
    intSqiTimeSeries = []; intSqiBadSeconds = 0; intLastSqiCheckTime = performance.now();
    intStartedAt = new Date().toISOString();
    intStartedPerfMs = performance.now();
    intervalRunning = true;

    // Header label
    const labelEl = document.getElementById("hct-interval-label");
    if (labelEl) {
      const realCount = INTERVALS_SEC.length;
      const realIndex = item.isPractice ? null : currentIntervalIndex - (INCLUDE_PRACTICE ? 1 : 0) + 1;
      labelEl.textContent = item.isPractice
        ? "Practice"
        : `Interval ${realIndex} of ${realCount}`;
    }

    // Optional: clear timer / progress ring text
    const timerEl = document.getElementById("hct-counting-timer");
    if (timerEl) {
      timerEl.style.display = SHOW_TIMER ? "block" : "none";
      timerEl.textContent = "0:00";
    }
    const ringWrap = document.getElementById("hct-counting-ring-wrap");
    if (ringWrap) ringWrap.style.display = SHOW_PROGRESS_RING ? "flex" : "none";

    const ringFill = document.getElementById("hct-counting-progress-circle");
    const circ = 2 * Math.PI * 85;
    if (ringFill) ringFill.style.strokeDashoffset = circ;

    // Hide the early-stop button — Schandry-style, the experimenter (timer) ends the interval,
    // not the participant. We expose an emergency-stop only via a long-press if needed.
    // For now: no participant-facing stop; the timer is authoritative.

    if (!core) {
      // Preview / no-core simulation: simulate ~72 BPM
      const FAKE_BPM = 72;
      const fakeBeats = Math.round((item.duration_sec * FAKE_BPM) / 60);
      const start = Date.now();
      intervalTimer = setInterval(() => {
        const elapsed = (Date.now() - start) / 1000;
        const remaining = Math.max(0, item.duration_sec - elapsed);
        if (timerEl && SHOW_TIMER) {
          const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
          timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        }
        if (ringFill) ringFill.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / item.duration_sec));
        if (remaining <= 0) {
          clearInterval(intervalTimer);
          // Synthesize a recordedHR array so the data shape matches real runs
          for (let i = 0; i < fakeBeats; i++) {
            intRecordedHR.push(FAKE_BPM);
            intIbiSeries.push(Math.round(60000 / FAKE_BPM));
          }
          endInterval(item, fakeBeats);
        }
      }, 250);
      return;
    }

    // Re-attach callbacks for this interval. The detector itself stays
    // running between baseline and intervals (same camera session) so we
    // don't pay another startup cost or risk losing finger contact.
    core.BeatDetector.setCallbacks({
      onBeatCb: (beat) => {
        intRecordedHR.push(beat.instantBPM);
        lastBeatPerfTime = performance.now();
        processIbi(beat);
      },
      onFingerChangeCb: (p) => { isFingerPresent = p; updateSensorWarning(); },
      onSqiUpdateCb: (sqi) => {
        currentSqiValue = sqi;
        const now = performance.now();
        intSqiTimeSeries.push({ t: Math.round(now - intStartedPerfMs), sqi });
        // Track time below WARN as a quality proxy for retry decision
        if (now - intLastSqiCheckTime > 0) {
          if (sqi < SQI_WARN) intSqiBadSeconds += (now - intLastSqiCheckTime) / 1000;
          intLastSqiCheckTime = now;
        }
        updateSensorWarning();
      }
    });

    startSensorWatchdog();
    if (core.MotionDetector) core.MotionDetector.start();

    intervalTimer = setInterval(() => {
      const elapsed = (performance.now() - intStartedPerfMs) / 1000;
      const remaining = Math.max(0, item.duration_sec - elapsed);

      if (timerEl && SHOW_TIMER) {
        const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
        timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      }
      if (ringFill) ringFill.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / item.duration_sec));

      if (remaining <= 0) {
        clearInterval(intervalTimer);
        // Beats counted = number of cleanly accepted beats during this interval.
        // We use the recordedHR length, which is incremented exactly once per
        // accepted beat by the BeatDetector callback.
        const actualBeats = intRecordedHR.length;
        endInterval(item, actualBeats);
      }
    }, 250);
  }

  // ----------------------------------------------------------
  // END INTERVAL — quality gate, then count-entry screen
  // ----------------------------------------------------------
  function endInterval(item, actualBeats) {
    intervalRunning = false;
    stopSensorWatchdog();

    // Quality gate: if the interval was too noisy, count it as a failed attempt
    // and (if budget allows) silently retry. This mirrors how ePAT's retry
    // budget works for trial-quality failures.
    const durationMs = performance.now() - intStartedPerfMs;
    const sqiBadFrac = durationMs > 0 ? (intSqiBadSeconds * 1000) / durationMs : 0;
    const tooNoisy = !isPreview && (actualBeats < 5 || sqiBadFrac > 0.5);

    if (tooNoisy && retriesLeft > 0) {
      retriesLeft--;
      // Don't advance; retry the same interval after a short pause.
      // Show a brief inline message via the sensor overlay.
      const overlay = document.getElementById("sensor-warning-overlay");
      if (overlay) {
        overlay.classList.add("visible");
        const text = document.getElementById("sensor-warning-text");
        if (text) text.innerHTML = "Signal was unclear — retrying interval<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Reposition your finger and stay still</span>";
      }
      setTimeout(() => startInterval(), 3500);
      return;
    }

    // Build a partial entry now; reportedCount and confidence are filled in
    // by the screens that follow.
    const entry = {
      type: 'hct_interval',
      intervalIndex: currentIntervalIndex,
      isPractice: !!item.isPractice,
      duration_sec: item.duration_sec,
      durationMs_actual: Math.round(durationMs),
      startedAt: intStartedAt,
      endedAt: new Date().toISOString(),
      actualBeats,
      reportedCount: null,
      confidence: -1,
      bodyPos: -1,
      recordedHR: intRecordedHR.map(Math.round),
      ibi_series: intIbiSeries.slice(),
      qualitySummary: {
        cleanBeats: intCleanBeats,
        flaggedBeats: intFlaggedBeats,
        sqiBadSeconds: +intSqiBadSeconds.toFixed(2),
        sqiTimeSeries: intSqiTimeSeries.slice(),
        sqiFinalValue: currentSqiValue
      }
    };

    showCountEntry(entry, item);
  }

  // ----------------------------------------------------------
  // COUNT ENTRY — numeric input for participant's reported count
  // ----------------------------------------------------------
  function showCountEntry(entry, item) {
    show("screen-hct-count");
    const input = document.getElementById("hct-count-input");
    const submitBtn = document.getElementById("hct-count-submit");
    const labelEl = document.getElementById("hct-count-label");

    if (labelEl) {
      labelEl.textContent = item.isPractice
        ? "Practice complete"
        : `Interval complete (${item.duration_sec}s)`;
    }

    input.value = "";
    submitBtn.disabled = true;
    setTimeout(() => input.focus(), 50);

    input.oninput = () => {
      const n = parseInt(input.value, 10);
      submitBtn.disabled = !(Number.isFinite(n) && n >= 0 && n <= 999);
    };

    submitBtn.onclick = () => {
      submitBtn.onclick = null;
      input.oninput = null;
      const reported = parseInt(input.value, 10);
      entry.reportedCount = Number.isFinite(reported) ? reported : null;
      // Standard Schandry accuracy formula. Undefined when actualBeats is 0.
      entry.accuracy = (entry.actualBeats > 0 && entry.reportedCount !== null)
        ? +(1 - Math.abs(entry.actualBeats - entry.reportedCount) / entry.actualBeats).toFixed(4)
        : null;

      if (CONF_RATINGS && !item.isPractice) {
        showConfidence(entry, item);
      } else {
        afterConfidence(entry, item);
      }
    };
  }

  // ----------------------------------------------------------
  // CONFIDENCE — reuses screen-onboarding shell, same widget pattern as ePAT
  // 0–10 slider. Skipped for practice intervals.
  // ----------------------------------------------------------
  function showConfidence(entry, item) {
    show("screen-onboarding");
    const container = document.getElementById("onboarding-container");
    const nextBtn = document.getElementById("onboarding-next-btn");

    container.innerHTML = `
      <div style="text-align:center; padding:8px 0 32px;">
        <h1 style="margin-bottom:12px;">Confidence</h1>
        <p style="margin-bottom:32px;">How confident are you in your count for this interval?</p>
        <div style="font-size:3rem; font-weight:700; color:var(--accent); margin-bottom:8px;" id="hct-conf-val">5</div>
        <input type="range" id="hct-conf-slider" min="0" max="10" step="1" value="5" style="width:100%; max-width:340px;">
        <div style="display:flex; justify-content:space-between; max-width:340px; margin:6px auto 0; font-size:0.8rem; color:var(--fg-muted);">
          <span>Total guess</span><span>Completely confident</span>
        </div>
      </div>
    `;
    const sl = document.getElementById("hct-conf-slider");
    const vd = document.getElementById("hct-conf-val");
    nextBtn.textContent = "Submit";
    nextBtn.disabled = false;
    sl.oninput = () => { vd.textContent = sl.value; };
    nextBtn.onclick = () => {
      nextBtn.onclick = null;
      sl.oninput = null;
      entry.confidence = parseInt(sl.value, 10);
      afterConfidence(entry, item);
    };
  }

  // ----------------------------------------------------------
  // BODY MAP — reuses screen-bodymap, same wiring as ePAT
  // Skipped for practice intervals.
  // ----------------------------------------------------------
  function afterConfidence(entry, item) {
    const realIndex = item.isPractice ? -1 : (currentIntervalIndex - (INCLUDE_PRACTICE ? 1 : 0));
    const showBodyMap = !item.isPractice && (realIndex + 1) % BODY_MAP_EVERY === 0;

    if (showBodyMap) {
      show("screen-bodymap");
      const parts = document.querySelectorAll(".body-part");
      const nowhereBtn = document.getElementById("nowhere-btn");
      const confirmBtn = document.getElementById("confirm-bodymap-btn");
      let sel = -1;
      confirmBtn.disabled = true;
      parts.forEach(p => {
        p.classList.remove("selected");
        p.onclick = () => {
          parts.forEach(pp => pp.classList.remove("selected"));
          if (nowhereBtn) nowhereBtn.classList.remove("selected");
          p.classList.add("selected");
          sel = parseInt(p.dataset.value, 10);
          confirmBtn.disabled = false;
        };
      });
      if (nowhereBtn) {
        nowhereBtn.classList.remove("selected");
        nowhereBtn.onclick = () => {
          parts.forEach(pp => pp.classList.remove("selected"));
          nowhereBtn.classList.add("selected");
          sel = 8;
          confirmBtn.disabled = false;
        };
      }
      confirmBtn.onclick = () => {
        confirmBtn.onclick = null;
        entry.bodyPos = sel;
        sessionData.data.push(entry);
        nextInterval();
      };
    } else {
      sessionData.data.push(entry);
      nextInterval();
    }
  }

  function nextInterval() {
    currentIntervalIndex++;
    if (currentIntervalIndex >= intervalSchedule.length) {
      finishAndAdvance();
    } else {
      // Pre-interval breathing room: 2s pause before next counting begins.
      // Show the onboarding shell with a brief "Get ready" message.
      show("screen-onboarding");
      const container = document.getElementById("onboarding-container");
      const nextBtn = document.getElementById("onboarding-next-btn");
      const next = intervalSchedule[currentIntervalIndex];
      container.innerHTML = `
        <div style="text-align:center; padding:48px 0;">
          <h1 style="margin-bottom:16px;">Get Ready</h1>
          <p>Next interval: <strong style="color:var(--fg);">${next.duration_sec} seconds</strong></p>
          <p style="margin-top:8px; color:var(--fg-muted); font-size:0.9rem;">Keep your finger on the camera. Begin counting when you tap below.</p>
        </div>
      `;
      nextBtn.textContent = "Start counting →";
      nextBtn.disabled = false;
      nextBtn.onclick = () => {
        nextBtn.onclick = null;
        startInterval();
      };
    }
  }

  // ----------------------------------------------------------
  // CONSOLIDATE & ADVANCE
  // Same envelope-splice pattern as ePAT — pull raw entries, build a
  // single hct_response, splice it back in at the original index.
  // ----------------------------------------------------------
  async function finishAndAdvance() {
    if (core) {
      detectorRunning = false;
      try { await core.BeatDetector.stop(); } catch(e) {}
      try { core.WakeLockCtrl.release(); } catch(e) {}
    }
    stopSensorWatchdog();

    const rawEntries = sessionData.data.filter(e =>
      e && (e.type === 'hct_baseline' || e.type === 'hct_interval')
    );
    const baseline = rawEntries.find(e => e.type === 'hct_baseline') || null;
    const intervalObjs = rawEntries.filter(e => e.type === 'hct_interval' && !e.isPractice);
    const practiceObjs = rawEntries.filter(e => e.type === 'hct_interval' &&  e.isPractice);

    // Pearson r between accuracy and confidence (Garfinkel's interoceptive
    // awareness metric). Returns null if confidence ratings disabled, or
    // fewer than 3 valid pairs (correlation undefined / unstable).
    function pearson(xs, ys) {
      if (xs.length < 3) return null;
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) {
        const a = xs[i] - mx, b = ys[i] - my;
        num += a * b; dx += a * a; dy += b * b;
      }
      const den = Math.sqrt(dx * dy);
      return den > 0 ? +(num / den).toFixed(4) : null;
    }

    // Summary calculations
    const accArr = intervalObjs.map(e => e.accuracy).filter(v => typeof v === 'number');
    const confArr = intervalObjs.map(e => e.confidence).filter(v => typeof v === 'number' && v >= 0);

    // For interoceptive awareness, we need PAIRED (accuracy, confidence) values.
    const pairs = intervalObjs
      .filter(e => typeof e.accuracy === 'number' && typeof e.confidence === 'number' && e.confidence >= 0)
      .map(e => [e.accuracy, e.confidence]);

    const sqiArr = intervalObjs.map(e => e.qualitySummary?.sqiFinalValue).filter(v => typeof v === 'number');

    const summary = {
      valid_intervals:         intervalObjs.length,
      practice_intervals:      practiceObjs.length,
      mean_accuracy:           accArr.length  ? +(accArr.reduce((a, b) => a + b, 0) / accArr.length).toFixed(4) : null,
      mean_confidence:         confArr.length ? +(confArr.reduce((a, b) => a + b, 0) / confArr.length).toFixed(2) : null,
      interoceptive_awareness: (CONF_RATINGS && pairs.length >= 3) ? pearson(pairs.map(p => p[0]), pairs.map(p => p[1])) : null,
      mean_sqi:                sqiArr.length ? +(sqiArr.reduce((a, b) => a + b, 0) / sqiArr.length).toFixed(4) : null,
      baseline_beats:          baseline?.totalBeats ?? null,
      baseline_sqi:            baseline?.finalSqi   ?? null,
      instruction_variant:     INSTRUCTION_VARIANT,
      randomized:              RANDOMIZE,
      intervals_sec:           INTERVALS_SEC.slice()
    };

    const hctEntry = {
      type: 'hct_response',
      startedAt: baseline?.recordedAt ?? (intervalObjs[0]?.startedAt) ?? null,
      intervals: intervalObjs,
      practices: practiceObjs,
      baseline: baseline,
      summary
    };

    // Splice in at the position of the first raw entry, preserving order
    // relative to surrounding ema_response blocks.
    const firstRawIdx = sessionData.data.findIndex(e =>
      e && (e.type === 'hct_baseline' || e.type === 'hct_interval')
    );
    sessionData.data = sessionData.data.filter(e =>
      e && e.type !== 'hct_baseline' && e.type !== 'hct_interval'
    );
    if (firstRawIdx >= 0 && firstRawIdx <= sessionData.data.length) {
      sessionData.data.splice(firstRawIdx, 0, hctEntry);
    } else {
      sessionData.data.push(hctEntry);
    }

    advancePhase();
  }

  return { startBaseline };
})();