// ==========================================================
// ONBOARDING ENGINE
// ==========================================================
const OnboardingSession = (function() {

  function initConsent() {
    const scroll   = document.getElementById("ob-consent-scroll");
    const check    = document.getElementById("ob-consent-check");
    const nextBtn  = document.getElementById("ob-consent-next");
    const initials = document.getElementById("ob-initials");
    const hint     = document.getElementById("ob-consent-hint");
    const checkRow = document.getElementById("ob-consent-check-row");

    scroll.innerHTML = config.onboarding.consent_text;

    scroll.addEventListener("scroll", () => {
      if (scroll.scrollHeight - scroll.scrollTop <= scroll.clientHeight + 40) {
        if (checkRow) { checkRow.style.opacity = "1"; checkRow.style.pointerEvents = "auto"; }
        if (initials) initials.disabled = false;
        if (hint) hint.style.opacity = "0";
      }
    });

    const updateNext = () => {
      if (nextBtn) nextBtn.disabled = !(check && check.checked && initials && initials.value.trim().length >= 1);
    };
    if (check) check.addEventListener("change", updateNext);
    if (initials) initials.addEventListener("input", updateNext);

    if (nextBtn) nextBtn.onclick = () => {
      sessionData.data.push({ type: "consent", agreed: true, initials: initials ? initials.value.trim().toUpperCase() : '', timestamp: new Date().toISOString() });
      if (config.onboarding.ask_schedule !== false) {
        show("screen-ob-schedule");
      } else if (config.modules?.epat && window.ePATCore) {
        show("screen-ob-device");
      } else {
        show("screen-ob-complete");
      }
    };
  }

  function initSchedule() {
    const grid = document.getElementById("ob-day-grid");
    if (!grid) return;
    grid.querySelectorAll(".day-btn").forEach(btn => btn.addEventListener("click", () => btn.classList.toggle("selected")));

    const nextBtn = document.getElementById("ob-schedule-next");
    if (nextBtn) nextBtn.onclick = () => {
      sessionData.data.push({
        type: "schedule_pref",
        days: [...grid.querySelectorAll(".day-btn.selected")].map(b => b.dataset.day),
        windows: {
          morning:   { start: (document.getElementById("ob-am-start") || {}).value, end: (document.getElementById("ob-am-end") || {}).value },
          afternoon: { start: (document.getElementById("ob-pm-start") || {}).value, end: (document.getElementById("ob-pm-end") || {}).value },
          evening:   { start: (document.getElementById("ob-ev-start") || {}).value, end: (document.getElementById("ob-ev-end") || {}).value }
        }
      });
      if (config.modules?.epat && window.ePATCore) {
        show("screen-ob-device");
      } else {
        show("screen-ob-complete");
      }
    };
  }

  function initDevice() {
    const checks = { camera: false, torch: false, audio: false, signal: false };
    const BeatDetector = window.ePATCore ? window.ePATCore.BeatDetector : null;
    const statusEl = document.getElementById("ob-device-status");

    function setCheck(id, state, msg) {
      const el = document.getElementById("ob-check-" + id);
      const st = document.getElementById("ob-check-" + id + "-status");
      if (el) el.className = "check-item" + (state ? " " + state : "");
      if (st && msg) st.textContent = msg;
    }

    const startBtn = document.getElementById("ob-device-start");
    if (!startBtn) return;

    startBtn.onclick = async () => {
      startBtn.style.display = "none";
      if (statusEl) statusEl.textContent = "Running checks…";

      // Camera
      try {
        setCheck("camera", "testing", "Requesting access…");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        stream.getTracks().forEach(t => t.stop());
        checks.camera = true; setCheck("camera", "pass", "Access granted");
      } catch(e) { setCheck("camera", "fail", "Permission denied"); }

      // Torch
      try {
        setCheck("torch", "testing", "Testing flashlight…");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const track = stream.getVideoTracks()[0];
        if (track.getCapabilities && track.getCapabilities().torch) {
          await track.applyConstraints({ advanced: [{ torch: true }] });
          await new Promise(r => setTimeout(r, 400));
          await track.applyConstraints({ advanced: [{ torch: false }] });
          checks.torch = true; setCheck("torch", "pass", "Flashlight available");
        } else { setCheck("torch", "fail", "Not available on this device"); }
        stream.getTracks().forEach(t => t.stop());
      } catch(e) { setCheck("torch", "fail", "Error: " + e.message); }

      // Audio
      try {
        setCheck("audio", "testing", "Playing test tone…");
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        await actx.resume();
        const osc = actx.createOscillator(), gain = actx.createGain();
        osc.connect(gain); gain.connect(actx.destination);
        gain.gain.setValueAtTime(0.15, actx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.2);
        osc.start(); osc.stop(actx.currentTime + 0.2);
        await new Promise(r => setTimeout(r, 300));
        actx.close();
        checks.audio = true; setCheck("audio", "pass", "Audio OK");
      } catch(e) { setCheck("audio", "fail", "Audio error"); }

      // PPG Signal
      if (BeatDetector) {
        setCheck("signal", "testing", "Place finger on camera…");
        if (statusEl) statusEl.textContent = "Place your finger on the camera and flashlight…";

        const previewWrap = document.getElementById("ob-signal-preview-wrap");
        const previewCanvas = document.getElementById("ob-signal-preview");
        let previewCtx = null;
        if (previewCanvas) {
          const dpr = window.devicePixelRatio || 1;
          previewCanvas.width = 80 * dpr; previewCanvas.height = 80 * dpr;
          previewCtx = previewCanvas.getContext("2d");
          if (previewWrap) previewWrap.style.display = "flex";
        }

        let beatCount = 0;
        await new Promise(resolve => {
          const timeout = setTimeout(() => {
            if (previewWrap) previewWrap.style.display = "none";
            setCheck("signal", "fail", "No signal — try again"); resolve();
          }, 20000);

          BeatDetector.start({
            video: document.getElementById("video-feed"),
            canvas: document.getElementById("sampling-canvas"),
            onBeatCb: (beat) => {
              beatCount++;
              setCheck("signal", "testing", `Detecting… ${beatCount} beats`);
              if (beatCount >= 5) {
                clearTimeout(timeout);
                checks.signal = true;
                if (previewWrap) previewWrap.style.display = "none";
                setCheck("signal", "pass", `Signal confirmed — ${Math.round(beat.averageBPM)} BPM`);
                BeatDetector.stop();
                resolve();
              }
            },
            onFingerChangeCb: (p) => {
              if (statusEl) statusEl.textContent = p ? "Finger detected, measuring…" : "Place finger on camera and flashlight…";
              if (previewCanvas) previewCanvas.style.borderColor = p ? "var(--accent)" : "var(--border)";
            },
            onPPGSampleCb: () => {
              const vid = document.getElementById("video-feed");
              if (vid && vid.readyState === vid.HAVE_ENOUGH_DATA && previewCtx) {
                const dpr = window.devicePixelRatio || 1;
                previewCtx.drawImage(vid, 0, 0, 80 * dpr, 80 * dpr);
              }
            }
          });
        });
      } else {
        checks.signal = true; setCheck("signal", "pass", "Skipped (no core)");
      }

      const allPass = Object.values(checks).every(v => v);
      if (statusEl) {
        statusEl.textContent = allPass ? "All checks passed." : "Some checks failed — you may still continue.";
        statusEl.style.color = allPass ? "var(--accent-green)" : "var(--fg-muted)";
      }
      const nextEl = document.getElementById("ob-device-next");
      const retryEl = document.getElementById("ob-device-retry");
      if (nextEl) nextEl.style.display = "block";
      if (!allPass && retryEl) retryEl.style.display = "block";
    };

    const retryEl = document.getElementById("ob-device-retry");
    if (retryEl) retryEl.onclick = () => {
      ["camera","torch","audio","signal"].forEach(id => setCheck(id, "", "Waiting…"));
      if (statusEl) statusEl.textContent = "";
      const nextEl = document.getElementById("ob-device-next");
      if (nextEl) nextEl.style.display = "none";
      retryEl.style.display = "none";
      startBtn.style.display = "block";
    };

    const nextEl = document.getElementById("ob-device-next");
    if (nextEl) nextEl.onclick = () => show("screen-ob-training");
  }

  function initTraining() {
    const nextBtn = document.getElementById("ob-training-next");
    if (!nextBtn) return;

    if (isPreview) {
      nextBtn.disabled = false;
      nextBtn.onclick = () => show("screen-ob-complete");
      return;
    }

    const SIM_BPM = 65, SIM_PERIOD_MS = (60 / SIM_BPM) * 1000;
    const ALIGN_THRESHOLD = 0.12, ALIGN_HOLD_MS = 2000;

    let dialAngle = 0, dialDragging = false, dialCx = 0, dialCy = 0, lastDialAngle = 0;
    const INITIAL_KNOB = 0.5;
    let knobValue = INITIAL_KNOB;
    dialAngle = INITIAL_KNOB * Math.PI;
    let simStartTime = null, animFrameId = null;
    let alignedSince = null, gateUnlocked = false;
    let lastScheduledBeat = -1, trainingACtx = null;

    const canvas = document.getElementById("training-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const statusEl = document.getElementById("training-status");
    const dialEl = document.getElementById("training-dial");

    // Build training dial ticks
    const tickContainer = document.getElementById("training-dial-ticks");
    if (tickContainer && !tickContainer.dataset.built) {
      tickContainer.dataset.built = "1";
      for (let i = 0; i < 60; i++) {
        const t = document.createElement("div"); t.className = "training-tick";
        t.style.transform = `rotate(${i * 6}deg)`;
        if (i % 2 === 0) t.style.height = "8px";
        if (i % 15 === 0) { t.style.height = "12px"; t.style.background = "var(--fg-muted)"; }
        tickContainer.appendChild(t);
      }
    }

    if (dialEl) {
      dialEl.addEventListener("pointerdown", (e) => {
        e.preventDefault(); dialDragging = true;
        const r = dialEl.getBoundingClientRect();
        dialCx = r.left + r.width / 2; dialCy = r.top + r.height / 2;
        lastDialAngle = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
        dialEl.setPointerCapture(e.pointerId);
      }, { passive: false });

      window.addEventListener("pointermove", (e) => {
        if (!dialDragging) return; e.preventDefault();
        const a = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
        let d = a - lastDialAngle;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        dialAngle += d; lastDialAngle = a;
        dialEl.style.transform = `rotate(${dialAngle}rad)`;
        let raw = (dialAngle / Math.PI) % 2;
        if (raw > 1) raw -= 2; if (raw < -1) raw += 2;
        knobValue = raw;
      }, { passive: false });

      window.addEventListener("pointerup", () => { dialDragging = false; });
    }

    function playTone(delayS) {
      if (!trainingACtx) trainingACtx = new (window.AudioContext || window.webkitAudioContext)();
      if (trainingACtx.state === "suspended") trainingACtx.resume();
      const when = trainingACtx.currentTime + Math.max(0, delayS);
      const osc = trainingACtx.createOscillator(), gain = trainingACtx.createGain();
      osc.connect(gain); gain.connect(trainingACtx.destination);
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.18, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
      osc.start(when); osc.stop(when + 0.1);
    }

    function draw(ts) {
      if (!simStartTime) simStartTime = ts;
      const elapsed = ts - simStartTime;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== canvas.clientWidth * dpr) {
        canvas.width = canvas.clientWidth * dpr;
        canvas.height = canvas.clientHeight * dpr;
      }
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const WINDOW_MS = 3000;
      const beatCount = Math.floor(elapsed / SIM_PERIOD_MS);
      const beatsInWindow = Math.ceil(WINDOW_MS / SIM_PERIOD_MS) + 2;

      ctx.strokeStyle = "rgba(142,142,147,0.45)"; ctx.lineWidth = 1.5 * dpr;
      for (let i = -1; i <= beatsInWindow; i++) {
        const beatTime = (beatCount - beatsInWindow + i) * SIM_PERIOD_MS;
        const age = elapsed - beatTime;
        const x = (1 - age / WINDOW_MS) * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }

      const toneOffset = (SIM_PERIOD_MS / 2) * knobValue;
      ctx.strokeStyle = "rgba(232,113,106,0.85)"; ctx.lineWidth = 2 * dpr;
      for (let i = -1; i <= beatsInWindow; i++) {
        const beatTime = (beatCount - beatsInWindow + i) * SIM_PERIOD_MS;
        const toneTime = beatTime + toneOffset;
        const age = elapsed - toneTime;
        const x = (1 - age / WINDOW_MS) * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }

      if (lastScheduledBeat !== beatCount) {
        const fireMs = (beatCount + 1) * SIM_PERIOD_MS + toneOffset;
        const msUntil = fireMs - elapsed;
        if (msUntil > 0) playTone(msUntil / 1000);
        lastScheduledBeat = beatCount;
      }

      const isAligned = Math.abs(knobValue / 2) < ALIGN_THRESHOLD;
      if (isAligned) {
        if (!alignedSince) alignedSince = ts;
        const held = ts - alignedSince;
        if (statusEl) { statusEl.textContent = held >= ALIGN_HOLD_MS ? "Aligned — well done!" : "Hold it there…"; statusEl.className = "training-status aligned"; }
        if (held >= ALIGN_HOLD_MS && !gateUnlocked) { gateUnlocked = true; nextBtn.disabled = false; }
      } else {
        alignedSince = null;
        if (statusEl) { statusEl.textContent = "Rotate the dial to align the tone with the beats"; statusEl.className = "training-status"; }
      }

      animFrameId = requestAnimationFrame(draw);
    }

    const trainingScreen = document.getElementById("screen-ob-training");
    if (trainingScreen) {
      const observer = new MutationObserver(() => {
        const active = trainingScreen.classList.contains("active");
        if (active && !animFrameId) {
          if (dialEl) dialEl.style.transform = `rotate(${dialAngle}rad)`;
          simStartTime = null; lastScheduledBeat = -1; animFrameId = requestAnimationFrame(draw);
        } else if (!active && animFrameId) {
          cancelAnimationFrame(animFrameId); animFrameId = null;
        }
      });
      observer.observe(trainingScreen, { attributes: true, attributeFilter: ["class"] });
    }

    nextBtn.onclick = () => {
      if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
      if (trainingACtx) { trainingACtx.close(); trainingACtx = null; }
      show("screen-ob-complete");
    };
  }

  function initComplete() {
    // ---- FIX: correct element ID is "ob-complete-pat" not "ob-complete" ----
    const completeBtn = document.getElementById("ob-complete-pat");
    if (completeBtn) {
      completeBtn.onclick = () => {
        // Hand off to the normal phase runner — onboarding is done,
        // now run whatever phases are in sessionData.phases (if any),
        // or just finalize if there are none.
        sessionData.type = "onboarding_complete";
        sessionData.completedOnboarding = new Date().toISOString();
        // If ePAT is configured and enabled, kick off a fresh PAT-only run
        if (config.modules?.epat && window.ePATCore && typeof ePAT !== 'undefined') {
          sessionData.phases = ['epat'];
          sessionData.currentPhase = 0;
          runNextPhase();
        } else {
          advancePhase();
        }
      };
    }
  }

  return {
    start() {
      initConsent();
      initSchedule();
      initDevice();
      initTraining();
      initComplete();
      show("screen-ob-consent");
    }
  };
})();