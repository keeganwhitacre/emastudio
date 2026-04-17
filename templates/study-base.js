"use strict";

// {{CONFIG_LOADER}}

const isPreview = window.__PREVIEW_MODE__ === true;

function show(id) { 
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); 
  const el = document.getElementById(id);
  if (el) el.classList.add('active'); 
}

function evalCond(cond, responses) {
  if (!cond) return true;
  const val = responses[cond.question_id];
  if (val === undefined || val === null || val === '') return false;
  const cv = cond.value;
  switch(cond.operator) {
    case 'eq': return val == cv; case 'neq': return val != cv;
    case 'gt': return Number(val) > Number(cv); case 'gte': return Number(val) >= Number(cv);
    case 'lt': return Number(val) < Number(cv); case 'lte': return Number(val) <= Number(cv);
    case 'includes': { const arr = Array.isArray(cv)?cv:[cv]; const ans = Array.isArray(val)?val:[val]; return arr.some(v => ans.includes(v)); }
    default: return true;
  }
}

// Dial tick generation for ePAT visual aesthetics
(function generateTicks() {
  const containers = ['rotary-dial-ticks', 'training-dial-ticks'];
  containers.forEach(cid => {
    const c = document.getElementById(cid);
    if (!c) return;
    const isTrain = cid.includes('training');
    const total = isTrain ? 60 : 72;
    for (let i = 0; i < total; i++) {
      const t = document.createElement('div');
      t.className = isTrain ? 'training-tick' : 'dial-tick';
      t.style.transform = `rotate(${i * (360/total)}deg)`;
      if (i % 2 === 0) t.style.height = isTrain ? '8px' : '10px';
      if (i % (total/4) === 0) { t.style.height = isTrain ? '12px' : '14px'; t.style.background = 'var(--fg-muted)'; }
      c.appendChild(t);
    }
  });
})();

