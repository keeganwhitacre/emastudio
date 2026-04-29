/* ============================================================
 * epat-core.js  —  v5
 * ------------------------------------------------------------
 * the ecological phase adjustment task — core signal pipeline.
 *
 * this file is the validated ppg + audio + motion stack,
 * extracted from the study code so it can be reused across
 * entry points (task, onboarding, validation) without copy-paste.
 *
 * exposes a single global namespace: window.ePATCore
 * - WakeLockCtrl   : screen wake lock (ios/android)
 * - WabpDetector   : zong et al. 2003 wabp onset algorithm (factory, not singleton)
 * - BeatDetector   : full ppg pipeline (camera → filter → dual-wabp → beats)
 * - AudioEngine    : web audio scheduler with refractory gate
 * - MotionDetector : accelerometer movement watchdog
 *
 * --- v5 channel-switching architecture ---
 *
 * PROBLEM WITH v4:
 *   computeSqi() operated on rawBuffer (perfusion index = (max-min)/mean of the
 *   raw camera channel). during finger placement the raw signal ramps from ambient
 *   (~0.10) up to finger-on levels (~0.40) inside the 3s calibration window.
 *   that ramp makes (max-min)/mean explode — green routinely hit 14+ vs red's 0.6 —
 *   so green always "won" calibration regardless of actual AC signal quality.
 *   additionally, CRITICAL_SQI = 0.005 was calibrated against the torch-saturated
 *   red channel (raw PI ~0.01). green's raw PI baseline is ~0.35, so green never
 *   triggered failover. result: green locked in permanently, WABP learned noise,
 *   death spiral.
 *
 * v5 SQI METRIC — filtered peak-to-peak:
 *   SQI is now computed from filteredBuffer (bandpass output), not rawBuffer.
 *   metric: peak-to-peak amplitude over a 2s rolling window.
 *   this directly measures what WABP cares about — detectable AC signal amplitude.
 *   it is scale-comparable across red and green (both are normalized by the same
 *   filter, so a larger value genuinely means a stronger pulse signal regardless
 *   of DC operating point). the raw-buffer perfusion index is retained as a
 *   separate metric exposed to callers for reference, but is no longer used for
 *   any switching decision.
 *
 * v5 CALIBRATION:
 *   after finger detection, a 4.5s settling window is enforced before baselines are locked.
 *   (the HP filter at 0.67 Hz has a time constant of ~0.24s; 5τ ≈ 1.2s, so 2s
 *   gives comfortable margin for the transient ring-down). then a 1s measurement
 *   window accumulates filtered pp for both channels. the winner is the channel
 *   with higher mean pp over that window. calibration completes at ~3s post-finger,
 *   well within WABP's 8s learning period.
 *
 * v5 DUAL WABP:
 *   two independent WabpDetector instances run in parallel from t=0 on their
 *   respective filtered signals. both are always processing — there is no "off"
 *   instance. only the active channel's detections are emitted as beats. this
 *   means on failover the backup detector has already adapted its thresholds to
 *   the current signal, so no reset and no cold-start blackout.
 *
 * v5 FAILOVER — relative thresholds:
 *   failover thresholds are expressed as a fraction of each channel's own
 *   calibration baseline pp, not as absolute values. this makes them dimensionless
 *   and channel-agnostic. switching fires when:
 *     (a) active channel pp < baseline * FAILOVER_DROP (signal fell >60%)
 *     (b) backup channel pp > its baseline * BACKUP_VIABLE (backup has >25% of its signal)
 *     (c) condition holds for ANTITHRASH_COUNT consecutive 1s SQI checks
 *   after a switch, the new channel's current pp becomes its running baseline.
 *   switching back to the original channel obeys the same rules — no special bias.
 *
 * api contract notes (unchanged from v4):
 * - BeatDetector.setCallbacks() does NOT reset filter/detector state.
 * - only BeatDetector.stop() fully tears down camera + filter state.
 * - all timestamps use performance.now() (monotonic, ms since page load).
 * - onSqiUpdateCb(sqiRed, sqiGreen, activeChannel) — both values are the
 *   filtered-pp metric (not raw PI), reported every SQI_INTERVAL_MS.
 * ============================================================ */

