"use strict";

// ==========================================================
// EMA Studio — study-base.js (runtime)
// v1.3.0
// ==========================================================
//
// Changes from v1.2:
//
// ROUTER (the big one):
//   - Sessions are now resolved by looking up the window in config.ema.scheduling.windows
//     and consuming its { pre, task, post } phase spec. Legacy string-matching on
//     "pair_" and "ema" prefixes is gone. A session is identified by sessionId alone,
//     which is always a window id (e.g. "w1") or the literal string "onboarding".
//   - sessionData.phases now contains tokens of three shapes:
//       "pre_<windowId>"   — EMA block before the task
//       "post_<windowId>"  — EMA block after the task
//       "<moduleId>"       — a task module (e.g. "epat")
//   - runNextPhase() dispatches by token shape: pre_/post_ → EMA.start,
//     any other token → look up in config.modules and invoke the registered handler.
//
// MODULE NAMING:
//   - Hardcoded 'pat' string literals are gone. Everywhere we look for ePAT config
//     we now read config.modules.epat. Everywhere we dispatch we use the module id.
//
// DATA CONTRACT (session output):
//   - sessionData.schemaVersion    — stamped from config.schema_version
//   - sessionData.studyName        — for downstream identification
//   - Each ema_response entry in sessionData.data now has:
//       .startedAt   — ISO timestamp when the phase first rendered
//       .submittedAt — ISO timestamp when the phase was submitted
//       .responses   — { [questionId]: { value, respondedAt } }
//     The per-question .respondedAt enables response-latency analyses.
//
// UPLOAD:
//   - Default output format is now CSV (long-format EMA responses) per
//     config.study.output_format. JSON is opt-in.
//   - When ePAT is present in the session, the task portion always downloads
//     as JSON (signal data doesn't flatten). CSV export covers EMA only.
//   - Filename convention: <study_slug>_<pid>_<sessionId>_<type>.<ext>
//
// STORAGE HOOK:
//   - (no change in this file — the auto-save fix lives in js/storage.js)
//
// ==========================================================

// {{CONFIG_LOADER}}

