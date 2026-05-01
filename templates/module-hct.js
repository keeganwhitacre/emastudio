// ==========================================================
// HCT TASK — Heartbeat Counting Task (Schandry, 1981)
// ==========================================================
// v2 — restructured flow. See bottom of file for changelog vs. v1.
//
// LIFECYCLE (exposed):
//   { startBaseline }  — name preserved for compatibility with the phase
//                        dispatcher in study-base.js. Despite the name there
//                        is no longer any baseline HR capture; the function
//                        kicks off the full HCT flow.
//
// RUNTIME FLOW:
//   1. screen-onboarding         — instructions (camera off, just reading)
//   2. screen-hct-sensor-check   — finger placement verification (no BPM shown)
//                                  Camera on. Once finger detected and SQI
//                                  is good for 2 consecutive 1-second checks,
//                                  participant taps "Start counting" and the
//                                  first interval begins.
//   3. for each interval (with optional practice first):
//        a. screen-hct-counting  — count silently for interval duration
//                                  BeatDetector running in background, SQI
//                                  watchdog active. NO BPM EVER DISPLAYED.
//        b. screen-hct-count     — numeric input for reported count
//        c. (optional) confidence slider — reuses screen-onboarding shell
//        d. (optional) body map  — reuses screen-bodymap
//   4. consolidate raw entries into a single hct_response envelope
//   5. advancePhase()
//
// METHODOLOGICAL NOTES:
//   - No pre-task BPM display. Showing participants their HR before a
//     counting task biases their estimates toward correct arithmetic
//     rather than interoception (Brener & Ring, 2018; Desmedt et al.,
//     2018). The sensor-check screen verifies finger placement and signal
//     quality but never surfaces the BPM number.
//   - No baseline HR collection in this module. If a study needs HR
//     alongside HCT, run it in a separate session, OR include a
//     heart_rate EMA question with display_bpm: false (added in v2 of
//     module-ema.js — see that module for the per-question option).
//   - The detector keeps running between sensor check and the first
//     counting interval, just like before — no camera cold-start cost
//     between the two phases.
// ==========================================================
const HCT = (function() {
  const core = window.ePATCore;
  const cfg = config.modules?.hct || {};

  // ── Configurable parameters ────────────────────────────────────────────────
  const DEFAULT_INTERVALS = [25, 35, 45];
  const RAW_INTERVALS     = Array.isArray(cfg.intervals) ? cfg.intervals : DEFAULT_INTERVALS;
  const INTERVALS_SEC     = RAW_INTERVALS.filter(n => Number.isFinite(n) && n >= 5 && n <= 300);

  const RANDOMIZE         = cfg.randomize_order !== false;        // default ON
  const INCLUDE_PRACTICE  = cfg.include_practice !== false;       // default ON
  const PRACTICE_DUR_SEC  = cfg.practice_duration_sec || 15;
  const SHOW_TIMER        = cfg.show_timer === true;              // default OFF
  const SHOW_PROGRESS_RING= cfg.show_progress_ring !== false;     // default ON
  const CONF_RATINGS      = cfg.confidence_ratings !== false;     // default ON
  const BODY_MAP_EVERY    = cfg.body_map ? (cfg.body_map_every || 4) : Infinity;
  const INSTRUCTION_VARIANT = cfg.instruction_variant || 'count'; // 'count' | 'estimate'
  const CUSTOM_INSTRUCTIONS = (cfg.instructions || '').trim();
  const RETRY_BUDGET      = cfg.retry_budget || 10;

  // Sensor-check parameters. The "ready to start" gate fires when SQI on the
  // active channel exceeds SENSOR_CHECK_SQI_FLOOR for SENSOR_CHECK_GOOD_SECS
  // consecutive seconds. The hard timeout is a safety net; if a participant
  // simply cannot get a clean signal in MAX_SENSOR_CHECK_SEC seconds we let
  // them proceed anyway and let the per-interval retry budget handle quality
  // failures downstream.
  const SENSOR_CHECK_SQI_FLOOR = 0.004;  // matches SQI_WARN in epat-core
  const SENSOR_CHECK_GOOD_SECS = 2;      // 2 consecutive good seconds → ready
  const MAX_SENSOR_CHECK_SEC   = 30;

  // Shared SQI/IBI thresholds (same as ePAT/v5 core)
  const IBI_CHANGE_THRESHOLD = 0.30;
  const SQI_GOOD = 0.008, SQI_WARN = 0.004;

  // ── State ──────────────────────────────────────────────────────────────────
  let isFingerPresent = false, currentSqiValue = 0;
  let lastBeatPerfTime = performance.now(), sensorCheckInterval = null;
  let detectorRunning = false;

  // Sensor-check state
  let sensorCheckTimer = null;
  let sensorCheckGoodSecs = 0;
  let sensorCheckStartTime = 0;
  let sensorCheckResolve = null;

  // Interval ordering and per-interval buffers
  let intervalSchedule = [];
  let currentIntervalIndex = 0;
  let retriesLeft = RETRY_BUDGET;

  let intRecordedHR = [], intIbiSeries = [], intIbiFlags = [];
  let intCleanBeats = 0, intFlaggedBeats = 0, intLastIbi = 0;
  let intSqiTimeSeries = [], intSqiBadSeconds = 0, intLastSqiCheckTime = 0;
  let intStartedAt = null, intStartedPerfMs = 0;
  let intervalTimer = null;
  let intervalRunning = false;

  // ----------------------------------------------------------
  // BUILD INTERVAL SCHEDULE
  // Practice intervals are NOT randomized into the main set — they always
  // come first, mirroring how ePAT handles two_phase_practice.
  // ----------------------------------------------------------
  function buildSchedule() {
    const real = INTERVALS_SEC.slice();
    if (RANDOMIZE) {
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
  // SENSOR WATCHDOG — same as before (verbatim from v1).
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
  // IBI QUALITY TRACKING — unchanged from v1.
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
  // ENTRY POINT — exposed as startBaseline() for compatibility with the
  // phase dispatcher, but no baseline is captured. Just wires up the
  // schedule and shows instructions.
  // ----------------------------------------------------------
  async function startTask() {
    intervalSchedule = buildSchedule();
    currentIntervalIndex = 0;
    retriesLeft = RETRY_BUDGET;

    // Step 1: instructions screen. Camera is off — participant just reads.
    showPreTaskInstructions(() => {
      // Step 2: sensor check. Camera turns on here, not before.
      runSensorCheck().then(() => {
        // Step 3: first interval (practice if enabled, else real).
        startInterval();
      });
    });
  }

  // ----------------------------------------------------------
  // PRE-TASK INSTRUCTIONS — reuses screen-onboarding shell.
  // Camera is OFF during this screen. Wording adjusted from v1: now tells
  // participants what's about to happen ("After this screen, you'll do a
  // quick sensor check, then the counting begins") instead of telling them
  // to place their finger immediately.
  // ----------------------------------------------------------
  function showPreTaskInstructions(onContinue) {
    show("screen-onboarding");
    const container = document.getElementById("onboarding-container");
    const nextBtn   = document.getElementById("onboarding-next-btn");

    const variantBody = INSTRUCTION_VARIANT === 'estimate'
      ? `Without taking your pulse or feeling for it, silently <strong>estimate</strong> how many heartbeats you feel during each timed interval. Do not guess based on time elapsed — only count what you actually feel.`
      : `Silently <strong>count</strong> the heartbeats you feel inside your body during each timed interval. Do not take your pulse or feel for it — count only what you can perceive internally.`;

    const bodyText = CUSTOM_INSTRUCTIONS || variantBody;

    // Number of real intervals + practice notice. Helps participants calibrate
    // expectations before the task starts ("how long is this going to take").
    const realCount = INTERVALS_SEC.length;
    const practiceNotice = INCLUDE_PRACTICE
      ? `<p style="margin-bottom:24px; text-align:left; color:var(--fg-muted); font-size:0.9rem;">You'll start with one short practice interval (${PRACTICE_DUR_SEC}s), then ${realCount} real intervals. Total time: about ${Math.round((PRACTICE_DUR_SEC + INTERVALS_SEC.reduce((a,b)=>a+b,0))/60 + 1)} minute${realCount > 1 ? 's' : ''}.</p>`
      : `<p style="margin-bottom:24px; text-align:left; color:var(--fg-muted); font-size:0.9rem;">${realCount} interval${realCount > 1 ? 's' : ''} total. Estimated time: about ${Math.round(INTERVALS_SEC.reduce((a,b)=>a+b,0)/60 + 1)} minute${realCount > 1 ? 's' : ''}.</p>`;

    container.innerHTML = `
      <div style="text-align:center; padding: 8px 0 32px;">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:20px;">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <h1 style="margin-bottom:12px;">Heartbeat Counting Task</h1>
        <p style="margin-bottom:20px; text-align:left;">${bodyText}</p>
        ${practiceNotice}
        <p style="margin-bottom:32px; text-align:left;">After tapping below, you'll do a quick sensor check (about 5 seconds), then the counting starts.</p>

        <div style="width:100%; max-width:340px; margin: 0 auto 24px; text-align:left;">
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">📷</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Camera + Flashlight</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Cover the lens completely with your fingertip. Keep it there until the task ends.</div>
            </div>
          </div>
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">🤚</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Stay still</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Don't take your pulse with your other hand. Rest both hands still.</div>
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
  // SENSOR CHECK — replaces the old baseline phase.
  //
  // Goal: verify finger placement and signal quality before the first
  // counting interval, without ever displaying the participant's BPM.
  // The screen shows a sensor preview circle and signal-quality feedback
  // via the same overlay used during counting. Once SQI on the active
  // channel has been good for SENSOR_CHECK_GOOD_SECS consecutive seconds,
  // a "Start counting" button enables.
  //
  // If the participant simply cannot get a clean signal within
  // MAX_SENSOR_CHECK_SEC, the button enables anyway with a "Continue
  // anyway?" affordance — the per-interval retry budget will handle
  // downstream quality failures, and no participant should be trapped
  // here forever (which is what v1 did with its broken 80-beats gate).
  //
  // Returns a Promise that resolves when the participant taps Start
  // counting. The detector is left RUNNING when this resolves so the
  // first interval can attach callbacks without a camera restart.
  // ----------------------------------------------------------
  async function runSensorCheck() {
    if (!core) {
      // Preview / no-core simulation: skip with a brief delay so the screen
      // is visible long enough to confirm flow.
      show("screen-hct-sensor-check");
      const btn = document.getElementById("hct-sensor-start-btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Start counting →";
      }
      await new Promise(resolve => {
        if (btn) btn.onclick = () => { btn.onclick = null; resolve(); };
        else resolve();
      });
      return;
    }

    show("screen-hct-sensor-check");
    sensorCheckGoodSecs = 0;
    sensorCheckStartTime = performance.now();

    const btn = document.getElementById("hct-sensor-start-btn");
    const statusEl = document.getElementById("hct-sensor-status");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Checking signal…";
    }
    if (statusEl) statusEl.textContent = "";

    await core.WakeLockCtrl.request();
    const videoElement = document.getElementById("video-feed");
    const previewCanvas = document.getElementById("sensor-preview-circle");
    const dpr = window.devicePixelRatio || 1;
    previewCanvas.width = 120 * dpr;
    previewCanvas.height = 120 * dpr;
    const previewCtx = previewCanvas.getContext("2d");

    startSensorWatchdog();

    await core.BeatDetector.start({
      video: videoElement,
      canvas: document.getElementById("sampling-canvas"),
      // We DELIBERATELY do not register an onBeatCb here. The sensor check
      // only needs finger presence + SQI; we don't want any chance of a
      // beat or BPM number leaking onto the screen via a stray DOM update.
      onBeatCb: () => { lastBeatPerfTime = performance.now(); },
      onFingerChangeCb: (p) => { isFingerPresent = p; updateSensorWarning(); },
      onSqiUpdateCb: (sqi) => { currentSqiValue = sqi; updateSensorWarning(); },
      onPPGSampleCb: () => {
        if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
          previewCtx.drawImage(videoElement, 0, 0, 120 * dpr, 120 * dpr);
        }
      }
    });
    detectorRunning = true;

    return new Promise(resolve => {
      sensorCheckResolve = resolve;

      sensorCheckTimer = setInterval(() => {
        const elapsed = (performance.now() - sensorCheckStartTime) / 1000;

        // Tick: was the signal good this second?
        if (isFingerPresent && currentSqiValue >= SENSOR_CHECK_SQI_FLOOR) {
          sensorCheckGoodSecs++;
        } else {
          sensorCheckGoodSecs = 0;  // any bad second resets the counter
        }

        // Ready to start? Two consecutive good seconds is the bar.
        const ready = sensorCheckGoodSecs >= SENSOR_CHECK_GOOD_SECS;
        // Hard cap reached? Let them through anyway, but make the button
        // copy honest about the situation.
        const timedOut = elapsed >= MAX_SENSOR_CHECK_SEC;

        if (btn) {
          if (ready) {
            btn.disabled = false;
            btn.textContent = "Start counting →";
            if (statusEl) statusEl.textContent = "Signal looks good.";
          } else if (timedOut) {
            btn.disabled = false;
            btn.textContent = "Continue anyway →";
            if (statusEl) statusEl.textContent = "Signal is weak — you can continue, but counting may need to retry.";
          } else {
            btn.disabled = true;
            btn.textContent = "Checking signal…";
            if (statusEl) statusEl.textContent = `${sensorCheckGoodSecs} of ${SENSOR_CHECK_GOOD_SECS} good seconds`;
          }
        }
      }, 1000);

      const onStart = () => {
        if (btn) btn.onclick = null;
        clearInterval(sensorCheckTimer);
        sensorCheckTimer = null;
        sensorCheckResolve = null;
        // Detach sensor-check callbacks; the next phase (interval) will
        // attach its own. KEEP the detector running.
        core.BeatDetector.setCallbacks({
          onBeatCb: null, onFingerChangeCb: null, onSqiUpdateCb: null, onPPGSampleCb: null
        });
        stopSensorWatchdog();
        resolve();
      };
      if (btn) btn.onclick = onStart;
    });
  }

  // ----------------------------------------------------------
  // INTERVAL — counting phase. Unchanged from v1 except for one minor
  // cleanup: the entry call no longer references baseline state.
  // ----------------------------------------------------------
  async function startInterval() {
    const item = intervalSchedule[currentIntervalIndex];
    if (!item) { return finishAndAdvance(); }

    show("screen-hct-counting");

    intRecordedHR = []; intIbiSeries = []; intIbiFlags = [];
    intCleanBeats = 0; intFlaggedBeats = 0; intLastIbi = 0;
    intSqiTimeSeries = []; intSqiBadSeconds = 0; intLastSqiCheckTime = performance.now();
    intStartedAt = new Date().toISOString();
    intStartedPerfMs = performance.now();
    intervalRunning = true;

    const labelEl = document.getElementById("hct-interval-label");
    if (labelEl) {
      const realCount = INTERVALS_SEC.length;
      const realIndex = item.isPractice ? null : currentIntervalIndex - (INCLUDE_PRACTICE ? 1 : 0) + 1;
      labelEl.textContent = item.isPractice
        ? "Practice"
        : `Interval ${realIndex} of ${realCount}`;
    }

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

    if (!core) {
      // Preview simulation
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
          for (let i = 0; i < fakeBeats; i++) {
            intRecordedHR.push(FAKE_BPM);
            intIbiSeries.push(Math.round(60000 / FAKE_BPM));
          }
          endInterval(item, fakeBeats);
        }
      }, 250);
      return;
    }

    // Re-attach callbacks for this interval. The detector is already running
    // from the sensor check, so no camera restart.
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
        const actualBeats = intRecordedHR.length;
        endInterval(item, actualBeats);
      }
    }, 250);
  }

  // ----------------------------------------------------------
  // END INTERVAL — quality gate, then count-entry screen.
  // Unchanged from v1.
  // ----------------------------------------------------------
  function endInterval(item, actualBeats) {
    intervalRunning = false;
    stopSensorWatchdog();

    const durationMs = performance.now() - intStartedPerfMs;
    const sqiBadFrac = durationMs > 0 ? (intSqiBadSeconds * 1000) / durationMs : 0;
    const tooNoisy = !isPreview && (actualBeats < 5 || sqiBadFrac > 0.5);

    if (tooNoisy && retriesLeft > 0) {
      retriesLeft--;
      const overlay = document.getElementById("sensor-warning-overlay");
      if (overlay) {
        overlay.classList.add("visible");
        const text = document.getElementById("sensor-warning-text");
        if (text) text.innerHTML = "Signal was unclear — retrying interval<br><span style='font-size:0.85rem;color:var(--fg-muted);font-weight:400;margin-top:6px;display:block;'>Reposition your finger and stay still</span>";
      }
      setTimeout(() => startInterval(), 3500);
      return;
    }

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
  // COUNT ENTRY — unchanged from v1.
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
  // CONFIDENCE — unchanged from v1.
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
  // BODY MAP — unchanged from v1.
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
      // Pre-interval breathing room
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
  // CONSOLIDATE & ADVANCE — same as v1, except baseline is now optional.
  // The envelope still has a baseline field; in v2 it will always be null.
  // Downstream code that treated baseline as required must be tolerant of
  // null — which the parser already is, since it filters by entry type
  // and tolerates missing fields.
  // ----------------------------------------------------------
  async function finishAndAdvance() {
    if (core) {
      detectorRunning = false;
      try { await core.BeatDetector.stop(); } catch(e) {}
      try { core.WakeLockCtrl.release(); } catch(e) {}
    }
    stopSensorWatchdog();

    // No more hct_baseline entries to consolidate (v1 left them in v1 sessions
    // for backward compat; v2 sessions will simply not have any baseline-typed
    // entries to filter, and this filter remains correct because the dashboard
    // and parser handle baseline:null gracefully).
    const rawEntries = sessionData.data.filter(e =>
      e && (e.type === 'hct_interval')
    );
    const intervalObjs = rawEntries.filter(e => !e.isPractice);
    const practiceObjs = rawEntries.filter(e =>  e.isPractice);

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

    const accArr = intervalObjs.map(e => e.accuracy).filter(v => typeof v === 'number');
    const confArr = intervalObjs.map(e => e.confidence).filter(v => typeof v === 'number' && v >= 0);

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
      // Baseline fields kept in summary for schema stability with v1 dashboards;
      // always null in v2 since no baseline is captured.
      baseline_beats:          null,
      baseline_sqi:            null,
      instruction_variant:     INSTRUCTION_VARIANT,
      randomized:              RANDOMIZE,
      intervals_sec:           INTERVALS_SEC.slice()
    };

    const hctEntry = {
      type: 'hct_response',
      startedAt: (intervalObjs[0]?.startedAt) ?? null,
      intervals: intervalObjs,
      practices: practiceObjs,
      baseline: null,             // explicit null for downstream clarity
      summary
    };

    const firstRawIdx = sessionData.data.findIndex(e =>
      e && (e.type === 'hct_interval')
    );
    sessionData.data = sessionData.data.filter(e =>
      e && e.type !== 'hct_interval'
    );
    if (firstRawIdx >= 0 && firstRawIdx <= sessionData.data.length) {
      sessionData.data.splice(firstRawIdx, 0, hctEntry);
    } else {
      sessionData.data.push(hctEntry);
    }

    advancePhase();
  }

  // The phase dispatcher in study-base.js calls HCT.startBaseline().
  // Keep the export name for compatibility; alias it to startTask().
  return { startBaseline: startTask };
})();

// ----------------------------------------------------------
// CHANGELOG — module-hct.js v2 vs v1
// ----------------------------------------------------------
// FIXED: infinite calibration restart loop. v1 used `baselineBPMs.length < 80`
//   as a baseline-quality gate. Over a 60s baseline this required sustained
//   80+ BPM, which a normal participant (60-75 BPM resting) never met,
//   triggering silent re-runs forever. The whole gate is gone in v2 because
//   there's no baseline to gate.
//
// REMOVED: pre-task baseline HR capture entirely. v1 inherited this from
//   ePAT but HCT doesn't need it — and showing the participant their BPM
//   immediately before a counting task is methodological contamination
//   (Brener & Ring 2018; Desmedt et al. 2018). Participants now never see
//   their HR during HCT.
//
// ADDED: pre-task instructions screen now runs FIRST, before any camera
//   activity. Camera turns on at the sensor check, not before.
//
// ADDED: sensor check phase. Brief signal-quality verification (~5s in
//   typical conditions, capped at 30s with a "continue anyway" escape
//   hatch). Replaces the 60s baseline. No BPM displayed.
//
// CHANGED: data envelope. `baseline` field is now always null in v2.
//   `hct_baseline`-typed raw entries no longer exist; finishAndAdvance()
//   only consolidates `hct_interval` entries. Downstream code that
//   handled baseline gracefully (parser, dashboard) continues to work.
//
// PRESERVED: per-interval flow (counting → count entry → confidence →
//   body map), retry budget mechanics, dual-channel SQI thresholds,
//   randomization and practice configuration, custom instructions and
//   instruction variants, all module config keys.