// ==========================================================
// ONBOARDING ENGINE
// ==========================================================
const OnboardingSession = (function() {
  function initConsent() {
    const scroll = document.getElementById("ob-consent-scroll");
    const check = document.getElementById("ob-consent-check");
    const nextBtn = document.getElementById("ob-consent-next");
    const initials = document.getElementById("ob-initials");
    
    scroll.innerHTML = config.onboarding.consent_text;

    scroll.addEventListener("scroll", () => {
      if (scroll.scrollHeight - scroll.scrollTop <= scroll.clientHeight + 40) {
        document.getElementById("ob-consent-check-row").style.opacity = "1";
        document.getElementById("ob-consent-check-row").style.pointerEvents = "auto";
        initials.disabled = false;
        document.getElementById("ob-consent-hint").style.opacity = "0";
      }
    });

    const updateNext = () => nextBtn.disabled = !(check.checked && initials.value.trim().length >= 1);
    check.addEventListener("change", updateNext);
    initials.addEventListener("input", updateNext);

    nextBtn.onclick = () => {
      sessionData.data.push({ type: "consent", agreed: true, initials: initials.value.trim().toUpperCase(), timestamp: new Date().toISOString() });

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
    grid.querySelectorAll(".day-btn").forEach(btn => btn.addEventListener("click", () => btn.classList.toggle("selected")));
    document.getElementById("ob-schedule-next").onclick = () => {
      sessionData.data.push({
        type: "schedule_pref",
        days: [...grid.querySelectorAll(".day-btn.selected")].map(b => b.dataset.day),
        windows: {
          morning:   { start: document.getElementById("ob-am-start").value, end: document.getElementById("ob-am-end").value },
          afternoon: { start: document.getElementById("ob-pm-start").value, end: document.getElementById("ob-pm-end").value },
          evening:   { start: document.getElementById("ob-ev-start").value, end: document.getElementById("ob-ev-end").value }
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

    function setCheck(id, state, msg) {
      const el = document.getElementById("ob-check-" + id);
      const st = document.getElementById("ob-check-" + id + "-status");
      if(el) el.className = "check-item" + (state ? " " + state : "");
      if (st && msg) st.textContent = msg;
    }

    document.getElementById("ob-device-start").onclick = async () => {
      if (isPreview) {
        document.getElementById("ob-device-start").style.display = "none";
        document.getElementById("ob-device-next").style.display = "block";
        document.getElementById("ob-device-status").textContent = "Camera & PPG simulated ok for studio.";
        ["camera","torch","audio","signal"].forEach(id => setCheck(id, "pass", "Pass (Simulated)"));
        return;
      }

      document.getElementById("ob-device-start").style.display = "none";
      const statusEl = document.getElementById("ob-device-status");
      statusEl.textContent = "Running checks…";

      try {
        setCheck("camera", "testing", "Requesting access…");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        stream.getTracks().forEach(t => t.stop());
        checks.camera = true; setCheck("camera", "pass", "Access granted");
      } catch(e) { setCheck("camera", "fail", "Permission denied"); }

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

      if (BeatDetector) {
        setCheck("signal", "testing", "Place finger on camera…");
        statusEl.textContent = "Place your finger on the camera and flashlight…";
        
        const previewWrap = document.getElementById("ob-signal-preview-wrap");
        const previewCanvas = document.getElementById("ob-signal-preview");
        const dpr = window.devicePixelRatio || 1;
        previewCanvas.width = 80 * dpr; previewCanvas.height = 80 * dpr;
        const previewCtx = previewCanvas.getContext("2d");
        previewWrap.style.display = "flex";

        let beatCount = 0;
        await new Promise(resolve => {
          const timeout = setTimeout(() => {
            previewWrap.style.display = "none";
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
                previewWrap.style.display = "none";
                setCheck("signal", "pass", `Signal confirmed — ${Math.round(beat.averageBPM)} BPM`);
                BeatDetector.stop();
                resolve();
              }
            },
            onFingerChangeCb: (p) => {
              statusEl.textContent = p ? "Finger detected, measuring…" : "Place finger on camera and flashlight…";
              previewCanvas.style.borderColor = p ? "var(--accent)" : "var(--border)";
            },
            onPPGSampleCb: () => {
              const vid = document.getElementById("video-feed");
              if (vid && vid.readyState === vid.HAVE_ENOUGH_DATA) previewCtx.drawImage(vid, 0, 0, 80 * dpr, 80 * dpr);
            }
          });
        });
      }

      const allPass = Object.values(checks).every(v => v);
      statusEl.textContent = allPass ? "All checks passed." : "Some checks failed — you may still continue.";
      statusEl.style.color = allPass ? "var(--accent-green)" : "var(--fg-muted)";
      document.getElementById("ob-device-next").style.display = "block";
      if (!allPass) document.getElementById("ob-device-retry").style.display = "block";
    };

    document.getElementById("ob-device-retry").onclick = () => {
      ["camera","torch","audio","signal"].forEach(id => setCheck(id, "", "Waiting…"));
      document.getElementById("ob-device-status").textContent = "";
      document.getElementById("ob-device-next").style.display = "none";
      document.getElementById("ob-device-retry").style.display = "none";
      document.getElementById("ob-device-start").style.display = "block";
    };

    document.getElementById("ob-device-next").onclick = () => show("screen-ob-training");
  }

  function initTraining() {
    const nextBtn = document.getElementById("ob-training-next");
    if (isPreview) {
      nextBtn.disabled = false;
      nextBtn.onclick = () => show("screen-ob-complete");
      return;
    }

    const SIM_BPM = 65, SIM_PERIOD_MS = (60 / SIM_BPM) * 1000, ALIGN_THRESHOLD = 0.12, ALIGN_HOLD_MS = 2000;
    let dialAngle = 0, dialDragging = false, dialCx = 0, dialCy = 0, lastDialAngle = 0;
    const INITIAL_KNOB = 0.5; let knobValue = INITIAL_KNOB;
    dialAngle = INITIAL_KNOB * Math.PI;
    let simStartTime = null, animFrameId = null, alignedSince = null, gateUnlocked = false;
    let lastScheduledBeat = -1, trainingACtx = null;

    const canvas = document.getElementById("training-canvas");
    const ctx = canvas.getContext("2d");
    const statusEl = document.getElementById("training-status");
    const dialEl = document.getElementById("training-dial");

    dialEl.addEventListener("pointerdown", (e) => {
      e.preventDefault(); dialDragging = true;
      const r = dialEl.getBoundingClientRect(); dialCx = r.left + r.width / 2; dialCy = r.top + r.height / 2;
      lastDialAngle = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
      dialEl.setPointerCapture(e.pointerId);
    }, { passive: false });

    window.addEventListener("pointermove", (e) => {
      if (!dialDragging) return; e.preventDefault();
      const a = Math.atan2(e.clientY - dialCy, e.clientX - dialCx);
      let d = a - lastDialAngle;
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      dialAngle += d; lastDialAngle = a;
      dialEl.style.transform = `rotate(${dialAngle}rad)`;
      let raw = (dialAngle / Math.PI) % 2;
      if (raw > 1) raw -= 2; if (raw < -1) raw += 2;
      knobValue = raw;
    }, { passive: false });
    window.addEventListener("pointerup", () => { dialDragging = false; });

    function playTone(delayS) {
      if (!trainingACtx) trainingACtx = new (window.AudioContext || window.webkitAudioContext)();
      if (trainingACtx.state === "suspended") trainingACtx.resume();
      const when = trainingACtx.currentTime + Math.max(0, delayS);
      const osc = trainingACtx.createOscillator(), gain = trainingACtx.createGain();
      osc.connect(gain); gain.connect(trainingACtx.destination);
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0, when); gain.gain.linearRampToValueAtTime(0.18, when + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
      osc.start(when); osc.stop(when + 0.1);
    }

    function draw(ts) {
      if (!simStartTime) simStartTime = ts;
      const elapsed = ts - simStartTime;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== canvas.clientWidth * dpr) { canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; }
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const WINDOW_MS = 3000, beatCount = Math.floor(elapsed / SIM_PERIOD_MS), beatsInWindow = Math.ceil(WINDOW_MS / SIM_PERIOD_MS) + 2;

      ctx.strokeStyle = "rgba(142,142,147,0.45)"; ctx.lineWidth = 1.5 * dpr;
      for (let i = -1; i <= beatsInWindow; i++) {
        const beatTime = (beatCount - beatsInWindow + i) * SIM_PERIOD_MS;
        const x = (1 - (elapsed - beatTime) / WINDOW_MS) * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }

      const toneOffset = (SIM_PERIOD_MS / 2) * knobValue;
      ctx.strokeStyle = "rgba(232,113,106,0.85)"; ctx.lineWidth = 2 * dpr;
      for (let i = -1; i <= beatsInWindow; i++) {
        const toneTime = (beatCount - beatsInWindow + i) * SIM_PERIOD_MS + toneOffset;
        const x = (1 - (elapsed - toneTime) / WINDOW_MS) * W;
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
        statusEl.textContent = held >= ALIGN_HOLD_MS ? "Aligned — well done!" : "Hold it there…";
        statusEl.className = "training-status aligned";
        if (held >= ALIGN_HOLD_MS && !gateUnlocked) { gateUnlocked = true; nextBtn.disabled = false; }
      } else {
        alignedSince = null;
        statusEl.textContent = "Rotate the dial to align the tone with the beats";
        statusEl.className = "training-status";
      }
      animFrameId = requestAnimationFrame(draw);
    }

    const observer = new MutationObserver(() => {
      const active = document.getElementById("screen-ob-training").classList.contains("active");
      if (active && !animFrameId) {
        dialEl.style.transform = `rotate(${dialAngle}rad)`;
        simStartTime = null; lastScheduledBeat = -1; animFrameId = requestAnimationFrame(draw);
      } else if (!active && animFrameId) {
        cancelAnimationFrame(animFrameId); animFrameId = null;
      }
    });
    observer.observe(document.getElementById("screen-ob-training"), { attributes: true, attributeFilter: ["class"] });

    nextBtn.onclick = () => {
      cancelAnimationFrame(animFrameId); animFrameId = null;
      if (trainingACtx) { trainingACtx.close(); trainingACtx = null; }
      show("screen-ob-complete");
    };
  }



  return {
    start() {
      initConsent(); initSchedule(); initDevice(); initTraining();
      document.getElementById("ob-complete").onclick = () => {
        sessionData.type = "pat_only"; sessionData.phases = ['pat'];
        sessionData.currentPhase = 0; runNextPhase();
      };
      show("screen-ob-consent");
    }
  };
})();