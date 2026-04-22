"use strict";

// ---------------------------------------------------------------------------
// EMA Forge — state.js
// Schema v1.5.0
//
// Changes from v1.4.0:
//
// MULTI-TASK SESSIONS:
//   Windows now store phase_sequence[] as the primary schema. The old
//   phases: {pre, task, post} triple is kept for backwards compat but
//   phasesToSequence() is the sole expansion path.
//   A phase_sequence step can now be:
//     { kind: "ema",  block: "pre"|"post" }
//     { kind: "task", id: "epat"|..., condition: {question_id, operator, value} | null }
//     { kind: "hr",   duration_sec: 30,  store_as: "q_hr_1" }
//   Multiple tasks in a single window are fully supported.
//
// HEART RATE QUESTION TYPE:
//   New EMA question type: heart_rate.
//   Captures PPG for `duration_sec` seconds via ePATCore.BeatDetector.
//   Stores { bpm, sqi, ibi_series } under the question ID.
//   Because `bpm` is a number, it participates in conditional logic normally
//   — evalCond compares against the bpm value directly.
//   Builder config: { duration_sec: 30, report_as: "bpm" }
//
// CONDITIONAL TASKS:
//   A task step in phase_sequence can carry a condition:
//     { kind: "task", id: "epat", condition: { question_id: "q_hr_1", operator: "gt", value: 80 } }
//   expandWindowToTokens() evaluates this against collected ema_response data
//   before emitting the token. False → step is silently skipped.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1.5.0";

let state = {
  study: {
    name: "",
    institution: "",
    theme: "oled",
    accent_color: "#e8716a",
    output_format: "csv",
    completion_lock: true,
    resume_enabled: true,
    webhook_url: "",
    greetings: { w1: "Good Morning", w2: "Check-In", w3: "Good Evening" }
  },

  onboarding: {
    enabled: true,
    ask_schedule: true,
    consent_text: "<h3>1. Purpose</h3>\n<p>This research investigates daily experiences and mood in real-world settings.</p>\n<h3>2. What You Will Do</h3>\n<p>You will complete brief daily check-ins for the duration of the study.</p>\n<h3>3. Confidentiality</h3>\n<p>All data are stored under a participant ID number with no identifying information.</p>\n<h3>4. Contact</h3>\n<p>For questions about this study, contact the research team.</p>"
  },

  modules: [
    {
      id: "epat",
      label: "ePAT",
      desc: "Ecological Phase Adjustment Task — objective cardiac interoceptive accuracy via PPG. Requires rear camera + torch on participant device.",
      badge: "Beta",
      enabled: false,
      settings: {
        trials: 20,
        trial_duration_sec: 30,
        retry_budget: 30,
        sqi_threshold: 0.3,
        confidence_ratings: true,
        two_phase_practice: true,
        body_map: true
      }
    }
  ],

  ema: {
    randomize_questions: false,
    questions: [
      { id: "q1", type: "slider",  text: "Right now, my mood is…",          min: 0, max: 100, step: 1, unit: null, anchors: ["Unpleasant", "Pleasant"],        required: true, condition: null, block: "both", windows: null },
      { id: "q2", type: "slider",  text: "Right now, my energy level is…",  min: 0, max: 100, step: 1, unit: null, anchors: ["Low / Calm", "High / Activated"], required: true, condition: null, block: "both", windows: null },
      { id: "q3", type: "choice",  text: "What are you doing right now?",   options: ["Resting", "Working / Studying", "Socializing", "Exercising", "Eating", "Commuting", "Other"], required: true, condition: null, block: "both", windows: null }
    ],
    scheduling: {
      study_days: 14,
      daily_prompts: 3,
      days_of_week: [1,2,3,4,5],
      windows: [
        {
          id: "w1", label: "Morning",   start: "08:00", end: "10:00",
          phases: { pre: true, task: null, post: false },
          phase_sequence: [{ kind: "ema", block: "pre" }]
        },
        {
          id: "w2", label: "Afternoon", start: "13:00", end: "15:00",
          phases: { pre: true, task: null, post: false },
          phase_sequence: [{ kind: "ema", block: "pre" }]
        },
        {
          id: "w3", label: "Evening",   start: "19:00", end: "21:00",
          phases: { pre: true, task: null, post: false },
          phase_sequence: [{ kind: "ema", block: "pre" }]
        }
      ],
      timing: { expiry_minutes: 60, grace_minutes: 10 }
    }
  }
};

// ---------------------------------------------------------------------------
// Ephemeral UI state
// ---------------------------------------------------------------------------
let previewSession = "onboarding";
let previewDebounceTimer = null;

// Use a random string to guarantee IDs never collide even after page reloads
function genQId() { return 'q_' + Math.random().toString(36).substr(2, 6); }
function genWId() { return 'w_' + Math.random().toString(36).substr(2, 6); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function darkenHex(hex, amount) {
  let r = parseInt(hex.slice(1,3),16);
  let g = parseInt(hex.slice(3,5),16);
  let b = parseInt(hex.slice(5,7),16);
  r = Math.max(0, r - amount);
  g = Math.max(0, g - amount);
  b = Math.max(0, b - amount);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function escH(str) {
  return (str||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------------------------------------------------------------------------
// phasesToSequence(w) — canonical expansion from legacy triple or explicit array.
// phase_sequence on the window is always used verbatim if present and non-empty.
// ---------------------------------------------------------------------------
function phasesToSequence(w) {
  if (Array.isArray(w.phase_sequence) && w.phase_sequence.length > 0) {
    return w.phase_sequence.map(p => ({ ...p }));
  }
  const ph = w.phases || { pre: true, task: null, post: false };
  const seq = [];
  if (ph.pre)             seq.push({ kind: "ema",  block: "pre" });
  if (ph.task)            seq.push({ kind: "task", id: ph.task, condition: null });
  if (ph.post && ph.task) seq.push({ kind: "ema",  block: "post" });
  return seq;
}

// ---------------------------------------------------------------------------
// buildConfig — serialises state into config.json consumed by study-base.js
// ---------------------------------------------------------------------------
function buildConfig() {
  const cfg = {
    schema_version: SCHEMA_VERSION,
    study:      JSON.parse(JSON.stringify(state.study)),
    onboarding: JSON.parse(JSON.stringify(state.onboarding)),
    ema:        JSON.parse(JSON.stringify(state.ema)),
    modules:    {}
  };

  if (cfg.study.completion_lock === undefined) cfg.study.completion_lock = true;
  if (cfg.study.resume_enabled  === undefined) cfg.study.resume_enabled  = true;

  // Always emit phase_sequence — runtime prefers this over legacy triple
  (cfg.ema?.scheduling?.windows || []).forEach(w => {
    w.phase_sequence = phasesToSequence(w);
  });

  state.modules.forEach(mod => {
    if (mod.enabled) {
      cfg.modules[mod.id] = JSON.parse(JSON.stringify(mod.settings));
    }
  });

 // Emit hr_capture settings if any question is of type heart_rate
  const hasHr = (cfg.ema?.questions || []).some(q => q.type === 'heart_rate');
  if (hasHr) cfg.modules.hr_capture = { enabled: true };

  return cfg;
}