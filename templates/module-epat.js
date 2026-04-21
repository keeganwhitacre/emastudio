// ==========================================================
// PAT SENSOR LOGIC (Full Port)
// ==========================================================
const ePAT = (function() {
  const core = window.ePATCore;
  const NUM_TRIALS = config.modules?.epat?.trials || 20;
  const NUM_PRACTICES = config.modules?.epat?.two_phase_practice ? 2 : 0;
  const IBI_CHANGE_THRESHOLD = 0.30;
  const SQI_GOOD = 0.008, SQI_WARN = 0.004;
  const BODY_MAP_EVERY = config.modules?.epat?.body_map ? 4 : Infinity;

  let trialIP = [], trialAP = [], trialKS = [], trialCD = [], trialIE = [], trialRecordedHR = [], trialInstantBpms = [];
  let trialToneTimings = [], trialFingerLossEvents = [], trialInitialKnob = 0;
  let trialLastIbi = 0, trialCleanBeats = 0, trialFlaggedBeats = 0, trialIbiFlags = [];
  let trialSqiTimeSeries = [], trialSqiBadSeconds = 0, trialLastSqiCheckTime = 0, trialDicroticRejections = [];
  let currentInstantPeriod = 0, currentAveragePeriod = 0;

  let baselineTimer = null, baselineBPMs = [], baselineStartTime = 0;
  let isFingerPresent = false, currentSqiValue = 0, lastBeatPerfTime = performance.now(), sensorCheckInterval = null;
  let dialEl, dialAngle = 0, dialDragging = false, dialCx = 0, dialCy = 0, lastAngle = 0;
  let trialVisualOffset = 0, currentKnobValue = 0, currentTrialIndex = -(NUM_PRACTICES);
  let trialDetectorRunning = false, trialRunning = false;

  // ----------------------------------------------------------
  // DIAL INIT
  // ----------------------------------------------------------
  function initDial() {
    dialEl = document.getElementById("rotary-dial");
    if (!dialEl) return;

    // Generate tick marks
    const tickContainer = document.getElementById("rotary-dial-ticks");
    if (tickContainer && !tickContainer.dataset.built) {
      tickContainer.dataset.built = "1";
      for (let i = 0; i < 72; i++) {
        const tick = document.createElement('div');
        tick.className = 'dial-tick';
        tick.style.transform = `rotate(${i * 5}deg)`;
        if (i % 2 === 0) tick.style.height = '10px';
        if (i % 18 === 0) { tick.style.height = '14px'; tick.style.background = 'var(--fg-muted)'; }
        tickContainer.appendChild(tick);
      }
    }

    dialEl.addEventListener("pointerdown", (e) => {
      e.preventDefault(); dialDragging = true;
      const rect = dialEl.getBoundingClientRect();
      dialCx = rect.left + rect.width / 2; dialCy = rect.top + rect.height / 2;
      lastAngle = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
      dialEl.setPointerCapture(e.pointerId);
    }, { passive: false });

    window.addEventListener("pointermove", (e) => {
      if (!dialDragging) return; e.preventDefault();
      const a = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
      let d = a - lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      dialAngle += d; lastAngle = a;
      dialEl.style.transform = `rotate(${dialAngle}rad)`;

      let rawPhase = ((dialAngle + trialVisualOffset) / Math.PI) % 2;
      if (rawPhase > 1) rawPhase -= 2;
      if (rawPhase < -1) rawPhase += 2;
      currentKnobValue = rawPhase;
      document.getElementById("confirm-trial-btn").disabled = false;
    }, { passive: false });

    window.addEventListener("pointerup", () => { dialDragging = false; });
  }

  // ----------------------------------------------------------
  // SENSOR WATCHDOG
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
  // IBI QUALITY TRACKING
  // ----------------------------------------------------------
  function processIbi(beat) {
    const ibiMs = beat.instantPeriod * 1000;
    let flag = null;
    if (trialLastIbi > 0) {
      const changeFrac = Math.abs(ibiMs - trialLastIbi) / trialLastIbi;
      if (changeFrac > IBI_CHANGE_THRESHOLD) {
        flag = { type: 'successive_diff', magnitude: Math.round(changeFrac * 1000) / 10, prevIbi: Math.round(trialLastIbi), currentIbi: Math.round(ibiMs) };
        trialFlaggedBeats++;
      } else { trialCleanBeats++; }
    } else { trialCleanBeats++; }
    trialLastIbi = ibiMs;
    trialIbiFlags.push({ time: beat.time, ibiMs: Math.round(ibiMs * 10) / 10, flag });
  }

  // ----------------------------------------------------------
  // PRE-TRIAL INSTRUCTION SCREEN
  // Shown after baseline completes and before every ePAT block.
  // Uses screen-onboarding which already exists in the HTML shell.
  // ----------------------------------------------------------
  function showPreTrialInstructions(onContinue) {
    show("screen-onboarding");
    const container = document.getElementById("onboarding-container");
    const nextBtn   = document.getElementById("onboarding-next-btn");

    container.innerHTML = `
      <div style="text-align:center; padding: 8px 0 32px;">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:20px;">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <h1 style="margin-bottom:12px;">Heartbeat Task</h1>
        <p style="margin-bottom:32px;">Place your fingertip firmly over the <strong style="color:var(--fg);">rear camera and flashlight</strong>. You'll hear a tone — rotate the dial until the tone lands exactly on each heartbeat.</p>

        <div style="width:100%; max-width:340px; margin: 0 auto 24px; text-align:left;">
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">📷</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Camera + Flashlight</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Cover the lens closest to the flash completely. The circle on screen should glow solid red.</div>
            </div>
          </div>
          <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">🎧</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Turn volume up</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">You need to hear the tone clearly. Silent mode will block it.</div>
            </div>
          </div>
          <div style="display:flex; align-items:flex-start; gap:14px;">
            <div style="width:36px; height:36px; border-radius:50%; background:var(--bg-elevated); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:1rem;">🤚</div>
            <div>
              <div style="font-size:0.95rem; font-weight:600; color:var(--fg); margin-bottom:3px;">Stay still</div>
              <div style="font-size:0.85rem; color:var(--fg-muted); line-height:1.4;">Any movement affects the heart rate signal. Rest your elbow on a surface if possible.</div>
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
  // BASELINE
  // ----------------------------------------------------------
  async function startBaseline() {
    show("screen-baseline");
    baselineBPMs = []; baselineStartTime = Date.now();
    currentTrialIndex = -(NUM_PRACTICES);
    initDial();

    const bpmEl = document.getElementById("baseline-bpm");
    const progressCircle = document.getElementById("baseline-progress-circle");
    const circ = 2 * Math.PI * 85;
    const DUR = isPreview ? 3 : 120;

    if (!core) {
      // Preview / no-core simulation
      let elapsed = 0;
      bpmEl.textContent = '65';
      baselineTimer = setInterval(() => {
        elapsed += 1;
        progressCircle.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / DUR));
        if (elapsed >= DUR) {
          clearInterval(baselineTimer);
          sessionData.data.push({ type: "baseline", ppgSampleRate: 30, finalSqi: 0.5 });
          showPreTrialInstructions(() => startTrial());
        }
      }, 1000);
      return;
    }

    await core.WakeLockCtrl.request();
    const videoElement = document.getElementById("video-feed");
    const previewCtx = document.getElementById("sensor-preview-circle").getContext("2d");
    document.getElementById("sensor-preview-circle").width = 120 * (window.devicePixelRatio || 1);
    document.getElementById("sensor-preview-circle").height = 120 * (window.devicePixelRatio || 1);

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
      const elapsed = (Date.now() - baselineStartTime) / 1000, remaining = Math.max(0, DUR - elapsed);
      progressCircle.style.strokeDashoffset = circ * (1 - Math.min(1, elapsed / DUR));

      if (remaining <= 0) {
        clearInterval(baselineTimer); stopSensorWatchdog();
        core.BeatDetector.setCallbacks({ onBeatCb: null, onFingerChangeCb: null, onPPGSampleCb: null, onSqiUpdateCb: null, onDicroticRejectCb: null });
        trialDetectorRunning = true;

        const diagnostics = core.BeatDetector.getDiagnostics();
        const finalSqi = core.BeatDetector.getSqi();

        if (!isPreview && (baselineBPMs.length < 80 || diagnostics.clipRate > 20 || finalSqi < 0.002)) {
          await core.BeatDetector.stop(); trialDetectorRunning = false;
          setTimeout(() => startBaseline(), 4000); // Silent restart
          return;
        }

        sessionData.data.push({
          type: "baseline", recordedHR: baselineBPMs.map(Math.round),
          totalBeats: baselineBPMs.length, ppgSampleRate: core.BeatDetector.getActualFPS(),
          ppgDiagnostics: diagnostics, finalSqi: finalSqi
        });

        // Show instructions before first trial
        showPreTrialInstructions(() => startTrial());
      }
    }, 1000);
  }

  // ----------------------------------------------------------
  // TRIAL
  // ----------------------------------------------------------
  async function startTrial() {
    show("screen-trial");
    trialIP = []; trialAP = []; trialKS = []; trialCD = []; trialIE = [];
    trialRecordedHR = []; trialInstantBpms = [];
    trialToneTimings = []; trialFingerLossEvents = [];
    trialLastIbi = 0; trialCleanBeats = 0; trialFlaggedBeats = 0; trialIbiFlags = [];
    trialSqiTimeSeries = []; trialSqiBadSeconds = 0; trialLastSqiCheckTime = 0; trialDicroticRejections = [];
    currentInstantPeriod = 0; currentAveragePeriod = 0;

    // Randomize knob starting position per trial
    trialVisualOffset = (Math.random() * 2 - 1) * Math.PI;
    dialAngle = 0;
    if (dialEl) dialEl.style.transform = `rotate(0rad)`;

    let rawPhase = ((dialAngle + trialVisualOffset) / Math.PI) % 2;
    if (rawPhase > 1) rawPhase -= 2;
    if (rawPhase < -1) rawPhase += 2;
    currentKnobValue = rawPhase;
    trialInitialKnob = currentKnobValue;

    trialRunning = true;
    document.getElementById("trial-label").textContent = currentTrialIndex < 0
      ? `Practice Trial ${NUM_PRACTICES + currentTrialIndex + 1}`
      : `Trial ${currentTrialIndex + 1} of ${NUM_TRIALS}`;
    document.getElementById("confirm-trial-btn").disabled = true;

    if (!core) return;

    core.MotionDetector.start();
    const videoElement = document.getElementById("video-feed");
    const previewCtx = document.getElementById("sensor-preview-circle").getContext("2d");
    document.getElementById("sensor-preview-circle").width = 120 * (window.devicePixelRatio || 1);
    document.getElementById("sensor-preview-circle").height = 120 * (window.devicePixelRatio || 1);

    startSensorWatchdog();

    const beatCb = (beat) => {
      lastBeatPerfTime = performance.now();
      const prev = currentInstantPeriod;
      currentInstantPeriod = beat.instantPeriod; currentAveragePeriod = beat.averagePeriod;
      trialIP.push(currentInstantPeriod); trialAP.push(currentAveragePeriod);
      trialKS.push(currentKnobValue); trialIE.push(prev - currentInstantPeriod);

      const delay = (currentAveragePeriod / 2) * currentKnobValue;
      trialCD.push(delay); trialRecordedHR.push(beat.instantBPM); trialInstantBpms.push(beat.averageBPM);
      processIbi(beat);

      const dNow = delay < 0 ? currentInstantPeriod + delay : delay;
      if (dNow > 0 && dNow < 3) {
        const timing = core.AudioEngine.scheduleAt(dNow);
        if (timing) trialToneTimings.push({ beatTime: beat.time, intendedDelay: dNow, scheduledAt: timing.scheduledAt, perfNow: timing.perfNow });
      }

      if (core.MotionDetector.checkMovement()) {
        const w = document.getElementById("trial-movement-warning");
        if (w) { w.classList.add("visible"); clearTimeout(w._t); w._t = setTimeout(() => w.classList.remove("visible"), 2000); }
      }
    };

    const fCb = (p) => {
      isFingerPresent = p; updateSensorWarning();
      if (!p) { trialFingerLossEvents.push({ lostAt: performance.now() }); }
      else if (trialFingerLossEvents.length > 0 && !trialFingerLossEvents[trialFingerLossEvents.length - 1].restoredAt) {
        trialFingerLossEvents[trialFingerLossEvents.length - 1].restoredAt = performance.now();
      }
    };

    const sqiCb = (sqi) => {
      currentSqiValue = sqi; updateSensorWarning();
      const now = Date.now();
      if (trialLastSqiCheckTime > 0 && sqi < SQI_WARN) { trialSqiBadSeconds += (now - trialLastSqiCheckTime) / 1000; }
      trialLastSqiCheckTime = now;
      trialSqiTimeSeries.push({ time: now, sqi: Math.round(sqi * 100000) / 100000 });
    };

    const ppgCb = () => {
      if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        previewCtx.drawImage(videoElement, 0, 0, 120 * (window.devicePixelRatio || 1), 120 * (window.devicePixelRatio || 1));
      }
    };

    if (!trialDetectorRunning) {
      await core.BeatDetector.start({ video: videoElement, canvas: document.getElementById("sampling-canvas"), onBeatCb: beatCb, onFingerChangeCb: fCb, onSqiUpdateCb: sqiCb, onDicroticRejectCb: (info) => trialDicroticRejections.push(info), onPPGSampleCb: ppgCb });
      trialDetectorRunning = true;
    } else {
      core.BeatDetector.setCallbacks({ onBeatCb: beatCb, onFingerChangeCb: fCb, onSqiUpdateCb: sqiCb, onDicroticRejectCb: (info) => trialDicroticRejections.push(info), onPPGSampleCb: ppgCb });
    }
  }

  // ----------------------------------------------------------
  // END TRIAL
  // ----------------------------------------------------------
  function endTrial() {
    trialRunning = false;
    if (core) {
      core.MotionDetector.stop(); stopSensorWatchdog();
      core.BeatDetector.setCallbacks({ onBeatCb: null, onFingerChangeCb: null, onSqiUpdateCb: null, onDicroticRejectCb: null, onPPGSampleCb: null });
    }

    const totalBeats = trialCleanBeats + trialFlaggedBeats;
    const td = {
      type: "trial", isPractice: currentTrialIndex < 0,
      initialKnobValue: trialInitialKnob, visualOffset: trialVisualOffset,
      instantPeriods: [...trialIP], averagePeriods: [...trialAP],
      knobScales: [...trialKS], currentDelays: [...trialCD], instantErrs: [...trialIE],
      recordedHR: [...trialRecordedHR], instantBpms: [...trialInstantBpms],
      toneTimings: [...trialToneTimings], fingerLossEvents: [...trialFingerLossEvents],
      confidence: -1, bodyPos: -1,
      ppgDiagnostics: core ? core.BeatDetector.getDiagnostics() : {},
      ibiFlags: [...trialIbiFlags], sqiTimeSeries: [...trialSqiTimeSeries],
      dicroticRejections: [...trialDicroticRejections],
      qualitySummary: {
        totalBeats, cleanBeats: trialCleanBeats, flaggedBeats: trialFlaggedBeats,
        flagRate: totalBeats > 0 ? Math.round(trialFlaggedBeats / totalBeats * 10000) / 100 : 0,
        dicroticRejectsCount: trialDicroticRejections.length,
        sqiBadSeconds: Math.round(trialSqiBadSeconds * 10) / 10,
        sqiFinalValue: core ? Math.round(core.BeatDetector.getSqi() * 100000) / 100000 : 0,
        ibiChangeThreshold: IBI_CHANGE_THRESHOLD, sqiGoodThreshold: SQI_GOOD, sqiWarnThreshold: SQI_WARN
      }
    };

    if (core) { td.audioDropLog = core.AudioEngine.getDropLog(); td.audioCtxState = core.AudioEngine.getState(); core.AudioEngine.clearDropLog(); core.AudioEngine.resetSchedulerState(); }

    // Confidence rating (if enabled)
    if (config.modules?.epat?.confidence_ratings) {
      show("screen-ema");
      document.getElementById("ema-progress-fill").style.width = "100%";
      const container = document.getElementById("ema-single-container");
      container.innerHTML = `
        <div class="ema-question">How confident are you that the sound matched your heartbeat?</div>
        <div class="slider-group">
          <div class="slider-val-display" id="conf-val">5</div>
          <input type="range" class="range-slider" id="conf-slider" min="0" max="9" step="1" value="5">
          <div class="slider-labels"><span>Guessing</span><span>Certain</span></div>
        </div>
      `;
      const sl = document.getElementById("conf-slider");
      const vd = document.getElementById("conf-val");
      const btn = document.getElementById("ema-next-btn");
      btn.textContent = "Submit"; btn.disabled = true;
      sl.oninput = () => { vd.textContent = sl.value; btn.disabled = false; };
      btn.onclick = () => {
        td.confidence = parseInt(sl.value);
        btn.onclick = null;
        afterConfidence(td);
      };
    } else {
      afterConfidence(td);
    }
  }

  function afterConfidence(td) {
    // Body map (if enabled, every N trials)
    if (config.modules?.epat?.body_map && currentTrialIndex >= 0 && (currentTrialIndex + 1) % BODY_MAP_EVERY === 0) {
      show("screen-bodymap");
      const parts = document.querySelectorAll(".body-part");
      const nowhereBtn = document.getElementById("nowhere-btn");
      const confirmBtn = document.getElementById("confirm-bodymap-btn");
      let sel = -1; confirmBtn.disabled = true;
      parts.forEach(p => {
        p.classList.remove("selected");
        p.onclick = () => { parts.forEach(pp => pp.classList.remove("selected")); if (nowhereBtn) nowhereBtn.classList.remove("selected"); p.classList.add("selected"); sel = parseInt(p.dataset.value); confirmBtn.disabled = false; };
      });
      if (nowhereBtn) { nowhereBtn.classList.remove("selected"); nowhereBtn.onclick = () => { parts.forEach(pp => pp.classList.remove("selected")); nowhereBtn.classList.add("selected"); sel = 8; confirmBtn.disabled = false; }; }
      confirmBtn.onclick = () => { td.bodyPos = sel; confirmBtn.onclick = null; sessionData.data.push(td); wrapTrial(); };
    } else {
      sessionData.data.push(td);
      wrapTrial();
    }
  }

  async function wrapTrial() {
    currentTrialIndex++;
    if (currentTrialIndex >= NUM_TRIALS) {
      if (core) { trialDetectorRunning = false; await core.BeatDetector.stop(); core.WakeLockCtrl.release(); }
      advancePhase();
    } else {
      startTrial();
    }
  }

  document.getElementById("confirm-trial-btn").addEventListener('click', () => {
    if (core) core.AudioEngine.resume();
    endTrial();
  });

  return { startBaseline };
})();