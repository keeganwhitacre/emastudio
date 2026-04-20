"use strict";

// ---------------------------------------------------------------------------
// EMA Studio — state.js
// Schema v1.4.0
//
// Changes from v1.3.0:
//   - SCHEMA_VERSION bumped to 1.4.0
//   - study.completion_lock (boolean) — if true, the runtime refuses to let a
//     participant complete the same (pid, day, sessionId) twice. Enforced
//     client-side via localStorage — see CompletionLock in study-base.js.
//     Default: true (most EMA designs want this).
//   - study.resume_enabled (boolean) — if true, the runtime persists partial
//     session state to localStorage after every phase transition so a crashed
//     or backgrounded session can resume from the URL. Default: true.
//   - Windows keep the legacy `phases: {pre, task, post}` triple for
//     backward compat with existing builder UIs, BUT buildConfig() also emits
//     a `phase_sequence` array form, and the runtime prefers that when
//     present. This lets a future Schedule UI edit ordered multi-task
//     sequences without another schema break.
//
// PHASE SEQUENCE SPEC (new, forward-looking):
//   Each entry is one of:
//     { kind: "ema",  block: "pre"  | "post" }
//     { kind: "task", id:    "epat" | "stroop" | ... }
//   Tokens emitted into sessionData.phases at runtime:
//     kind: ema  → "pre_<wid>" / "post_<wid>"
//     kind: task → "<moduleId>"
//   Windows that only specify the legacy triple are auto-expanded by
//   buildConfig().
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1.4.0";

let state = {
  study: {
    name: "Interoception Study",
    institution: "",
    theme: "oled",              // "oled" | "dark" | "light"
    accent_color: "#e8716a",
    output_format: "csv",       // "csv" | "json"
    completion_lock: true,      // one completed session per (pid, day, windowId)
    resume_enabled: true,       // persist partial session for crash recovery
    greetings: { w1: "Good Morning", w2: "Check-In", w3: "Good Evening" }
  },

  onboarding: {
    enabled: true,
    ask_schedule: true,
    consent_text: "<h3>1. Purpose</h3>\n<p>This research investigates individual differences in how people perceive internal body signals such as heartbeats, and how this relates to mood and daily experience.</p>\n<h3>2. What You Will Do</h3>\n<p>You will complete brief daily check-ins for the duration of the study. You will also complete a task where you adjust an auditory tone to match your heartbeat using a dial.</p>\n<h3>3. Confidentiality</h3>\n<p>All data are stored under a participant ID number with no identifying information.</p>\n<h3>4. Contact</h3>\n<p>For questions about this study, contact the research team.</p>"
  },

  // ------------------------------------------------------------
  // MODULE REGISTRY (unchanged from v1.3)
  // ------------------------------------------------------------
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
        { id: "w1", label: "Morning",   start: "08:00", end: "10:00", phases: { pre: true, task: null, post: false } },
        { id: "w2", label: "Afternoon", start: "13:00", end: "15:00", phases: { pre: true, task: null, post: false } },
        { id: "w3", label: "Evening",   start: "19:00", end: "21:00", phases: { pre: true, task: null, post: false } }
      ],
      timing: { expiry_minutes: 60, grace_minutes: 10 }
    }
  }
};

// ---------------------------------------------------------------------------
// Ephemeral UI state — not persisted
// ---------------------------------------------------------------------------
let previewSession = "onboarding";
let previewDebounceTimer = null;
let qIdCounter = 10;
let wIdCounter = 10;

function genQId() { return `q${++qIdCounter}`; }
function genWId() { return `w${++wIdCounter}`; }

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
// phasesToSequence(w) — expand the legacy {pre, task, post} triple into the
// new phase_sequence array. This is the single source of truth for the
// expansion rule; the Schedule tab and the runtime both go through here
// (transitively, since buildConfig emits the expanded form).
// ---------------------------------------------------------------------------
function phasesToSequence(w) {
  // If a window already has an explicit phase_sequence, use it verbatim.
  if (Array.isArray(w.phase_sequence) && w.phase_sequence.length > 0) {
    return w.phase_sequence.map(p => ({ ...p }));
  }
  const ph = w.phases || { pre: true, task: null, post: false };
  const seq = [];
  if (ph.pre)              seq.push({ kind: "ema",  block: "pre"  });
  if (ph.task)             seq.push({ kind: "task", id:    ph.task });
  if (ph.post && ph.task)  seq.push({ kind: "ema",  block: "post" });
  return seq;
}

// ---------------------------------------------------------------------------
// buildConfig — serialises state into the config.json schema consumed by
// study-base.js at runtime.
//
// v1.4 schema contract:
//   - schema_version           — "1.4.0"
//   - study                    — branding, theme, greetings, output_format,
//                                completion_lock, resume_enabled
//   - onboarding               — consent + schedule prefs
//   - ema.questions            — array with block + windows filters
//   - ema.scheduling.windows   — each window has BOTH:
//                                  phases: {pre, task, post}  (legacy triple)
//                                  phase_sequence: [...]      (expanded array)
//                                Runtime prefers phase_sequence if non-empty.
//   - modules                  — object keyed by module id → settings
// ---------------------------------------------------------------------------
function buildConfig() {
  const cfg = {
    schema_version: SCHEMA_VERSION,
    study:      JSON.parse(JSON.stringify(state.study)),
    onboarding: JSON.parse(JSON.stringify(state.onboarding)),
    ema:        JSON.parse(JSON.stringify(state.ema)),
    modules:    {}
  };

  // Belt-and-suspenders defaults for study flags — if a pre-v1.4 project was
  // imported, these fields may be missing and we want sane behavior.
  if (cfg.study.completion_lock === undefined) cfg.study.completion_lock = true;
  if (cfg.study.resume_enabled  === undefined) cfg.study.resume_enabled  = true;

  // Expand phase_sequence for every window — runtime consumes this form.
  (cfg.ema?.scheduling?.windows || []).forEach(w => {
    w.phase_sequence = phasesToSequence(w);
  });

  // Emit each enabled module's settings under its id key
  state.modules.forEach(mod => {
    if (mod.enabled) {
      cfg.modules[mod.id] = JSON.parse(JSON.stringify(mod.settings));
    }
  });

  return cfg;
}