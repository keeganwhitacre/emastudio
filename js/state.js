"use strict";

// ---------------------------------------------------------------------------
// EMA Studio — state.js
// Schema v1.3.0
//
// Changes from v1.2.0:
//   - SCHEMA_VERSION bumped to 1.3.0
//   - buildConfig() no longer emits the legacy `cfg.tasks` array. The runtime
//     now reads `config.modules` directly (keyed by module id), so there's no
//     further need for a compat shim. See templates/study-base.js v1.3.
//   - Kept the `pat`-alias emission REMOVED. Module settings live only under
//     `config.modules.epat`. If you're upgrading a deployment from v1.2, you
//     MUST re-export the study HTML — old exports reading `config.pat` will
//     no longer find their settings (but they were being silently ignored
//     anyway, so this just makes the break explicit rather than silent).
//   - output_format default is now 'csv' per the v1.3 default. Researchers
//     who want the nested JSON can still opt in via the Study tab toggle.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1.3.0";

let state = {
  study: {
    name: "Interoception Study",
    institution: "",
    theme: "oled", // "oled", "dark", or "light"
    accent_color: "#e8716a",
    output_format: "csv", // "csv" (long-format EMA responses) or "json" (full nested session)
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
  //   id       — machine key, used in window.phases.task + config.modules.<id>
  //   label    — display name in the Tasks tab
  //   desc     — one-line description shown on the card
  //   badge    — optional pill text (e.g. "Beta")
  //   enabled  — whether this module is active in the study
  //   settings — module-specific config (typed freely per module)
  //
  // To add a new module (Stroop, IAT, etc.):
  //   1. Push a new object into this array.
  //   2. Add a SETTINGS_RENDERERS entry in js/tabs/tasks.js for its settings UI.
  //   3. Create templates/module-<id>.js with a public .startFrom(sessionId) hook.
  //   4. Wire it into js/export.js templates + study-base.js runNextPhase switch.
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
    // Future modules go here.
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
          //   pre  — boolean; show EMA block before the task
          //   task — module id string (e.g. "epat") or null for EMA-only
          //   post — boolean; show EMA block after the task (no-op if task is null)
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
// v1.3 schema contract:
//   - schema_version           — string, e.g. "1.3.0"
//   - study                    — branding, theme, greetings, output_format
//   - onboarding               — consent + schedule prefs
//   - ema.questions            — array with block + windows filters
//   - ema.scheduling.windows   — array of { id, label, start, end, phases:{pre,task,post} }
//   - modules                  — object keyed by module id → settings
//
// NOT emitted (removed in v1.3):
//   - cfg.tasks (legacy array) — the runtime reads cfg.modules directly.
//   - cfg.pat alias            — module settings live under cfg.modules.epat.
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

  return cfg;
}