const Upload = {
  send(sessionData, cb) {
    if (isPreview) { if(cb) cb(); return; }
    const a = document.createElement("a");
    const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: "application/json" });
    a.href = URL.createObjectURL(blob);
    a.download = `${sessionData.type}_${sessionData.participantId}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    if(cb) cb();
  }
};

function collectDeviceMetadata() {
  const ua = navigator.userAgent;
  let deviceModel = 'Unknown', osName = 'Unknown', osVersion = '', browserName = 'Unknown', browserVersion = '';
  if (/iPhone/.test(ua)) { deviceModel = 'iPhone'; osName = 'iOS'; const m = ua.match(/OS (\d+[_\.]\d+[_\.]?\d*)/); if (m) osVersion = m[1].replace(/_/g, '.'); }
  else if (/Android/.test(ua)) { osName = 'Android'; const m = ua.match(/Android ([\d.]+)/); if (m) osVersion = m[1]; const dm = ua.match(/;\s*([^;)]+)\s*Build\//); if (dm) deviceModel = dm[1].trim(); else deviceModel = 'Android Device'; }
  else if (/Mac OS X/.test(ua)) { osName = 'macOS'; const m = ua.match(/Mac OS X ([\d_]+)/); if (m) osVersion = m[1].replace(/_/g, '.'); deviceModel = 'Mac'; }
  else if (/Windows/.test(ua)) { osName = 'Windows'; const m = ua.match(/Windows NT ([\d.]+)/); if (m) osVersion = m[1]; deviceModel = 'PC'; }

  return {
    userAgent: ua, deviceModel, osName, osVersion, browserName, browserVersion,
    screenWidth: screen.width, screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio || 1, platform: navigator.platform || ''
  };
}

// MAIN RUNTIME EXECUTOR
(async function() {
  const config = await loadConfig();
  const params = new URLSearchParams(window.location.search);
  
  document.getElementById('study-title').textContent = config.study.name || 'Study';
  document.getElementById('task-subtitle').textContent  = config.study.institution || '';
  
  // {{EXPIRY_CHECK}}
  // {{PREVIEW_SESSION_FORCE}}
  
  const pidInput = document.getElementById('pid-input');
  const startBtn = document.getElementById('start-btn');

  if (params.get('id')) {
    pidInput.value = params.get('id');
    document.getElementById('participant-input-group').style.display = 'none';
  }
  if (params.get('day')) {
    const dl = document.getElementById('day-label');
    dl.textContent = `Day ${params.get('day')}`;
    dl.style.display = 'block';
  }
  pidInput.addEventListener('input', () => { startBtn.disabled = !pidInput.value.trim(); });

  let sessionData = { 
    sessionId: "ses_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    participantId: '', 
    day: parseInt(params.get('day')) || null,
    type: "", phases: [], currentPhase: 0, counterbalance: null,
    startedAt: null, device: null, data: [], status: "in_progress" 
  };

  const dynamicWindows = config.ema?.scheduling?.windows || [];

  // ---------------------------------------------------------------------------
  // Build sessionData.phases from w.phases
  //
  // w.phases = { pre: bool, task: "epat"|null, post: bool }
  //
  // Phase token format:
  //   EMA blocks   → "pre_<windowId>"  or "post_<windowId>"  (EMA.start() consumes these)
  //   Task modules → "<moduleId>"                             (TASK_MODULES[id]() handles these)
  //
  // Examples:
  //   { pre: true,  task: null,   post: false } → ["pre_w1"]
  //   { pre: true,  task: "epat", post: true  } → ["pre_w1", "epat", "post_w1"]
  //   { pre: false, task: "epat", post: false } → ["epat"]
  // ---------------------------------------------------------------------------
  if (sessionId === 'onboarding') {
    sessionData.type = "onboarding";
    document.getElementById('task-subtitle').textContent = "Study Setup";

  } else {
    const wCfg = dynamicWindows.find(w => w.id === sessionId);

    if (wCfg) {
      const ph = wCfg.phases || { pre: true, task: null, post: false };
      const phases = [];
      if (ph.pre)  phases.push(`pre_${wCfg.id}`);
      if (ph.task) phases.push(ph.task);
      if (ph.post) phases.push(`post_${wCfg.id}`);

      sessionData.phases   = phases;
      sessionData.type     = ph.task ? `ema_${ph.task}` : "ema_only";
      sessionData.windowId = wCfg.id;

      document.getElementById('task-subtitle').textContent =
        config.study.greetings?.[wCfg.id] || wCfg.label || 'Check-In';
      document.getElementById('ema-greeting').textContent =
        config.study.greetings?.[wCfg.id] || wCfg.label || 'Check-In';

    } else {
      console.warn(`[study-base] Unknown sessionId "${sessionId}", falling back to EMA pre-only.`);
      sessionData.phases = [`pre_${sessionId}`];
      sessionData.type   = "ema_only";
      document.getElementById('ema-greeting').textContent = 'Check-In';
    }
  }

  // {{MODULES_INJECT}}

  // ---------------------------------------------------------------------------
  // TASK MODULE REGISTRY
  // ---------------------------------------------------------------------------
  // Inside the IIFE so handlers share the same closure as `config`, `ePAT`,
  // and `advancePhase`. Each handler must call advancePhase() when done.
  // Adding a new module = one new entry here; runNextPhase() needs no changes.
  // ---------------------------------------------------------------------------
  const TASK_MODULES = {
    epat: () => {
      if (window.ePATCore && typeof ePAT !== 'undefined') {
        ePAT.startBaseline();
      } else {
        console.warn('[study-base] ePAT module not available, skipping.');
        advancePhase();
      }
    }
    // future: nback:   () => NBack.start(),
    // future: flanker: () => Flanker.start(),
  };

  startBtn.addEventListener('click', () => {
    sessionData.participantId = pidInput.value.trim();
    sessionData.startedAt = new Date().toISOString();
    sessionData.device = collectDeviceMetadata();
    
    if (window.ePATCore) window.ePATCore.AudioEngine.init();

    if (sessionData.type === 'onboarding' && config.onboarding?.enabled) {
      OnboardingSession.start();
    } else {
      runNextPhase();
    }
  });

  // ---------------------------------------------------------------------------
  // runNextPhase — dispatches on phase token prefix:
  //   "pre_*" / "post_*"  → EMA.start()
  //   anything else       → TASK_MODULES lookup
  // ---------------------------------------------------------------------------
  function runNextPhase() {
    const phase = sessionData.phases[sessionData.currentPhase];
    if (phase === undefined) { finalizeSession(); return; }

    if (phase.startsWith('pre_') || phase.startsWith('post_')) {
      EMA.start(phase);
    } else {
      const handler = TASK_MODULES[phase];
      if (handler) {
        handler();
      } else {
        console.warn(`[study-base] No handler for task phase "${phase}", skipping.`);
        advancePhase();
      }
    }
  }

  function advancePhase() { 
    sessionData.currentPhase++; 
    runNextPhase(); 
  }

  function finalizeSession() {
    sessionData.status = "complete";
    sessionData.completedAt = new Date().toISOString();
    
    if (isPreview) {
      document.getElementById('screen-end').querySelector('p').textContent = '✓ Preview complete.'; 
      show('screen-end');
      return;
    }

    const totalBeats = sessionData.data.reduce((sum, entry) => {
      if (entry.type === "baseline") return sum + (entry.recordedHR ? entry.recordedHR.length : 0);
      if (entry.type === "trial") return sum + (entry.qualitySummary ? entry.qualitySummary.totalBeats : 0);
      return sum;
    }, 0);
    
    if (totalBeats > 0) {
      document.getElementById("end-beat-count").textContent = `${totalBeats.toLocaleString()} beats contributed to science.`;
      document.getElementById("end-beat-count").style.display = "block";
    }

    document.getElementById("download-btn").onclick = () => Upload.send(sessionData);
    show('screen-end');
  }

})();