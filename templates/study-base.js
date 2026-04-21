"use strict";

// ==========================================================
// EMA Studio — study-base.js (runtime)
// v1.4.0
// ==========================================================
//
// Changes from v1.3:
//
// PHASE SEQUENCE (forward-looking):
//   - Router now prefers config.ema.scheduling.windows[i].phase_sequence
//     when non-empty. Falls back to the legacy {pre, task, post} triple
//     if phase_sequence is missing (old exports still work).
//   - phase_sequence is an ordered array of:
//       { kind: "ema",  block: "pre" | "post" }
//       { kind: "task", id: "epat" | "stroop" | ... }
//   - Multiple tasks per session are now a pure schema concern — the router
//     just walks the array.
//
// RESUME (study.resume_enabled):
//   - After every phase transition (advancePhase) and at finalizeSession,
//     we write sessionData to localStorage under a resume key built from
//     (pid, day, sessionId-in-url). On load, if there's a saved state and
//     status is "in_progress", we show a resume dialog: continue or restart.
//   - Resume skips completed phases and picks up at sessionData.currentPhase.
//     In-progress phase state (mid-EMA page, mid-trial) is NOT persisted —
//     participants restart the current phase. This is the defensible boundary:
//     resuming mid-trial for ePAT would require serialising PPG state which
//     is too fragile. The phase restarts; the already-completed phases
//     (and their data) survive.
//
// COMPLETION LOCK (study.completion_lock):
//   - On finalizeSession, we stamp a completion record keyed on
//     (pid, day, urlSession). On load, if a completion already exists,
//     the start button is disabled and the screen explains why. Can be
//     bypassed by adding ?force=1 to the URL (for researcher testing).
//
// THEME HOT-LOAD (static bundle fix):
//   - Runtime reads config.study.theme + accent_color and injects CSS
//     variables into :root. This means the static-hosting bundle can
//     change theme by editing config.json without re-exporting. For the
//     single-file export, the CSS is already baked in, so this is a no-op.
//
// KNOWN-GOOD FROM v1.3 (preserved):
//   - Per-question response latency (emaResponses.responses[qid].respondedAt)
//   - CSV as default output
//   - Explicit module dispatch switch
//   - Session output JSON/CSV contract
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
// RESUME MANAGER
// ----------------------------------------------------------
// Keyed on a string built from pid + day + the session param from the URL.
// Not the runtime-generated sessionData.sessionId, because that changes on
// every reload — we want a stable key so reloads after a crash actually
// find the saved state.
// ==========================================================
const ResumeManager = {
  _prefix: 'ema_studio_resume_v1__',

  _key(pid, day, urlSession) {
    return this._prefix + [pid || 'anon', day || '0', urlSession || 'default'].join('|');
  },

  save(pid, day, urlSession, sessionData) {
    if (isPreview) return;
    try {
      localStorage.setItem(this._key(pid, day, urlSession), JSON.stringify(sessionData));
    } catch (e) {
      // Quota exceeded — most likely ePAT signal data from prior sessions.
      // Fail silently; losing resume capability is better than crashing.
      console.warn('ResumeManager.save failed:', e);
    }
  },

  load(pid, day, urlSession) {
    if (isPreview) return null;
    try {
      const raw = localStorage.getItem(this._key(pid, day, urlSession));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  clear(pid, day, urlSession) {
    try { localStorage.removeItem(this._key(pid, day, urlSession)); } catch (e) {}
  }
};

// ==========================================================
// COMPLETION LOCK
// ----------------------------------------------------------
// One completed session per (pid, day, urlSession). Client-side only —
// a participant switching phones or clearing browser data bypasses this,
// which is the best you can do without a server. For most EMA use cases
// that's fine: the scenario you actually care about is the participant
// accidentally opening the same link twice in a row.
// ==========================================================
const CompletionLock = {
  _prefix: 'ema_studio_done_v1__',

  _key(pid, day, urlSession) {
    return this._prefix + [pid || 'anon', day || '0', urlSession || 'default'].join('|');
  },

  isLocked(pid, day, urlSession) {
    if (isPreview) return false;
    try {
      return !!localStorage.getItem(this._key(pid, day, urlSession));
    } catch (e) { return false; }
  },

  stamp(pid, day, urlSession) {
    if (isPreview) return;
    try {
      localStorage.setItem(this._key(pid, day, urlSession), new Date().toISOString());
    } catch (e) {}
  }
};

// ==========================================================
// THEME HOT-LOAD (for static bundle re-themeing via config.json edits)
// ==========================================================
function applyThemeFromConfig(cfg) {
  // Only needed for the static bundle case where CSS is a separate file
  // with baked theme vars. The single-file export already has the right
  // vars inlined, so this is a no-op overwrite with the same values.
  // Runs before any screen renders so there's no flash.
  const study = cfg.study || {};
  const accent = study.accent_color || '#e8716a';
  const theme  = study.theme || 'oled';

  const root = document.documentElement.style;
  root.setProperty('--accent', accent);

  // These color sets duplicate export.js getThemeCSS — kept in sync by hand.
  // If you change one, change the other.
  if (theme === 'light') {
    root.setProperty('--bg',         '#f9f9fb');
    root.setProperty('--bg-surface', '#ffffff');
    root.setProperty('--bg-elevated','#f0f0f4');
    root.setProperty('--border',     '#e0e0e5');
    root.setProperty('--fg',         '#1c1c1e');
    root.setProperty('--fg-muted',   '#8e8e93');
  } else if (theme === 'dark') {
    root.setProperty('--bg',         '#121212');
    root.setProperty('--bg-surface', '#1e1e1e');
    root.setProperty('--bg-elevated','#2d2d2d');
    root.setProperty('--border',     '#3d3d3d');
    root.setProperty('--fg',         '#e0e0e0');
    root.setProperty('--fg-muted',   '#9e9e9e');
  } else {
    root.setProperty('--bg',         '#000000');
    root.setProperty('--bg-surface', '#111111');
    root.setProperty('--bg-elevated','#1c1c1e');
    root.setProperty('--border',     '#2c2c2e');
    root.setProperty('--fg',         '#ffffff');
    root.setProperty('--fg-muted',   '#8e8e93');
  }
}

// ==========================================================
// UPLOAD (unchanged from v1.3 apart from the filename date fix)
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

  _toNumeric(val) {
    if (val === null || val === undefined || val === '') return '';
    if (Array.isArray(val)) return '';
    const n = Number(val);
    return Number.isFinite(n) ? n : '';
  },

  _serializeValue(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return val.join(';');
    // Affect-grid values are {valence, arousal} objects — serialize as "v;a"
    if (val && typeof val === 'object' && 'valence' in val && 'arousal' in val) {
      return `${val.valence};${val.arousal}`;
    }
    return String(val);
  },

  _csvEscape(val) {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  },

  _buildQuestionIndex(cfg) {
    const idx = {};
    (cfg.ema?.questions || []).forEach(q => {
      if (q.type !== 'page_break') idx[q.id] = q;
    });
    return idx;
  },

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
        const rawVal = (rec && typeof rec === 'object' && 'value' in rec) ? rec.value : rec;
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
      const payload = (shouldEmitCsv && this._hasTaskSignalData(sessionData))
        ? {
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

  // Apply theme first so there's no flash of wrong-themed screen
  applyThemeFromConfig(config);

  const params = new URLSearchParams(window.location.search);

  document.getElementById('study-title').textContent = config.study.name || 'Study';
  document.getElementById('task-subtitle').textContent = config.study.institution || '';

  // {{EXPIRY_CHECK}}
  // {{PREVIEW_SESSION_FORCE}}

  const pidInput = document.getElementById('pid-input');
  const startBtn = document.getElementById('start-btn');

  // Stable URL-derived identifiers for resume + completion lock.
  // These are set before any session starts so we can check locks upfront.
  const urlPid     = (params.get('id') || '').trim();
  const urlDay     = params.get('day') || '';
  const urlSession = sessionId;
  const forceOverride = params.get('force') === '1';

if (urlPid) {
    pidInput.value = urlPid;
    document.getElementById('participant-input-group').style.display = 'none';
  }
  if (urlDay) {
    const dl = document.getElementById('day-label');
    dl.textContent = `Day ${urlDay}`;
    dl.style.display = 'block';
  }
  pidInput.addEventListener('input', () => { startBtn.disabled = !pidInput.value.trim(); });
 
  // Enable the start button whenever there's a usable PID, covering all cases:
  //   1. URL supplied ?id=  (real participant link)
  //   2. Preview mode       (no URL params, no one typing)
  //   3. ?session=onboarding (PID collected later during consent)
  if (pidInput.value.trim() || isPreview || sessionId === 'onboarding') {
    if (isPreview) pidInput.value = pidInput.value.trim() || 'preview';
    document.getElementById('participant-input-group').style.display = 'none';
    startBtn.disabled = false;
  }
 
  // Enable the start button whenever there's a usable PID, covering all cases:
  //   1. URL supplied ?id=  (real participant link)
  //   2. Preview mode       (no URL params, no one typing)
  //   3. ?session=onboarding (PID collected later during consent)
  if (pidInput.value.trim() || isPreview || sessionId === 'onboarding') {
    if (isPreview) pidInput.value = pidInput.value.trim() || 'preview';
    document.getElementById('participant-input-group').style.display = 'none';
    startBtn.disabled = false;
  }


  // ---------------------------------------------------------------
  // COMPLETION LOCK CHECK (before anything else)
  // ---------------------------------------------------------------
  if (config.study?.completion_lock && !forceOverride && urlPid) {
    if (CompletionLock.isLocked(urlPid, urlDay, urlSession)) {
      document.getElementById('task-subtitle').textContent = 'Already Completed';
      const dayLabel = document.getElementById('day-label');
      if (dayLabel) { dayLabel.textContent = 'Thank you'; dayLabel.style.display = 'block'; }
      startBtn.disabled = true;
      startBtn.textContent = 'Session already submitted';
      document.getElementById('participant-input-group').style.display = 'none';
      return;
    }
  }

  // ---------------------------------------------------------------
  // Build a fresh sessionData template. The router below populates
  // .type, .phases, and .counterbalance.
  // ---------------------------------------------------------------
  let sessionData = {
    schemaVersion: config.schema_version || '',
    studyName:     config.study?.name || '',
    sessionId:     "ses_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    participantId: urlPid,
    day:           parseInt(urlDay) || null,
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

  // ---------------------------------------------------------------
  // ROUTER — v1.4: consume window.phase_sequence (preferred) OR the
  // legacy {pre, task, post} triple (fallback).
  // ---------------------------------------------------------------
  function expandWindowToTokens(w) {
    const seq = (Array.isArray(w.phase_sequence) && w.phase_sequence.length > 0)
      ? w.phase_sequence
      : legacyTripleToSequence(w.phases);
 
    // Collect already-submitted EMA responses for condition evaluation.
    // At this point sessionData.data may contain ema_response entries from
    // phases that already ran in this session.
    function getCollectedResponses() {
      const merged = {};
      (sessionData.data || []).forEach(entry => {
        if (entry.type === 'ema_response' && entry.responses) {
          Object.assign(merged, entry.responses);
        }
        // HR captures are stored as hr_capture entries with a bpm field
        if (entry.type === 'hr_capture') {
          merged[entry.question_id] = { value: entry.bpm, respondedAt: entry.capturedAt };
        }
      });
      return merged;
    }
 
    const tokens = [];
    let emaBlockCounter = { pre: 0, post: 0 };
 
    seq.forEach(step => {
      if (step.kind === 'ema') {
        const block = step.block === 'post' ? 'post' : 'pre';
        // Allow multiple EMA blocks of the same type by appending a suffix
        // for the 2nd, 3rd, etc. — e.g. post_w1, post2_w1
        const count = emaBlockCounter[block]++;
        const prefix = count === 0 ? block : `${block}${count + 1}`;
        tokens.push(`${prefix}_${w.id}`);
 
      } else if (step.kind === 'task' && step.id && enabledModules[step.id]) {
        // Evaluate optional condition
        if (step.condition && step.condition.question_id) {
          const responses = getCollectedResponses();
          if (!evalCond(step.condition, responses)) {
            return; // condition false — skip this task
          }
        }
        tokens.push(step.id);
 
      } else if (step.kind === 'hr') {
        // HR capture is its own phase token: 'hr:<store_as>:<duration_sec>'
        const storeAs  = step.store_as  || 'hr_result';
        const duration = step.duration_sec || 30;
        tokens.push(`hr:${storeAs}:${duration}`);
      }
      // Unknown kinds and disabled modules silently drop.
    });
    return tokens;
  }

  function legacyTripleToSequence(phases) {
    const ph = phases || { pre: true, task: null, post: false };
    const seq = [];
    if (ph.pre)             seq.push({ kind: "ema",  block: "pre"  });
    if (ph.task)            seq.push({ kind: "task", id:    ph.task });
    if (ph.post && ph.task) seq.push({ kind: "ema",  block: "post" });
    return seq;
  }

  if (sessionId === 'onboarding') {
    sessionData.type = "onboarding";
    document.getElementById('task-subtitle').textContent = "Study Setup";
  } else {
    const w = dynamicWindows.find(win => win.id === sessionId);

    if (!w) {
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
      let phaseTokens = expandWindowToTokens(w);

      // Counterbalancing: swap first pair if the window has both an EMA pre-block
      // and a task, and cb=task_first was requested. Kept narrow-scope — if you
      // need arbitrary permutations you'd edit phase_sequence directly in config.
      if (cbParam && phaseTokens.length >= 2) {
        const firstIsPre  = phaseTokens[0].startsWith('pre_');
        const secondIsTask = !phaseTokens[1].startsWith('pre_') && !phaseTokens[1].startsWith('post_');
        if (firstIsPre && secondIsTask) {
          const wantTaskFirst = (cbParam === 'task_first') ||
                                (cbParam === 'pat_first' && phaseTokens[1] === 'epat');
          if (wantTaskFirst) {
            [phaseTokens[0], phaseTokens[1]] = [phaseTokens[1], phaseTokens[0]];
            sessionData.counterbalance = 'task_first';
          } else {
            sessionData.counterbalance = 'pre_first';
          }
        }
      }

      // Categorize session type for downstream analyses.
      const hasTask = phaseTokens.some(t => !t.startsWith('pre_') && !t.startsWith('post_'));
      const hasPost = phaseTokens.some(t => t.startsWith('post_'));
      sessionData.type = hasTask ? (hasPost ? "pre_task_post" : "pre_task") : "ema_only";
      sessionData.phases = phaseTokens;

      document.getElementById('task-subtitle').textContent = w.label || 'Check-In';
    }
  }

  // Dynamic greeting based on window id
  const greetings = config.study?.greetings || {};
  const matchedWindow = dynamicWindows.find(w => w.id === sessionId);
  const greetingText = greetings[sessionId]
                    || (matchedWindow ? matchedWindow.label : 'Check-In');
  const greetingEl = document.getElementById('ema-greeting');
  if (greetingEl) greetingEl.textContent = greetingText;

  // ---------------------------------------------------------------
  // RESUME CHECK (offer to continue if a prior in-progress session exists)
  // ---------------------------------------------------------------
  let resumeOffer = null;
  if (config.study?.resume_enabled && !isPreview && urlPid) {
    const saved = ResumeManager.load(urlPid, urlDay, urlSession);
    if (saved && saved.status === 'in_progress' && Array.isArray(saved.phases) && saved.phases.length) {
      // Validate that the saved phase list is still consistent with the current
      // config. If phases array differs (config was re-exported with different
      // structure), we refuse to resume — start over is safer.
      const sameShape = JSON.stringify(saved.phases) === JSON.stringify(sessionData.phases);
      if (sameShape && typeof saved.currentPhase === 'number' && saved.currentPhase < saved.phases.length) {
        resumeOffer = saved;
      } else {
        ResumeManager.clear(urlPid, urlDay, urlSession);
      }
    }
  }

  // {{MODULES_INJECT}}

  // ---------------------------------------------------------------
  // START handler — either fresh start or resume
  // ---------------------------------------------------------------
  function doStart(resuming) {
    if (!resuming) {
      sessionData.participantId = pidInput.value.trim();
      sessionData.startedAt = new Date().toISOString();
      sessionData.device = collectDeviceMetadata();
    } else {
      // Adopt the resumed state, but stamp a new device record in case
      // they switched devices (keep the original too).
      Object.assign(sessionData, resumeOffer);
      sessionData.resumedAt = new Date().toISOString();
      const freshDevice = collectDeviceMetadata();
      if (sessionData.device && sessionData.device.userAgent !== freshDevice.userAgent) {
        sessionData.deviceOnResume = freshDevice;
      }
    }

    if (window.ePATCore) window.ePATCore.AudioEngine.init();

    // Persist immediately so a crash between start and first advancePhase
    // still has something to resume from.
    persistResumeState();

    if (sessionData.type === 'onboarding' && config.onboarding?.enabled) {
      OnboardingSession.start();
    } else {
      runNextPhase();
    }
  }

  function persistResumeState() {
    if (!config.study?.resume_enabled) return;
    ResumeManager.save(sessionData.participantId, urlDay, urlSession, sessionData);
  }

  // If we have a resume offer, surface it by repurposing the start button
  // and adding a "start over" link under it.
  if (resumeOffer) {
    startBtn.textContent = 'Resume Session';
    startBtn.disabled = false;
    // Add a small "start over" option next to/under the button.
    const inputGroup = document.getElementById('participant-input-group');
    const hint = document.createElement('button');
    hint.textContent = 'Start over';
    hint.style.cssText = 'margin-top:12px;background:none;border:none;color:var(--fg-muted);font-size:0.85rem;text-decoration:underline;cursor:pointer;';
    hint.addEventListener('click', () => {
      ResumeManager.clear(urlPid, urlDay, urlSession);
      resumeOffer = null;
      startBtn.textContent = 'Begin Session';
      hint.remove();
    });
    if (startBtn.parentNode) startBtn.parentNode.appendChild(hint);
  }

  startBtn.addEventListener('click', () => {
    doStart(!!resumeOffer);
  });

  // ---------------------------------------------------------------
  // PHASE DISPATCH — v1.4: token shape determines handler.
  //   "pre_<wid>" / "post_<wid>"  → EMA.start(token)
  //   "<moduleId>"                → dispatch via explicit module switch
  // ---------------------------------------------------------------
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
      // Future modules register here. Example:
      // case 'stroop':
      //   if (config.modules?.stroop && typeof Stroop !== 'undefined') Stroop.start();
      //   else advancePhase();
      //   break;

      default:
        if (phase.startsWith('hr:')) {
          const [, storeAs, durStr] = phase.split(':');
          const durationSec = parseInt(durStr) || 30;
          if (typeof HRCapture !== 'undefined') {
            HRCapture.start(storeAs, durationSec);
          } else {
            console.warn('HR capture requested but HRCapture module not available; skipping.');
            advancePhase();
          }
          break;
        }
        console.warn(`Unknown phase token: ${phase}. Skipping.`);
        advancePhase();
    }
  }

  function advancePhase() {
    sessionData.currentPhase++;
    persistResumeState();  // snapshot after each phase completes
    runNextPhase();
  }

  function finalizeSession() {
    sessionData.status = "complete";
    sessionData.completedAt = new Date().toISOString();

    // Stamp the completion lock BEFORE any UI work so even a partial crash
    // after this point doesn't let the participant redo the session.
    if (config.study?.completion_lock) {
      CompletionLock.stamp(sessionData.participantId, urlDay, urlSession);
    }

    // Clear the resume state — session is done.
    ResumeManager.clear(sessionData.participantId, urlDay, urlSession);

    if (isPreview) {
      document.getElementById('screen-end').querySelector('p').textContent = '✓ Preview complete.';
      show('screen-end');
      return;
    }

    // Beat count vanity (ePAT-specific; harmless when absent)
    const totalBeats = sessionData.data.reduce((sum, entry) => {
      if (entry.type === "baseline") return sum + (entry.recordedHR ? entry.recordedHR.length : 0);
      if (entry.type === "trial")    return sum + (entry.qualitySummary ? entry.qualitySummary.totalBeats : 0);
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
  window.__persistResumeState = persistResumeState;

})();