const isPreview = window.__PREVIEW_MODE__ === true;

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function evalCond(cond, responses) {
  if (!cond) return true;
  // responses is { qid: { value, respondedAt } } — we compare against .value
  const rec = responses[cond.question_id];
  const val = rec && typeof rec === 'object' ? rec.value : rec;
  if (val === undefined || val === null || val === '') return false;
  const cv = cond.value;
  switch(cond.operator) {
    case 'eq':  return val == cv;
    case 'neq': return val != cv;
    case 'gt':  return Number(val) >  Number(cv);
    case 'gte': return Number(val) >= Number(cv);
    case 'lt':  return Number(val) <  Number(cv);
    case 'lte': return Number(val) <= Number(cv);
    case 'includes': {
      const arr = Array.isArray(cv) ? cv : [cv];
      const ans = Array.isArray(val) ? val : [val];
      return arr.some(v => ans.includes(v));
    }
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

// ==========================================================
// UPLOAD
// ----------------------------------------------------------
// Emits participant data. Format selection per config.study.output_format.
//
// CSV format (default): long-format EMA responses only.
//   Columns: schema_version, study_name, participant_id, session_id,
//            session_type, day, window_id, window_label, block,
//            session_started_at, session_submitted_at,
//            phase_started_at, phase_submitted_at,
//            question_id, question_text, question_type,
//            response_value, response_numeric, response_latency_ms
//
//   Multi-select questions: one row per response with semicolon-separated values.
//   Non-numeric responses get NA in response_numeric.
//
// JSON format: full nested sessionData with all task signal data.
//   This is also used when ePAT data is present, regardless of format setting,
//   because signal arrays don't flatten to CSV meaningfully. In mixed sessions
//   we emit BOTH files: _ema.csv (responses) and _task.json (signal data).
// ==========================================================
const Upload = {

  _slugify(str) {
    return (str || 'study').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  },

  _downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  // Coerce a response value to a number where possible. Returns '' for NA.
  // Arrays (multi-select) never coerce — they're flagged with a sentinel.
  _toNumeric(val) {
    if (val === null || val === undefined || val === '') return '';
    if (Array.isArray(val)) return '';
    const n = Number(val);
    return Number.isFinite(n) ? n : '';
  },

  _serializeValue(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return val.join(';');
    return String(val);
  },

  _csvEscape(val) {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  },

  // Build a lookup of question metadata by id for CSV enrichment.
  _buildQuestionIndex(cfg) {
    const idx = {};
    (cfg.ema?.questions || []).forEach(q => {
      if (q.type !== 'page_break') idx[q.id] = q;
    });
    return idx;
  },

  // Flatten sessionData into long-format CSV rows (EMA responses only).
  // Returns { header, rows } where rows is an array of arrays.
  _buildEmaCsv(sessionData, cfg) {
    const qIdx = this._buildQuestionIndex(cfg);
    const windows = cfg.ema?.scheduling?.windows || [];
    const header = [
      'schema_version', 'study_name', 'participant_id', 'session_id',
      'session_type', 'day', 'window_id', 'window_label', 'block',
      'session_started_at', 'session_submitted_at',
      'phase_started_at', 'phase_submitted_at',
      'question_id', 'question_text', 'question_type',
      'response_value', 'response_numeric', 'response_latency_ms'
    ];

    const rows = [];
    const emaEntries = (sessionData.data || []).filter(e => e && e.type === 'ema_response');

    emaEntries.forEach(entry => {
      const wId  = entry.windowId || '';
      const wCfg = windows.find(w => w.id === wId);
      const wLabel = wCfg ? wCfg.label : '';
      const phaseStart = entry.startedAt || '';
      const phaseSubmit = entry.submittedAt || '';
      const phaseStartMs = phaseStart ? Date.parse(phaseStart) : null;

      Object.entries(entry.responses || {}).forEach(([qid, rec]) => {
        const q = qIdx[qid] || {};
        const rawVal = (rec && typeof rec === 'object') ? rec.value : rec;
        const respAt = (rec && typeof rec === 'object') ? rec.respondedAt : null;
        const latency = (phaseStartMs && respAt) ? (Date.parse(respAt) - phaseStartMs) : '';

        rows.push([
          sessionData.schemaVersion || '',
          sessionData.studyName || '',
          sessionData.participantId,
          sessionData.sessionId,
          sessionData.type,
          sessionData.day ?? '',
          wId,
          wLabel,
          entry.block || '',
          sessionData.startedAt || '',
          sessionData.completedAt || '',
          phaseStart,
          phaseSubmit,
          qid,
          q.text || '',
          q.type || '',
          this._serializeValue(rawVal),
          this._toNumeric(rawVal),
          latency
        ]);
      });
    });

    return { header, rows };
  },

  _csvString({ header, rows }) {
    const esc = this._csvEscape.bind(this);
    const lines = [header.map(esc).join(',')];
    rows.forEach(r => lines.push(r.map(esc).join(',')));
    return lines.join('\n');
  },

  // Does this session contain any non-EMA task data that can't flatten to CSV?
  _hasTaskSignalData(sessionData) {
    return (sessionData.data || []).some(e =>
      e && (e.type === 'baseline' || e.type === 'trial')
    );
  },

  send(sessionData, cb) {
    if (isPreview) { if (cb) cb(); return; }

    const cfg = (typeof config !== 'undefined') ? config : {};
    const format = cfg.study?.output_format || 'csv';
    const slug = this._slugify(cfg.study?.name);
    const pid = sessionData.participantId || 'unknown';
    const sid = sessionData.sessionId;
    const date = new Date().toISOString().slice(0, 10);
    const base = `${slug}_${pid}_${date}_${sid}`;

    // Always emit JSON if format is json OR if there's task signal data
    const shouldEmitJson = format === 'json' || this._hasTaskSignalData(sessionData);
    const shouldEmitCsv  = format === 'csv';

    if (shouldEmitCsv) {
      const csv = this._csvString(this._buildEmaCsv(sessionData, cfg));
      this._downloadBlob(
        new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
        `${base}_ema.csv`
      );
    }

    if (shouldEmitJson) {
      // When CSV is selected but task data is present, emit task-only JSON
      // to avoid duplicating EMA responses. When JSON is selected outright,
      // emit the full session.
      const payload = (shouldEmitCsv && this._hasTaskSignalData(sessionData))
        ? {
            // Task-only payload — EMA responses are in the CSV
            schemaVersion: sessionData.schemaVersion,
            studyName:     sessionData.studyName,
            sessionId:     sessionData.sessionId,
            participantId: sessionData.participantId,
            day:           sessionData.day,
            type:          sessionData.type,
            phases:        sessionData.phases,
            counterbalance: sessionData.counterbalance,
            startedAt:     sessionData.startedAt,
            completedAt:   sessionData.completedAt,
            device:        sessionData.device,
            status:        sessionData.status,
            data:          (sessionData.data || []).filter(e => e && e.type !== 'ema_response')
          }
        : sessionData;

      const suffix = (shouldEmitCsv && this._hasTaskSignalData(sessionData)) ? '_task' : '';
      this._downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `${base}${suffix}.json`
      );
    }

    if (cb) cb();
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

// ==========================================================
// MAIN RUNTIME EXECUTOR
// ==========================================================
(async function() {
  const config = await loadConfig();
  const params = new URLSearchParams(window.location.search);

  document.getElementById('study-title').textContent = config.study.name || 'Study';
  document.getElementById('task-subtitle').textContent = config.study.institution || '';

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
    schemaVersion: config.schema_version || '',
    studyName:     config.study?.name || '',
    sessionId:     "ses_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    participantId: '',
    day:           parseInt(params.get('day')) || null,
    type:          "",
    phases:        [],
    currentPhase:  0,
    counterbalance: null,
    startedAt:     null,
    completedAt:   null,
    device:        null,
    data:          [],
    status:        "in_progress"
  };

  const cbParam = params.get('cb');
  const dynamicWindows = config.ema?.scheduling?.windows || [];
  const enabledModules = config.modules || {};

  // -----------------------------------------------------------------
  // ROUTER — v1.3: consume window.phases instead of string-matching.
  // -----------------------------------------------------------------
  if (sessionId === 'onboarding') {
    sessionData.type = "onboarding";
    document.getElementById('task-subtitle').textContent = "Study Setup";
  } else {
    const w = dynamicWindows.find(win => win.id === sessionId);

    if (!w) {
      // Unknown session id — treat as a minimal EMA-only shot at whatever the
      // first window is, so we degrade gracefully instead of blanking out.
      const fallback = dynamicWindows[0];
      if (fallback) {
        sessionData.type = "ema_only";
        sessionData.phases = [`pre_${fallback.id}`];
        document.getElementById('task-subtitle').textContent = fallback.label || 'Check-In';
      } else {
        sessionData.type = "error";
        document.getElementById('task-subtitle').textContent = "Invalid Session";
        startBtn.disabled = true;
        startBtn.textContent = 'Session not found';
        return;
      }
    } else {
      const ph = w.phases || { pre: true, task: null, post: false };
      const taskId = ph.task && enabledModules[ph.task] ? ph.task : null;

      // Build phase token list in order
      const phaseTokens = [];
      if (ph.pre)  phaseTokens.push(`pre_${w.id}`);
      if (taskId)  phaseTokens.push(taskId);
      if (ph.post && taskId) phaseTokens.push(`post_${w.id}`);

      // Apply counterbalancing if requested AND the window has task+pre (not post)
      // Honored counterbalance values: 'task_first' (reverses pre,task → task,pre)
      // Retained for backward compat: 'pat_first' (alias for task_first when task is epat)
      if (cbParam && taskId && ph.pre) {
        const wantTaskFirst = (cbParam === 'task_first') ||
                              (cbParam === 'pat_first' && taskId === 'epat');
        if (wantTaskFirst) {
          // swap first two: [pre_w, task, ...] → [task, pre_w, ...]
          [phaseTokens[0], phaseTokens[1]] = [phaseTokens[1], phaseTokens[0]];
          sessionData.counterbalance = 'task_first';
        } else {
          sessionData.counterbalance = 'pre_first';
        }
      }

      sessionData.type = taskId ? (ph.post ? "pre_task_post" : "pre_task") : "ema_only";
      sessionData.phases = phaseTokens;

      document.getElementById('task-subtitle').textContent = w.label || 'Check-In';
    }
  }

  // Dynamic greeting based on window id — module-ema can also override at start
  const greetings = config.study?.greetings || {};
  const matchedWindow = dynamicWindows.find(w => w.id === sessionId);
  const greetingText = greetings[sessionId]
                    || (matchedWindow ? matchedWindow.label : 'Check-In');
  const greetingEl = document.getElementById('ema-greeting');
  if (greetingEl) greetingEl.textContent = greetingText;

  // {{MODULES_INJECT}}

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

  // -----------------------------------------------------------------
  // PHASE DISPATCH — v1.3: token shape determines handler.
  //   "pre_<wid>" / "post_<wid>"  → EMA.start(token)
  //   "<moduleId>"                → dispatch via module's global API
  //
  // Module dispatch table is intentionally explicit — when you add a new
  // task module, add a case here. Keeping this explicit prevents accidental
  // execution of code that happens to share a name with something else.
  // -----------------------------------------------------------------
  function runNextPhase() {
    const phase = sessionData.phases[sessionData.currentPhase];
    if (!phase) { finalizeSession(); return; }

    if (phase.startsWith('pre_') || phase.startsWith('post_')) {
      EMA.start(phase);
      return;
    }

    switch (phase) {
      case 'epat':
        if (config.modules?.epat && window.ePATCore && typeof ePAT !== 'undefined') {
          ePAT.startBaseline();
        } else {
          console.warn('ePAT phase requested but module/core not available; skipping.');
          advancePhase();
        }
        break;
      // case 'stroop': if (...) Stroop.start(); else advancePhase(); break;
      default:
        console.warn(`Unknown phase token: ${phase}. Skipping.`);
        advancePhase();
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

    // Beat count vanity (ePAT-specific; harmless when absent)
    const totalBeats = sessionData.data.reduce((sum, entry) => {
      if (entry.type === "baseline") return sum + (entry.recordedHR ? entry.recordedHR.length : 0);
      if (entry.type === "trial") return sum + (entry.qualitySummary ? entry.qualitySummary.totalBeats : 0);
      return sum;
    }, 0);

    if (totalBeats > 0) {
      const el = document.getElementById("end-beat-count");
      if (el) {
        el.textContent = `${totalBeats.toLocaleString()} beats contributed to science.`;
        el.style.display = "block";
      }
    }

    document.getElementById("download-btn").onclick = () => Upload.send(sessionData);
    show('screen-end');
  }

  // Expose advancePhase + sessionData to injected modules. They were implicit
  // globals under the old structure; making them explicit here removes a whole
  // class of "works in this order but not that order" bugs.
  window.advancePhase = advancePhase;
  window.__sessionData = sessionData;

})();