(function () {

  // ============================================================
  // WAKE LOCK CONTROLLER
  // ============================================================
  const WakeLockCtrl = (function() {
    let wl = null;
    return {
      async request() {
        try { if ("wakeLock" in navigator) { wl = await navigator.wakeLock.request("screen"); } } catch (e) {}
      },
      release() {
        try { if (wl) { wl.release(); wl = null; } } catch (e) {}
      }
    };
  })();

  // ============================================================
  // WABP ONSET DETECTOR FACTORY (Zong et al. 2003, adapted for camera PPG)
  // ------------------------------------------------------------
  // returns a new independent detector instance each call.
  // v5 change: exposed as a factory (makeWabpDetector) rather than a singleton
  // so BeatDetector can run two instances in parallel without shared state.
  //
  // the singleton WabpDetector export is preserved for backward compatibility
  // with any callers that reference window.ePATCore.WabpDetector directly.
  // ============================================================
  function makeWabpDetector() {
    let SAMPLE_RATE, EYE_CLS_SAMPLES, SLP_WINDOW, NDP_SAMPLES, LPERIOD_SAMPLES, INIT_WINDOW;
    const TM_FLOOR_RATIO = 0.05;

    let slopeBuffer = [], slopeEnergyBuffer = [];
    let sampleIndex = 0, learning = true, learningComplete = false;
    let T0 = 0, Ta = 0, T1 = 0, Tm = 0;
    let lastOnsetIndex = -Infinity, noDetectTimer = 0, prevSample = 0;

    function reset(sampleRate) {
      SAMPLE_RATE      = sampleRate || 30;
      EYE_CLS_SAMPLES  = Math.round(0.25  * SAMPLE_RATE);
      SLP_WINDOW       = Math.max(2, Math.round(0.13 * SAMPLE_RATE));
      NDP_SAMPLES      = Math.round(2.5   * SAMPLE_RATE);
      LPERIOD_SAMPLES  = Math.round(8.0   * SAMPLE_RATE);
      INIT_WINDOW      = Math.round(8.0   * SAMPLE_RATE);
      slopeBuffer = []; slopeEnergyBuffer = [];
      sampleIndex = 0; learning = true; learningComplete = false;
      T0 = 0; Ta = 0; T1 = 0; Tm = 0;
      lastOnsetIndex = -Infinity; noDetectTimer = 0; prevSample = 0;
    }

    function processSample(filteredSample) {
      sampleIndex++;
      const dy = Math.max(0, filteredSample - prevSample);
      prevSample = filteredSample;
      slopeBuffer.push(dy);

      let slopeEnergy = 0;
      const startIdx = Math.max(0, slopeBuffer.length - SLP_WINDOW);
      for (let i = startIdx; i < slopeBuffer.length; i++) slopeEnergy += slopeBuffer[i];
      slopeEnergyBuffer.push(slopeEnergy);

      const MAX_BUF = SAMPLE_RATE * 10;
      if (slopeBuffer.length > MAX_BUF) {
        slopeBuffer = slopeBuffer.slice(-MAX_BUF);
        slopeEnergyBuffer = slopeEnergyBuffer.slice(-MAX_BUF);
      }

      if (learning) {
        if (sampleIndex === INIT_WINDOW) {
          let sum = 0;
          for (let i = 0; i < slopeEnergyBuffer.length; i++) sum += slopeEnergyBuffer[i];
          T0 = sum / slopeEnergyBuffer.length;
          Ta = 3 * T0; Tm = T0 * TM_FLOOR_RATIO;
        }
        if (sampleIndex <= LPERIOD_SAMPLES) { T1 = 2 * T0; return { detected: false }; }
        else { learning = false; learningComplete = true; T1 = Ta / 3; }
      }
      if (!learningComplete) return { detected: false };

      if (sampleIndex - lastOnsetIndex < EYE_CLS_SAMPLES) return { detected: false };

      if (slopeEnergy > T1) {
        const seLen = slopeEnergyBuffer.length;
        const halfEye = Math.floor(EYE_CLS_SAMPLES / 2);
        if (seLen >= 3) {
          const s0 = slopeEnergyBuffer[seLen - 3], s1 = slopeEnergyBuffer[seLen - 2], s2 = slopeEnergyBuffer[seLen - 1];
          if (s1 >= s0 && s1 >= s2 && s1 > T1) {
            let maxVal = s1, minVal = s1;
            for (let j = seLen - 2; j >= Math.max(0, seLen - 2 - halfEye); j--) {
              if (slopeEnergyBuffer[j] > maxVal) maxVal = slopeEnergyBuffer[j];
              if (slopeEnergyBuffer[j] < minVal) minVal = slopeEnergyBuffer[j];
            }
            if (maxVal > minVal * 1.5 + 1e-6) {
              const onsetThresh = maxVal * 0.02;
              let onsetIdx = seLen - 2;
              for (let j = seLen - 2; j >= Math.max(0, seLen - 2 - halfEye); j--) {
                if (j > 0 && (slopeEnergyBuffer[j] - slopeEnergyBuffer[j - 1]) < onsetThresh) { onsetIdx = j; break; }
              }
              Ta += (maxVal - Ta) / 10; T1 = Ta / 3;
              lastOnsetIndex = sampleIndex; noDetectTimer = 0;
              const framesAgo = (seLen - 1) - onsetIdx;
              return { detected: true, onsetIndex: sampleIndex - framesAgo, framesAgo, totalFramesAgo: framesAgo + SLP_WINDOW, peakEnergy: maxVal };
            }
          }
        }
      }

      noDetectTimer++;
      if (noDetectTimer > NDP_SAMPLES && Ta > Tm) { Ta -= Ta * 0.005; if (Ta < Tm) Ta = Tm; T1 = Ta / 3; }
      return { detected: false };
    }

    return { reset, processSample };
  }

  // backward-compat singleton
  const WabpDetector = makeWabpDetector();

  // ============================================================
  // PPG BEAT DETECTOR — dual-WABP, filtered-pp SQI, relative thresholds
  // ------------------------------------------------------------
  // pipeline: camera → bandpass 0.67–3.33 Hz → dual WABP (both always running)
  //           → active channel beats emitted → dicrotic gate
  //
  // channel selection and failover use filtered peak-to-peak, not raw PI.
  // see module-level comments for the full rationale.
  // ============================================================
  const BeatDetector = (function () {
    const IMAGE_SIZE = 40, BUFFER_SECONDS = 8;
    const FINGER_BRIGHTNESS_MIN = 0.15, FINGER_BRIGHTNESS_MAX = 0.98, FINGER_RED_DOMINANCE = 0.38;

    // --- calibration & switching parameters ---
    // CAL_SETTLE_MS: how long after finger detection before baselines are locked.
    // must be long enough for two things to clear:
    //   (1) HP filter transient: at 0.67 Hz cutoff, 5τ ≈ 1.2s. 
    //   (2) SQI rolling window: computeFilteredPP uses a 2s window, so the first
    //       clean SQI reading requires 2s of post-transient data in the buffer.
    //   → 4.5s covers both with margin. at 4.5s the oldest sample in the 2s window
    //     is from t=2.5s, which is post-transient on every device tested.
    //
    // there is no 'measuring' phase and no calibration winner comparison.
    // channel selection at startup is not meaningful because:
    //   - both channels have nearly equal SQI at rest during the settle window
    //   - the better channel only becomes apparent under real-world conditions
    //   - ambient light, temperature, and posture determine which channel wins
    //   - a comparison during a calm 1s window gets this wrong as often as right
    //
    // instead: always start on RED (most robust default — torch is optimised for red
    // and it is unaffected by ambient light changes), then let the failover mechanism
    // discover green if it genuinely proves better over 2+ consecutive SQI checks.
    // each channel gets its own per-channel baseline (self-referenced, not compared),
    // so transient spikes affect only that channel's own threshold, not the decision.
    const CAL_SETTLE_MS    = 4500;
    // failover: active channel's pp must fall below this fraction of its own baseline
    const FAILOVER_DROP    = 0.40;
    // backup must have at least this fraction of its own baseline to be considered viable
    const BACKUP_VIABLE    = 0.25;
    // antithrash: require this many consecutive SQI checks before switching
    const ANTITHRASH_COUNT = 2;

    let video = null, canvas = null, ctx = null, stream = null, track = null;
    let running = false, animFrameId = null, actualFPS = 30, startTime = 0, lastFrameTime = 0;
    let fingerPresent = false, fingerDebounceCount = 0;
    const FINGER_DEBOUNCE_FRAMES = 8;

    // --- per-channel buffers ---
    let rawBuffer = [], timeBuffer = [], filteredBuffer = [];
    let rawBufferGreen = [], filteredBufferGreen = [];

    // --- beat tracking ---
    let instantPeriod = 0, averagePeriod = 0, lastBeatTimeRed = 0, lastBeatTimeGreen = 0;
    let prevAcceptedBeatTime = 0, prevAcceptedIbi = 0;
    let recentPeriods = [];
    const MAX_RECENT_PERIODS = 10;
    let dicroticRejectCount = 0;

    // --- post-switch stabilization ---
    // when the active channel changes, the new channel's WABP may have a decayed
    // threshold (Ta→Tm) from running as a quiet backup. it can fire rapidly on noise
    // before recentPeriods fills enough for the median gate to be meaningful.
    // switchStabPeriodMs carries the last known good period into evaluateBeat so the
    // dicrotic gate has a real reference rather than the 800ms default.
    // it is cleared once recentPeriods reaches DICROTIC_MIN_PERIODS beats.
    let switchStabPeriodMs = 0;  // 0 = inactive

    // --- SQI (filtered peak-to-peak) ---
    // SQI_WINDOW_S: how wide a window to measure pp over. 2s covers ~1–2 full cycles
    // at resting HR, long enough for a reliable pp estimate, short enough to track
    // signal degradation within a few seconds.
    const SQI_WINDOW_S   = 2;
    const SQI_INTERVAL_MS = 1000;
    let lastSqiTime = 0, currentSqiRed = 0, currentSqiGreen = 0;

    // --- dual WABP instances ---
    let wabpRed   = makeWabpDetector();
    let wabpGreen = makeWabpDetector();

    // --- channel state machine ---
    // phases: 'settling' → 'locked'
    // no measuring/winner phase — see CAL_SETTLE_MS comment above.
    let calPhase = 'settling';
    let calPhaseStartTime = 0;           // when settling began (performance.now())
    let activeChannel     = 'red';       // always start on red; failover discovers green
    let redBaseline       = 0;           // per-channel pp baseline set at lock time
    let greenBaseline     = 0;
    let failoverCounter   = 0;           // consecutive checks below threshold

    // --- frame timing diagnostics ---
    let frameDeltaBuffer = [], frameDropCount = 0, totalFrames = 0;

    // --- brightness clipping diagnostics ---
    let clipCount = 0, clipTotal = 0;

    // --- bandpass filter coefficients & state ---
    let HP_ALPHA = 0, LP_ALPHA = 0;
    let hpState      = { x1: 0, y1: 0 }, lpState      = { y1: 0 };
    let hpStateGreen = { x1: 0, y1: 0 }, lpStateGreen = { y1: 0 };

    function computeFilterCoeffs(sr) {
      const hpRC = 1 / (2 * Math.PI * 0.67), lpRC = 1 / (2 * Math.PI * 3.33);
      HP_ALPHA = hpRC / (hpRC + 1 / sr);
      LP_ALPHA = (1 / sr) / (lpRC + 1 / sr);
    }

    function highpass(x)      { const y = HP_ALPHA * (hpState.y1 + x - hpState.x1);           hpState.x1 = x;      hpState.y1 = y;      return y; }
    function lowpass(x)       { const y = lpState.y1 + LP_ALPHA * (x - lpState.y1);            lpState.y1 = y;                           return y; }
    function bandpass(x)      { return lowpass(highpass(x)); }

    function highpassGreen(x) { const y = HP_ALPHA * (hpStateGreen.y1 + x - hpStateGreen.x1); hpStateGreen.x1 = x; hpStateGreen.y1 = y; return y; }
    function lowpassGreen(x)  { const y = lpStateGreen.y1 + LP_ALPHA * (x - lpStateGreen.y1); lpStateGreen.y1 = y;                      return y; }
    function bandpassGreen(x) { return lowpassGreen(highpassGreen(x)); }

    function resetFilters() {
      hpState      = { x1: 0, y1: 0 }; lpState      = { y1: 0 };
      hpStateGreen = { x1: 0, y1: 0 }; lpStateGreen = { y1: 0 };
    }

    function getMedian(arr) {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    // --- callbacks ---
    let onBeat = null, onFingerChange = null, onPPGSample = null, onSqiUpdate = null, onDicroticReject = null;

    // ── camera pixel extraction ──────────────────────────────
    function extractMeans() {
      ctx.drawImage(video, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
      const d = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      const rMean = r / n / 255, gMean = g / n / 255, bMean = b / n / 255;
      const brightness = (rMean + gMean + bMean) / 3;
      const redRatio = rMean / (rMean + gMean + bMean + 1e-6);

      clipTotal++;
      if (rMean > 0.97) clipCount++;

      const looksLikeFinger = brightness > FINGER_BRIGHTNESS_MIN && brightness < FINGER_BRIGHTNESS_MAX && redRatio > FINGER_RED_DOMINANCE;
      if (looksLikeFinger === fingerPresent) {
        fingerDebounceCount = 0;
      } else {
        fingerDebounceCount++;
        if (fingerDebounceCount >= FINGER_DEBOUNCE_FRAMES) {
          fingerPresent = looksLikeFinger;
          fingerDebounceCount = 0;
          if (fingerPresent) {
            // finger placed: restart settle timer. keep WABP running —
            // if this is a re-placement, existing thresholds are still valid.
            calPhase = 'settling';
            calPhaseStartTime = performance.now();
            failoverCounter = 0;
          }
          if (onFingerChange) onFingerChange(fingerPresent);
        }
      }
      return { red: rMean, green: gMean };
    }

    // ── filtered peak-to-peak SQI ────────────────────────────
    // operates on filteredBuffer / filteredBufferGreen.
    // returns peak-to-peak amplitude over the most recent SQI_WINDOW_S seconds.
    // this is the primary quality signal used for all switching decisions.
    function computeFilteredPP(buf) {
      const windowSamples = Math.round(actualFPS * SQI_WINDOW_S);
      if (buf.length < windowSamples) return 0;
      const win = buf.slice(-windowSamples);
      let mn = win[0], mx = win[0];
      for (let i = 1; i < win.length; i++) {
        if (win[i] < mn) mn = win[i];
        if (win[i] > mx) mx = win[i];
      }
      return mx - mn;
    }

    // ── raw perfusion index (kept for reference, not used in switching) ──
    function computeRawPI(buf) {
      const windowSamples = Math.round(actualFPS * SQI_WINDOW_S);
      if (buf.length < windowSamples) return 0;
      const win = buf.slice(-windowSamples);
      let mn = win[0], mx = win[0], sum = 0;
      for (let i = 0; i < win.length; i++) {
        if (win[i] < mn) mn = win[i];
        if (win[i] > mx) mx = win[i];
        sum += win[i];
      }
      const mean = sum / win.length;
      return mean < 1e-6 ? 0 : (mx - mn) / mean;
    }

    // ── calibration state machine ────────────────────────────
    // called once per SQI interval while finger is present.
    // 'settling' → wait CAL_SETTLE_MS for filter transient + SQI window to clear
    // 'locked'   → baselines set; run failover logic every SQI check
    function updateCalibrationAndSwitcher(now, ppRed, ppGreen) {
      if (calPhase === 'settling') {
        if (now - calPhaseStartTime >= CAL_SETTLE_MS) {
          // first clean SQI reading — lock per-channel baselines and start on red.
          // if either channel has zero signal at lock time (finger not fully placed),
          // use a small non-zero floor so the threshold maths don't collapse.
          redBaseline   = ppRed   > 0 ? ppRed   : 1e-6;
          greenBaseline = ppGreen > 0 ? ppGreen : 1e-6;
          activeChannel = 'red';
          failoverCounter = 0;
          calPhase = 'locked';
        }
        return; // no switching during settle
      }

      // calPhase === 'locked' — evaluate failover every SQI check
      if (activeChannel === 'red') {
        const activeOk = ppRed   >= redBaseline   * FAILOVER_DROP;
        const backupOk = ppGreen >= greenBaseline * BACKUP_VIABLE;
        if (!activeOk && backupOk) {
          failoverCounter++;
          if (failoverCounter >= ANTITHRASH_COUNT) {
            activeChannel = 'green';
            greenBaseline = ppGreen > 0 ? ppGreen : greenBaseline; // re-anchor baseline
            failoverCounter = 0;
            if (averagePeriod > 0) switchStabPeriodMs = averagePeriod * 1000;
          }
        } else {
          failoverCounter = 0;
        }
      } else {
        const activeOk = ppGreen >= greenBaseline * FAILOVER_DROP;
        const backupOk = ppRed   >= redBaseline   * BACKUP_VIABLE;
        if (!activeOk && backupOk) {
          failoverCounter++;
          if (failoverCounter >= ANTITHRASH_COUNT) {
            activeChannel = 'red';
            redBaseline = ppRed > 0 ? ppRed : redBaseline;
            failoverCounter = 0;
            if (averagePeriod > 0) switchStabPeriodMs = averagePeriod * 1000;
          }
        } else {
          failoverCounter = 0;
        }
      }
    }

    // ── beat acceptance (shared between channels) ────────────
    // returns { accepted: bool, isDicrotic: bool }
    function evaluateBeat(beatTime, lastBeatTime) {
      const interval = beatTime - lastBeatTime;

      // not yet anchored — accept and anchor without emitting
      if (lastBeatTime === 0 || interval > 2500) {
        return { accepted: false, anchor: true };
      }

      // absolute physiological floor
      if (interval < 350) {
        return { accepted: false, anchor: false };
      }

      // median-anchored dicrotic gate.
      // priority: (1) live median once recentPeriods is full enough,
      //           (2) switchStabPeriodMs — carried from the prior channel on failover,
      //               active only until recentPeriods reaches DICROTIC_MIN_PERIODS,
      //           (3) 800ms safe default (75 BPM) while learning the first beats.
      // the stab seed closes the gap where a threshold-decayed backup WABP can fire
      // at 500–700ms intervals that pass the 800ms-based default gate (480ms threshold)
      // but would correctly be blocked by a real period reference (e.g., 560ms gate
      // at a true 933ms / 65 BPM period).
      const DICROTIC_MIN_PERIODS = 3;
      let expectedPeriodMs;
      if (recentPeriods.length >= DICROTIC_MIN_PERIODS) {
        expectedPeriodMs = getMedian(recentPeriods) * 1000;
        switchStabPeriodMs = 0;  // live data is available; disarm stabilization
      } else if (switchStabPeriodMs > 0) {
        expectedPeriodMs = switchStabPeriodMs;
      } else {
        expectedPeriodMs = 800;
      }

      if (interval < expectedPeriodMs * 0.60) {
        return { accepted: false, isDicrotic: true, interval, expectedPeriodMs };
      }

      return { accepted: true, interval };
    }

    // ── main frame loop ──────────────────────────────────────
    function processFrame() {
      if (!running) return;
      const now = performance.now();

      const means = extractMeans();

      const filtered      = bandpass(means.red);
      const filteredGreen = bandpassGreen(means.green);

      const BUFFER_SIZE = Math.round(actualFPS * BUFFER_SECONDS);

      // frame timing diagnostics
      totalFrames++;
      if (lastFrameTime > 0) {
        const dt = now - lastFrameTime;
        frameDeltaBuffer.push(dt);
        if (frameDeltaBuffer.length > 300) frameDeltaBuffer.shift();
        if (dt > (1000 / actualFPS) * 2) frameDropCount++;
      }
      lastFrameTime = now;

      // push to buffers
      rawBuffer.push(means.red);   timeBuffer.push(now); filteredBuffer.push(filtered);
      rawBufferGreen.push(means.green);                  filteredBufferGreen.push(filteredGreen);

      if (rawBuffer.length > BUFFER_SIZE) {
        rawBuffer.shift(); timeBuffer.shift(); filteredBuffer.shift();
        rawBufferGreen.shift(); filteredBufferGreen.shift();
      }

      if (onPPGSample) onPPGSample(filtered, filteredGreen);

      // ── SQI update ─────────────────────────────────────────
      if (fingerPresent && (now - lastSqiTime > SQI_INTERVAL_MS)) {
        currentSqiRed   = computeFilteredPP(filteredBuffer);
        currentSqiGreen = computeFilteredPP(filteredBufferGreen);
        lastSqiTime = now;

        updateCalibrationAndSwitcher(now, currentSqiRed, currentSqiGreen);

        if (onSqiUpdate) onSqiUpdate(currentSqiRed, currentSqiGreen, activeChannel);
      }

      // ── feed both WABP instances every frame ───────────────
      // both run regardless of which is active — keeps the backup warm.
      const resultRed   = wabpRed.processSample(filtered);
      const resultGreen = wabpGreen.processSample(filteredGreen);

      // ── emit beats only from the active channel ─────────────
      if (fingerPresent && calPhase === 'locked') {
        const result    = activeChannel === 'red' ? resultRed : resultGreen;
        const lastBeat  = activeChannel === 'red' ? lastBeatTimeRed : lastBeatTimeGreen;

        if (result.detected) {
          const beatTime = now - (result.totalFramesAgo * (1000 / actualFPS));
          const ev = evaluateBeat(beatTime, lastBeat);

          if (ev.anchor) {
            if (activeChannel === 'red') lastBeatTimeRed = beatTime;
            else                         lastBeatTimeGreen = beatTime;
          } else if (ev.isDicrotic) {
            dicroticRejectCount++;
            if (onDicroticReject) onDicroticReject({
              time: beatTime,
              rejectedIbi: ev.interval,
              expectedPeriod: ev.expectedPeriodMs,
            });
          } else if (ev.accepted) {
            if (activeChannel === 'red') lastBeatTimeRed = beatTime;
            else                         lastBeatTimeGreen = beatTime;

            prevAcceptedBeatTime = lastBeat;
            prevAcceptedIbi = ev.interval;

            instantPeriod = ev.interval / 1000;
            const instantBPM = 60 / instantPeriod;

            recentPeriods.push(instantPeriod);
            if (recentPeriods.length > MAX_RECENT_PERIODS) recentPeriods.shift();

            averagePeriod = getMedian(recentPeriods);
            const averageBPM = 60 / averagePeriod;

            if (onBeat) onBeat({ instantBPM, averageBPM, instantPeriod, averagePeriod, time: beatTime });
          }
        }
      }

      animFrameId = requestAnimationFrame(processFrame);
    }

    // ── camera setup ────────────────────────────────────────
    async function startCamera() {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }

      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        tempStream.getTracks().forEach(t => t.stop());
      } catch (e) {}

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === "videoinput");
      let torchWorking = false;

      const ranked = [];
      for (const cam of cameras) {
        const label = (cam.label || "").toLowerCase();
        if (label.includes("front") || label.includes("facetime")) continue;
        if (label.includes("dual") || label.includes("triple")) continue;
        if (label.includes("ultra") || label.includes("tele")) continue;
        ranked.push(cam);
      }
      if (ranked.length === 0) {
        for (const cam of cameras) {
          const label = (cam.label || "").toLowerCase();
          if (!label.includes("front") && !label.includes("facetime")) ranked.push(cam);
        }
      }

      for (const cam of ranked) {
        let streamSuccess = false;
        const frameRateFallbacks = [{ exact: 60 }, { exact: 30 }, { ideal: 30 }];

        for (const fpsTarget of frameRateFallbacks) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: cam.deviceId },
                width:  { ideal: 640 },
                height: { ideal: 480 },
                frameRate: fpsTarget
              }
            });
            streamSuccess = true;
            break;
          } catch (e) {}
        }

        if (!streamSuccess) continue;

        track = stream.getVideoTracks()[0];

        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (caps.torch) {
            await track.applyConstraints({ advanced: [{ torch: true }] });
            torchWorking = true;
            const settingsAfterTorch = track.getSettings();
            actualFPS = settingsAfterTorch.frameRate || actualFPS;
            break;
          }
        } catch (e) {}

        stream.getTracks().forEach(t => t.stop()); stream = null; track = null;
      }

      if (!stream)        throw new Error("no usable rear camera with torch");
      if (!torchWorking)  throw new Error("torch not available on any rear camera");

      video.srcObject = stream;
      await video.play();

      const settings = track.getSettings();
      actualFPS = settings.frameRate || 30;

      return { actualFPS, label: track.label, torchWorking };
    }

    async function stopCamera() {
      try {
        if (track && track.getCapabilities && track.getCapabilities().torch) {
          await track.applyConstraints({ advanced: [{ torch: false }] });
        }
      } catch (e) {}
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; track = null; }
      if (video) video.srcObject = null;
    }

    return {
      async start(opts) {
        video  = opts.video;
        canvas = opts.canvas;
        ctx    = canvas.getContext("2d", { willReadFrequently: true });
        canvas.width = IMAGE_SIZE; canvas.height = IMAGE_SIZE;

        onBeat           = opts.onBeatCb           || null;
        onFingerChange   = opts.onFingerChangeCb   || null;
        onPPGSample      = opts.onPPGSampleCb      || null;
        onSqiUpdate      = opts.onSqiUpdateCb      || null;
        onDicroticReject = opts.onDicroticRejectCb || null;

        await startCamera();

        // reset all state
        rawBuffer = []; timeBuffer = []; filteredBuffer = [];
        rawBufferGreen = []; filteredBufferGreen = [];

        recentPeriods = []; instantPeriod = 0; averagePeriod = 0;
        lastBeatTimeRed = 0; lastBeatTimeGreen = 0;
        prevAcceptedBeatTime = 0; prevAcceptedIbi = 0;
        switchStabPeriodMs = 0;
        fingerPresent = false; fingerDebounceCount = 0;

        lastSqiTime = 0; currentSqiRed = 0; currentSqiGreen = 0;
        calPhase = 'settling'; calPhaseStartTime = 0;
        activeChannel = 'red'; redBaseline = 0; greenBaseline = 0;
        failoverCounter = 0;

        frameDeltaBuffer = []; frameDropCount = 0; totalFrames = 0;
        clipCount = 0; clipTotal = 0; dicroticRejectCount = 0;

        computeFilterCoeffs(actualFPS); resetFilters();

        // reset both WABP instances
        wabpRed   = makeWabpDetector(); wabpRed.reset(actualFPS);
        wabpGreen = makeWabpDetector(); wabpGreen.reset(actualFPS);

        startTime = performance.now(); lastFrameTime = 0; running = true;
        processFrame();

        return stream;
      },

      async stop() {
        running = false;
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        await stopCamera();
      },

      // swap callbacks without touching filter/detector state.
      setCallbacks(cbs) {
        if (cbs.onBeatCb           !== undefined) onBeat           = cbs.onBeatCb;
        if (cbs.onFingerChangeCb   !== undefined) onFingerChange   = cbs.onFingerChangeCb;
        if (cbs.onPPGSampleCb      !== undefined) onPPGSample      = cbs.onPPGSampleCb;
        if (cbs.onSqiUpdateCb      !== undefined) onSqiUpdate      = cbs.onSqiUpdateCb;
        if (cbs.onDicroticRejectCb !== undefined) onDicroticReject = cbs.onDicroticRejectCb;
      },

      getActualFPS()           { return actualFPS; },
      getActiveChannel()       { return activeChannel; },
      getCalPhase()            { return calPhase; },
      getSqi()                 { return currentSqiRed; },
      getSqiGreen()            { return currentSqiGreen; },
      getDicroticRejectCount() { return dicroticRejectCount; },
      getDiagnostics() {
        const avgDelta = frameDeltaBuffer.length
          ? frameDeltaBuffer.reduce((a, b) => a + b, 0) / frameDeltaBuffer.length
          : 0;
        return {
          totalFrames, frameDropCount, avgFrameDelta: avgDelta,
          clipRate: clipTotal ? (clipCount / clipTotal) * 100 : 0,
          dicroticRejects: dicroticRejectCount,
          activeChannel, calPhase,
          redBaseline, greenBaseline,
        };
      },
    };
  })();

  // ============================================================
  // AUDIO ENGINE
  // ------------------------------------------------------------
  // two apis:
  //   scheduleAt(delaySec) — audio-clock scheduled, frame-accurate.
  //   play() — fire now with a perf-clock refractory gate.
  // ============================================================
  const AudioEngine = (function () {
    let audioCtx = null, lowBuf = null;

    function createBeep(freq, dur) {
      const sr = 44100, len = sr * dur, buf = audioCtx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * freq * t) * Math.min(1, t * 50) * Math.min(1, (dur - t) * 50) * 0.5;
      }
      return buf;
    }

    const MIN_TONE_SPACING    = 0.35;
    const MIN_TONE_SPACING_MS = 350;
    let lastScheduledWhen = 0, lastPlayedPerfNow = 0;
    let dropLog = [];

    return {
      init() {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        lowBuf = createBeep(440, 0.08);
      },
      scheduleAt(delaySec) {
        if (!audioCtx) return null;
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") audioCtx.resume();
        const when = audioCtx.currentTime + Math.max(0, delaySec);
        const sinceLast = (when - lastScheduledWhen) * 1000;
        if (when - lastScheduledWhen < MIN_TONE_SPACING) {
          dropLog.push({ perfNow: performance.now(), requestedWhen: when, sinceLastMs: Math.round(sinceLast), ctxState: audioCtx.state });
          return { dropped: true, sinceLastMs: sinceLast };
        }
        const s = audioCtx.createBufferSource();
        s.buffer = lowBuf; s.connect(audioCtx.destination); s.start(when);
        lastScheduledWhen = when;
        return { scheduledAt: when, perfNow: performance.now(), delaySec, ctxState: audioCtx.state };
      },
      play() {
        if (!audioCtx) return null;
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") audioCtx.resume();
        const now = performance.now();
        const sinceLast = now - lastPlayedPerfNow;
        if (sinceLast < MIN_TONE_SPACING_MS) {
          dropLog.push({ perfNow: now, sinceLastMs: Math.round(sinceLast), ctxState: audioCtx.state });
          return { dropped: true, sinceLastMs: sinceLast };
        }
        const s = audioCtx.createBufferSource();
        s.buffer = lowBuf; s.connect(audioCtx.destination); s.start();
        lastPlayedPerfNow = now;
        return { perfNow: now, ctxState: audioCtx.state };
      },
      resetSchedulerState() { lastScheduledWhen = 0; lastPlayedPerfNow = 0; },
      getDropLog()  { return dropLog.slice(); },
      clearDropLog(){ dropLog = []; },
      playLow() {
        if (!audioCtx) return;
        if (audioCtx.state === "suspended" || audioCtx.state === "interrupted") audioCtx.resume();
        const s = audioCtx.createBufferSource(); s.buffer = lowBuf; s.connect(audioCtx.destination); s.start();
      },
      resume()   { if (audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted")) audioCtx.resume(); },
      getState() { return audioCtx ? audioCtx.state : "uninitialized"; },
      getContext(){ return audioCtx; },
    };
  })();

  // ============================================================
  // MOTION DETECTOR
  // ------------------------------------------------------------
  // accelerometer watchdog + hard-tap sync marker (validation tool).
  // ============================================================
  const MotionDetector = (function () {
    const MOVEMENT_THRESHOLD = 0.2;
    const HARD_TAP_THRESHOLD = 12;

    let accBuffer = [], lastAcc = { x: 0, y: 0, z: 0 };
    let listening = false, permitted = false;
    let onMovementWarning = null, onTapCb = null;
    let tapDebounce = false;

    function handleMotion(e) {
      const a = e.accelerationIncludingGravity || e.acceleration;
      if (!a) return;
      const diffMag = Math.sqrt(Math.pow(a.x - lastAcc.x, 2) + Math.pow(a.y - lastAcc.y, 2) + Math.pow(a.z - lastAcc.z, 2));
      accBuffer.push(diffMag);

      if (diffMag > HARD_TAP_THRESHOLD && !tapDebounce) {
        if (onTapCb) onTapCb();
        tapDebounce = true;
        setTimeout(() => tapDebounce = false, 800);
      }
      lastAcc = { x: a.x, y: a.y, z: a.z };
    }

    return {
      async requestPermission() {
        if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
          try { const perm = await DeviceMotionEvent.requestPermission(); permitted = (perm === "granted"); } catch (e) { permitted = false; }
        } else { permitted = true; }
        return permitted;
      },
      start(warningCb, tapCb) {
        if (!permitted) return;
        onMovementWarning = warningCb || null;
        onTapCb = tapCb || null;
        accBuffer = []; lastAcc = { x: 0, y: 0, z: 0 }; tapDebounce = false;
        window.addEventListener("devicemotion", handleMotion); listening = true;
      },
      stop() { if (listening) { window.removeEventListener("devicemotion", handleMotion); listening = false; } },
      checkMovement() {
        if (accBuffer.length === 0) return false;
        const mean = accBuffer.reduce((a, b) => a + b, 0) / accBuffer.length;
        accBuffer = [];
        const tooMuch = mean > MOVEMENT_THRESHOLD;
        if (tooMuch && onMovementWarning) onMovementWarning();
        return tooMuch;
      },
    };
  })();

  // ============================================================
  // EXPORT
  // ============================================================
  window.ePATCore = {
    WakeLockCtrl,
    WabpDetector,       // backward-compat singleton
    makeWabpDetector,   // factory — use this for new code
    BeatDetector,
    AudioEngine,
    MotionDetector,
  };

})();
