"use strict";

const SCHEMA_VERSION = "1.2.0";

let state = {
  study: {
    name: "Interoception Study",
    institution: "",
    theme: "oled", // "oled", "dark", or "light"
    accent_color: "#e8716a",
    output_format: "json",
    greetings: { w1: "Good Morning", w2: "Check-In", w3: "Good Evening" }
  },

  onboarding: {
    enabled: true,
    ask_schedule: true,
    consent_text: "<h3>1. Purpose</h3>\n<p>This research investigates individual differences in how people perceive internal body signals such as heartbeats, and how this relates to mood and daily experience.</p>\n<h3>2. What You Will Do</h3>\n<p>You will complete brief daily check-ins for the duration of the study. You will also complete a task where you adjust an auditory tone to match your heartbeat using a dial.</p>\n<h3>3. Confidentiality</h3>\n<p>All data are stored under a participant ID number with no identifying information.</p>\n<h3>4. Contact</h3>\n<p>For questions about this study, contact the research team.</p>"
  },

  // ------------------------------------------------------------
  // MODULE REGISTRY
  // Each entry describes one pluggable task module.
  // Fields:
  //   id       — machine key, used in window phases + config output
  //   label    — display name in the Tasks tab
  //   desc     — one-line description shown on the card
  //   badge    — optional pill text (e.g. "Beta")
  //   enabled  — whether this module is active in the study
  //   settings — module-specific config (typed freely per module)
  //
  // To add a new module (Stroop, IAT, etc.) in the future:
  // just push a new object here — the Tasks tab renders from this array.
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
    // Future modules go here, e.g.:
    // { id: "stroop", label: "Stroop Task", desc: "...", badge: null, enabled: false, settings: { ... } }
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
        {
          id: "w1", label: "Morning",   start: "08:00", end: "10:00",
          // phases describes the ordered sequence for this window:
          //   pre  — EMA block shown before the task (null = disabled)
          //   task — module id to run, or null for EMA-only
          //   post — EMA block shown after the task (null = disabled)
          // "pre" and "post" act as boolean toggles when task is null.
          phases: { pre: true, task: null, post: false }
        },
        {
          id: "w2", label: "Afternoon", start: "13:00", end: "15:00",
          phases: { pre: true, task: null, post: false }
        },
        {
          id: "w3", label: "Evening",   start: "19:00", end: "21:00",
          phases: { pre: true, task: null, post: false }
        }
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
// buildConfig — serialises state into the config.json schema consumed by
// study-base.js at runtime.
//
// Key decisions:
//   - modules: only enabled modules are emitted, each under their own id key
//     so study-base.js can do `if (config.epat)` rather than searching arrays.
//   - ema.questions carry their `block` field so the runtime can filter by
//     pre/post when a task is present in the window's phase sequence.
//   - windows carry their full `phases` object so the runtime knows the
//     session structure without any additional lookups.
// ---------------------------------------------------------------------------
function buildConfig() {
  const cfg = {
    schema_version: SCHEMA_VERSION,
    study:      JSON.parse(JSON.stringify(state.study)),
    onboarding: JSON.parse(JSON.stringify(state.onboarding)),
    ema:        JSON.parse(JSON.stringify(state.ema)),
    modules:    {}
  };
 
  // Emit each enabled module's settings under its id key
  state.modules.forEach(mod => {
    if (mod.enabled) {
      cfg.modules[mod.id] = JSON.parse(JSON.stringify(mod.settings));
    }
  });
 
  // Alias: module-epat.js reads config.pat.* — mirror the epat settings
  // there so it gets trials, trial_duration_sec, sqi_threshold, etc.
  // null when epat is not enabled (module-epat.js won't be in the export
  // anyway, but belt-and-suspenders).
  cfg.pat = cfg.modules.epat ?? null;
 
  // Legacy compatibility: flat tasks array for any code that checks config.tasks
  cfg.tasks = ["ema", ...state.modules.filter(m => m.enabled).map(m => m.id)];
 
  return cfg;
}