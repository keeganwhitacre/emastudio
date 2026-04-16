"use strict";

const SCHEMA_VERSION = "1.1.0";

let state = {
  study: {
    name: "Interoception Study",
    institution: "",
    theme: "oled", // "oled", "dark", or "light"
    accent_color: "#e8716a",
    output_format: "json",
    // Greetings will map dynamically to window IDs
    greetings: { w1: "Good Morning", w2: "Check-In", w3: "Good Evening" }
  },
  tasks: ["ema"],
  onboarding: {
    enabled: true,
    ask_schedule: true, // Toggle for scheduling
    consent_text: "<h3>1. Purpose</h3>\n<p>This research investigates individual differences in how people perceive internal body signals such as heartbeats, and how this relates to mood and daily experience.</p>\n<h3>2. What You Will Do</h3>\n<p>You will complete brief daily check-ins for the duration of the study. You will also complete a task where you adjust an auditory tone to match your heartbeat using a dial.</p>\n<h3>3. Confidentiality</h3>\n<p>All data are stored under a participant ID number with no identifying information.</p>\n<h3>4. Contact</h3>\n<p>For questions about this study, contact the research team.</p>"
  },
  ema: {
    questions: [
      { id: "q1", type: "slider", text: "Right now, my mood is…", min: 0, max: 100, step: 1, unit: null, anchors: ["Unpleasant", "Pleasant"], required: true, condition: null },
      { id: "q2", type: "slider", text: "Right now, my energy level is…", min: 0, max: 100, step: 1, unit: null, anchors: ["Low / Calm", "High / Activated"], required: true, condition: null },
      { id: "q3", type: "choice", text: "What are you doing right now?", options: ["Resting", "Working / Studying", "Socializing", "Exercising", "Eating", "Commuting", "Other"], required: true, condition: null }
    ],
    scheduling: {
      study_days: 14,
      daily_prompts: 3,
      days_of_week: [1,2,3,4,5],
      windows: [
        { id: "w1", label: "Morning",   start: "08:00", end: "10:00" },
        { id: "w2", label: "Afternoon", start: "13:00", end: "15:00" },
        { id: "w3", label: "Evening",   start: "19:00", end: "21:00" }
      ],
      timing: { expiry_minutes: 60, grace_minutes: 10 }
    }
  },
  pat: {
    enabled: false, // Disabled by default as requested
    trials: 20,
    trial_duration_sec: 30,
    retry_budget: 30,
    sqi_threshold: 0.3,
    confidence_ratings: true,
    two_phase_practice: true,
    body_map: true
  }
};

let previewSession = "onboarding"; // Default preview to onboarding so users see it immediately
let previewDebounceTimer = null;
let qIdCounter = 10;
let wIdCounter = 10;

function genQId() { return `q${++qIdCounter}`; }
function genWId() { return `w${++wIdCounter}`; }

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

function buildConfig() {
  const cfg = {
    schema_version: SCHEMA_VERSION,
    study: JSON.parse(JSON.stringify(state.study)),
    tasks: [...state.tasks],
    onboarding: JSON.parse(JSON.stringify(state.onboarding)),
    ema: JSON.parse(JSON.stringify(state.ema))
  };
  if (state.pat.enabled) {
    cfg.pat = JSON.parse(JSON.stringify(state.pat));
    if (!cfg.tasks.includes("pat")) cfg.tasks.push("pat");
  }
  return cfg;
}