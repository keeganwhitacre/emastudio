"use strict";

// ==========================================================
// EMA Studio — export.js
// v1.3.0
// ==========================================================
//
// Changes from v1.2:
//
// THREE EXPORT MODES:
//   1. Single-file HTML — everything inline, ONE file. For quick shares.
//   2. Static-hosting zip (NEW) — index.html + config.json + css/ + js/
//      properly laid out for a web server / GitHub Pages. Config stays
//      swappable without touching HTML.
//   3. Project backup (JSON of builder state) — unchanged, this is the
//      "Save" button in the topbar, not the Export flow.
//
// ZIP WRITER:
//   Hand-rolled minimal zip with STORE (no compression) mode. About 80
//   lines, no dependency. Fine for the ~100KB study bundle sizes we emit.
//   If we ever need compression, swap in fflate.
//
// ==========================================================

let templates = {
  epatCore: null, studyBase: null,
  modOnboarding: null, modEma: null, modEpat: null
};

async function loadTemplates() {
  if (!templates.epatCore)      templates.epatCore      = await fetch('templates/epat-core.js').then(r => r.text());
  if (!templates.studyBase)     templates.studyBase     = await fetch('templates/study-base.js').then(r => r.text());
  if (!templates.modOnboarding) templates.modOnboarding = await fetch('templates/module-onboarding.js').then(r => r.text());
  if (!templates.modEma)        templates.modEma        = await fetch('templates/module-ema.js').then(r => r.text());
  if (!templates.modEpat)       templates.modEpat       = await fetch('templates/module-epat.js').then(r => r.text());
}

function getThemeCSS(theme, accent) {
  let css = `--accent: ${accent}; --accent-hover: ${darkenHex(accent, 20)}; --accent-red: #ff453a; --accent-green: #32d74b; --radius: 14px; --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;`;

  if (theme === 'light') {
    css += ` --bg: #f9f9fb; --bg-surface: #ffffff; --bg-elevated: #f0f0f4; --border: #e0e0e5; --fg: #1c1c1e; --fg-muted: #8e8e93;`;
  } else if (theme === 'dark') {
    css += ` --bg: #121212; --bg-surface: #1e1e1e; --bg-elevated: #2d2d2d; --border: #3d3d3d; --fg: #e0e0e0; --fg-muted: #9e9e9e;`;
  } else { // oled
    css += ` --bg: #000000; --bg-surface: #111111; --bg-elevated: #1c1c1e; --border: #2c2c2e; --fg: #ffffff; --fg-muted: #8e8e93;`;
  }
  return css;
}

// ==========================================================
// Stitch the study JS: fills in the three placeholder tokens in
// study-base.js (config loader, expiry check, preview session force)
// and concatenates onboarding + EMA + any enabled task modules.
// ==========================================================
function stitchStudyJs(cfg, { configInline, previewMode, previewSession: _ps }) {
  const previewFlag = `window.__PREVIEW_MODE__ = ${previewMode};`;

  const configLoader = configInline
    ? `async function loadConfig() { return Promise.resolve(window.__CONFIG__); }`
    : `async function loadConfig() { const r = await fetch('config.json'); if (!r.ok) throw new Error('Could not load config.json'); return r.json(); }`;

  const expiryCheck = previewMode ? '' : `
    const tParam = params.get('t');
    const expiryMs = (config.ema.scheduling.timing?.expiry_minutes || 60) * 60 * 1000;
    if (tParam && (Date.now() - parseInt(tParam)) > expiryMs) {
      document.getElementById('task-subtitle').textContent = 'Link Expired';
      document.getElementById('start-btn').disabled = true;
      document.getElementById('start-btn').textContent = 'Session no longer active';
      return;
    }`;

  const fallbackSession = cfg.ema?.scheduling?.windows?.[0]?.id || 'onboarding';
  const previewSessionForce = previewMode
    ? `const sessionId = ${JSON.stringify(_ps || fallbackSession)};`
    : `const sessionId = params.get('session') || ${JSON.stringify(fallbackSession)};`;

  let studyJs = templates.studyBase;
  studyJs = studyJs.replace('// {{CONFIG_LOADER}}', () => configLoader + '\n' + previewFlag);
  studyJs = studyJs.replace('// {{EXPIRY_CHECK}}', () => expiryCheck);
  studyJs = studyJs.replace('// {{PREVIEW_SESSION_FORCE}}', () => previewSessionForce);

  // Stitch modules — onboarding + ema always, any enabled task modules appended.
  // Modules are injected at the {{MODULES_INJECT}} marker, which is INSIDE the
  // async IIFE so they have access to config, sessionData, advancePhase, etc.
  const moduleParts = [templates.modOnboarding, templates.modEma];
  if (cfg.modules?.epat) moduleParts.push(templates.modEpat);
  // Future: if (cfg.modules?.stroop) moduleParts.push(templates.modStroop);

  const injectedModules = moduleParts.join('\n\n');
  studyJs = studyJs.replace('// {{MODULES_INJECT}}', () => injectedModules);

  return studyJs;
}

// ==========================================================
// Shared HTML body (screens + markup). Parameterized by themeCSS and whether
// config/pat-core/study-js should be inlined or linked as separate files.
// ==========================================================
function buildHtmlShell({ cfg, themeCSS, includeEpatCore,
                          configTag, coreTag, studyTag, cssTag }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <title>${escH(cfg.study.name)}</title>
  ${configTag}
  ${coreTag}
  ${cssTag}
</head>
<body>
  <!-- Hidden Camera feeds -->
  <video id="video-feed" playsinline muted style="position:fixed;top:-999px;opacity:0;"></video>
  <canvas id="sampling-canvas" style="position:fixed;top:-999px;opacity:0;"></canvas>

  <div class="sensor-warning-overlay" id="sensor-warning-overlay">
    <canvas id="sensor-preview-circle" class="sensor-preview-circle"></canvas>
    <div class="sensor-warning-text" id="sensor-warning-text">Place finger on camera</div>
  </div>

  <div class="screen active" id="screen-pid">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 24px;"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <h1 id="study-title">Loading…</h1>
      <h2 id="task-subtitle"></h2>
      <div id="day-label" style="display:none; font-family: var(--font-mono); font-size: 0.8rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px;"></div>
      <div class="input-group" id="participant-input-group" style="margin-top: 24px;">
        <label class="label">Participant ID</label>
        <input type="text" id="pid-input" autocomplete="off" placeholder="Enter ID">
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="start-btn" disabled>Begin Session</button>
  </div>

  <!-- Onboarding Sub-Screens -->
  <div class="screen" id="screen-onboarding">
    <div class="ema-item-container" id="onboarding-container"></div>
    <div style="margin-top: 32px;"><button class="btn btn-primary btn-block" id="onboarding-next-btn">Continue</button></div>
  </div>

  <div class="screen" id="screen-ob-consent">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:20%"></div></div>
    <h1>Informed Consent</h1>
    <p class="consent-scroll-hint" id="ob-consent-hint">↓ Scroll to read</p>
    <div class="consent-scroll" id="ob-consent-scroll"></div>
    <label class="checkbox-row" id="ob-consent-check-row" style="opacity:0.4; pointer-events:none;">
      <input type="checkbox" id="ob-consent-check">
      <span>I have read and understood the above.</span>
    </label>
    <div class="ob-input"><input type="text" id="ob-initials" placeholder="Your initials" disabled></div>
    <button class="btn btn-primary btn-block" id="ob-consent-next" disabled>Continue</button>
  </div>

  <!-- Onboarding Schedule, Device Checks, Complete — placeholder structures preserved -->
  <div class="screen" id="screen-ob-schedule">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:50%"></div></div>
    <h1>Your Schedule</h1>
    <p>Select the days you're available.</p>
    <div class="schedule-section">
      <div class="day-grid" id="ob-day-grid">
        <button class="day-btn" data-day="1">Mo</button><button class="day-btn" data-day="2">Tu</button>
        <button class="day-btn" data-day="3">We</button><button class="day-btn" data-day="4">Th</button>
        <button class="day-btn" data-day="5">Fr</button><button class="day-btn" data-day="6">Sa</button>
        <button class="day-btn" data-day="7">Su</button>
      </div>
    </div>
    <div class="schedule-section">
      <div class="time-row"><span class="time-row-label">Morning</span><input type="time" id="ob-am-start" value="08:00"><span class="time-sep">to</span><input type="time" id="ob-am-end" value="10:00"></div>
      <div class="time-row"><span class="time-row-label">Afternoon</span><input type="time" id="ob-pm-start" value="13:00"><span class="time-sep">to</span><input type="time" id="ob-pm-end" value="15:00"></div>
      <div class="time-row"><span class="time-row-label">Evening</span><input type="time" id="ob-ev-start" value="19:00"><span class="time-sep">to</span><input type="time" id="ob-ev-end" value="21:00"></div>
    </div>
    <button class="btn btn-primary btn-block" id="ob-schedule-next">Continue</button>
  </div>

  <div class="screen" id="screen-ob-device">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:80%"></div></div>
    <h1>Device Check</h1>
    <p id="ob-device-status">Ready to run checks.</p>
    <div class="check-list">
      <div class="check-item" id="ob-check-camera"><span>Camera</span><span id="ob-check-camera-status">Not tested</span></div>
      <div class="check-item" id="ob-check-torch"><span>Torch</span><span id="ob-check-torch-status">Not tested</span></div>
      <div class="check-item" id="ob-check-audio"><span>Audio</span><span id="ob-check-audio-status">Not tested</span></div>
      <div class="check-item" id="ob-check-signal"><span>Signal</span><span id="ob-check-signal-status">Not tested</span></div>
    </div>
    <button class="btn btn-primary btn-block" id="ob-device-start">Run Checks</button>
    <button class="btn btn-primary btn-block" id="ob-device-next" style="display:none;">Continue</button>
  </div>

  <div class="screen" id="screen-ob-complete">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:100%"></div></div>
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center;">
      <h1>Setup Complete</h1>
      <p>Your check-in schedule has been saved.</p>
    </div>
    <button class="btn btn-primary btn-block" id="ob-complete-pat">Begin First Session →</button>
  </div>

  <!-- Primary EMA Screen -->
  <div class="screen" id="screen-ema">
    <h2 id="ema-greeting" style="margin-bottom: 12px; font-weight: 600; color: var(--fg);">Check-In</h2>
    <div class="ema-progress"><div class="ema-progress-fill" id="ema-progress-fill" style="width:0%"></div></div>
    <div class="ema-item-container" id="ema-single-container"></div>
    <div style="margin-top: 40px; flex-shrink: 0;"><button class="btn btn-primary btn-block" id="ema-next-btn" disabled>Next</button></div>
  </div>

  <!-- PAT Screens -->
  <div class="screen" id="screen-baseline">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
      <div style="margin-bottom: 40px;"><h1>Calibration</h1><p class="label">Keep your finger completely still</p></div>
      <div class="progress-ring">
        <svg viewBox="0 0 180 180"><circle class="track" cx="90" cy="90" r="85"/><circle class="fill" id="baseline-progress-circle" cx="90" cy="90" r="85"/></svg>
        <div class="baseline-bpm-box"><div class="baseline-bpm-number" id="baseline-bpm">--</div><div class="baseline-bpm-label">BPM</div></div>
      </div>
    </div>
  </div>

  <div class="screen" id="screen-trial">
    <div class="movement-warning" id="trial-movement-warning">Keep still</div>
    <div style="text-align: center; position: absolute; top: calc(env(safe-area-inset-top, 24px) + 24px); width: 100%;">
      <p class="label" id="trial-label" style="color: var(--fg-muted);">Trial 1</p>
    </div>
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center;">
      <div id="rotary-dial" class="rotary-dial"><div id="rotary-dial-ticks" class="rotary-dial-ticks"></div></div>
    </div>
    <button class="btn btn-primary btn-block" id="confirm-trial-btn" disabled>Confirm</button>
  </div>

  <div class="screen" id="screen-bodymap">
    <h1>Where did you feel it?</h1>
    <div class="body-map-container"><!-- body parts injected separately --></div>
    <button id="nowhere-btn">I didn't feel anything</button>
    <button class="btn btn-primary btn-block" id="confirm-bodymap-btn" disabled>Continue</button>
  </div>

  <div class="screen" id="screen-end">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 24px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <h1>Session Complete</h1>
      <p>Thank you for your participation.</p>
      <p id="end-beat-count" style="display:none; font-family: var(--font-mono); font-size: 1rem; color: var(--accent); margin-top: 0;"></p>
    </div>
    <button class="btn btn-secondary btn-block" id="download-btn">Save Local Copy</button>
  </div>

  ${studyTag}
</body>
</html>`;
}

// ==========================================================
// PUBLIC: build a full single-file HTML (config + CSS + JS all inline)
// Kept as the name buildStudyHtml for backward compat with preview.js.
// ==========================================================
async function buildStudyHtml({ configInline, previewMode = false, previewSession: _ps }) {
  await loadTemplates();
  const cfg = buildConfig();
  const themeCSS = getThemeCSS(cfg.study.theme, cfg.study.accent_color);
  const runtimeCss = getRuntimeCss();

  const studyJs = stitchStudyJs(cfg, { configInline, previewMode, previewSession: _ps });

  const configTag = configInline ? `<script>window.__CONFIG__ = ${JSON.stringify(cfg)};<\/script>` : '';
  const coreTag   = cfg.modules?.epat ? `<script>\n${templates.epatCore}\n<\/script>` : '';
  const cssTag    = `<style>:root{${themeCSS}}${runtimeCss}</style>`;
  const studyTag  = `<script>\n${studyJs}\n<\/script>`;

  return buildHtmlShell({ cfg, themeCSS, includeEpatCore: !!cfg.modules?.epat,
                          configTag, coreTag, studyTag, cssTag });
}

// ==========================================================
// PUBLIC: build the static-hosting bundle.
// Returns { files: [{path, content}] } ready for zipping.
// ==========================================================
async function buildStaticBundle() {
  await loadTemplates();
  const cfg = buildConfig();
  const themeCSS = getThemeCSS(cfg.study.theme, cfg.study.accent_color);
  const runtimeCss = getRuntimeCss();

  // JS stitched with external config loader (fetches config.json at runtime)
  const studyJs = stitchStudyJs(cfg, { configInline: false, previewMode: false });

  // HTML uses <link> for CSS and <script src=> for JS
  const configTag = ''; // no inline config
  const coreTag   = cfg.modules?.epat ? `<script src="js/epat-core.js"></script>` : '';
  const cssTag    = `<link rel="stylesheet" href="css/study.css">`;
  const studyTag  = `<script src="js/study.js"></script>`;

  const html = buildHtmlShell({ cfg, themeCSS, includeEpatCore: !!cfg.modules?.epat,
                                 configTag, coreTag, studyTag, cssTag });

  // Theme vars are applied at runtime from config.json via
//   // applyThemeFromConfig() — don't bake them into the CSS.
  const studyCss = runtimeCss;

  const files = [
    { path: 'index.html',    content: html },
    { path: 'config.json',   content: JSON.stringify(cfg, null, 2) },
    { path: 'css/study.css', content: studyCss },
    { path: 'js/study.js',   content: studyJs }
  ];
  if (cfg.modules?.epat) {
    files.push({ path: 'js/epat-core.js', content: templates.epatCore });
  }

  // Also drop a README pointing at config.json
  files.push({
    path: 'README.txt',
    content: buildStaticReadme(cfg)
  });

  return { files };
}

function buildStaticReadme(cfg) {
  return `${cfg.study.name} — Static Deployment
Generated by EMA Studio v${cfg.schema_version}
 
STRUCTURE
  index.html            Entry point — what participants open
  config.json           Study configuration (questions, schedule, modules, theme)
  css/study.css         Base styles (theme-agnostic)
  js/study.js           Runtime
  ${cfg.modules?.epat ? 'js/epat-core.js       ePAT signal processing library' : ''}
 
DEPLOYMENT
  Upload the entire folder contents to any static host:
    - GitHub Pages
    - Netlify / Vercel
    - Institutional web server (Apache / nginx)
 
  Participants open:
    https://your-host.example.com/index.html?id=<PID>&day=<N>&session=<windowId>
  Or use the Deployment tab in EMA Studio to generate a CSV of pre-filled links.
 
UPDATING
  To change study parameters — questions, schedule, timing, theme, accent
  color — edit config.json directly and re-upload. No re-export needed.
  The runtime reads theme + accent_color at boot and applies them as
  CSS variables, so a color change is a single JSON edit.
 
RESUME BEHAVIOR
  If study.resume_enabled is true (default), participants who crash or
  close the app mid-session will see a "Resume Session" button when they
  reopen the same link. In-progress phase state (mid-EMA page, mid-trial)
  is not preserved — they restart the current phase, but already-completed
  phases' data survives. To disable, set study.resume_enabled: false.
 
COMPLETION LOCK
  If study.completion_lock is true (default), a participant can only
  complete each (pid, day, session) once. The lock is client-side in
  localStorage, so a participant who switches phones or clears data can
  bypass it. Researcher override: add ?force=1 to the URL.
 
DATA
  Participants' responses download to their device as:
    ${cfg.study.output_format === 'csv' ? '<slug>_<pid>_<date>_<sessionId>_ema.csv' : '<slug>_<pid>_<date>_<sessionId>.json'}
  ${cfg.modules?.epat ? '  + <slug>_<pid>_<date>_<sessionId>_task.json (ePAT signal data)' : ''}
  You are responsible for collecting these (email, upload form, etc.)
  — the runtime is purely client-side.
`;
}

// ==========================================================
// Minimal ZIP writer (STORE mode, no compression). Output is a Blob.
// Spec reference: https://pkware.cachefly.net/webdocs/APPNOTE/APPNOTE-6.3.3.TXT
// ==========================================================
function makeZip(files) {
  // Each file entry: {path, content:string}
  const encoder = new TextEncoder();
  const fileRecords = [];
  const centralRecords = [];
  let offset = 0;

  // CRC-32 table
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function writeU16(dv, pos, val) { dv.setUint16(pos, val, true); }
  function writeU32(dv, pos, val) { dv.setUint32(pos, val, true); }

  files.forEach(f => {
    const nameBytes = encoder.encode(f.path);
    const dataBytes = encoder.encode(f.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes + name)
    const lfhBuf = new ArrayBuffer(30);
    const lfhDv = new DataView(lfhBuf);
    writeU32(lfhDv, 0,  0x04034b50);         // signature
    writeU16(lfhDv, 4,  20);                  // version needed
    writeU16(lfhDv, 6,  0);                   // flags
    writeU16(lfhDv, 8,  0);                   // method: STORE
    writeU16(lfhDv, 10, 0);                   // mtime
    writeU16(lfhDv, 12, 0);                   // mdate
    writeU32(lfhDv, 14, crc);
    writeU32(lfhDv, 18, size);                // compressed size
    writeU32(lfhDv, 22, size);                // uncompressed size
    writeU16(lfhDv, 26, nameBytes.length);
    writeU16(lfhDv, 28, 0);                   // extra length

    const lfh = new Uint8Array(lfhBuf);
    fileRecords.push(lfh, nameBytes, dataBytes);

    // Central directory entry (46 bytes + name)
    const cdBuf = new ArrayBuffer(46);
    const cdDv = new DataView(cdBuf);
    writeU32(cdDv, 0,  0x02014b50);
    writeU16(cdDv, 4,  20);                   // version made by
    writeU16(cdDv, 6,  20);                   // version needed
    writeU16(cdDv, 8,  0);                    // flags
    writeU16(cdDv, 10, 0);                    // method
    writeU16(cdDv, 12, 0);                    // mtime
    writeU16(cdDv, 14, 0);                    // mdate
    writeU32(cdDv, 16, crc);
    writeU32(cdDv, 20, size);
    writeU32(cdDv, 24, size);
    writeU16(cdDv, 28, nameBytes.length);
    writeU16(cdDv, 30, 0);                    // extra length
    writeU16(cdDv, 32, 0);                    // comment length
    writeU16(cdDv, 34, 0);                    // disk number
    writeU16(cdDv, 36, 0);                    // internal attrs
    writeU32(cdDv, 38, 0);                    // external attrs
    writeU32(cdDv, 42, offset);               // offset of local header

    centralRecords.push(new Uint8Array(cdBuf), nameBytes);

    offset += lfh.length + nameBytes.length + dataBytes.length;
  });

  // Calc central dir size
  let cdSize = 0;
  centralRecords.forEach(r => cdSize += r.length);

  // End of central directory record (22 bytes, no comment)
  const eocdBuf = new ArrayBuffer(22);
  const eocdDv = new DataView(eocdBuf);
  writeU32(eocdDv, 0,  0x06054b50);
  writeU16(eocdDv, 4,  0);                    // disk
  writeU16(eocdDv, 6,  0);                    // disk with central dir
  writeU16(eocdDv, 8,  files.length);         // entries on this disk
  writeU16(eocdDv, 10, files.length);         // total entries
  writeU32(eocdDv, 12, cdSize);
  writeU32(eocdDv, 16, offset);               // offset of central dir
  writeU16(eocdDv, 20, 0);                    // comment length

  return new Blob([...fileRecords, ...centralRecords, new Uint8Array(eocdBuf)],
                  { type: 'application/zip' });
}

// ==========================================================
// Runtime CSS — the styles that go in the exported HTML, extracted here
// so both single-file and zip exports share one definition.
// ==========================================================
// NOTE: in v1.2 this was a massive inline template literal embedded in the
// giant `return \`<!DOCTYPE html>...\`` string in buildStudyHtml. I've
// pulled it out to a function so the bundle export can write it to a
// separate .css file. The actual CSS rules are unchanged from v1.2.
// If you customized the runtime CSS, paste your version into this function.
function getRuntimeCss() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; width: 100%; font-family: var(--font); background: var(--bg); color: var(--fg); overflow: hidden; touch-action: manipulation; user-select: none; -webkit-user-select: none; }

    /* Screen transitions */
    .screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(env(safe-area-inset-top, 24px) + 24px) 24px calc(env(safe-area-inset-bottom, 24px) + 24px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease-in-out; overflow-y: auto; }
    .screen.active { opacity: 1; pointer-events: all; }

    /* Typography */
    h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; color: var(--fg); text-align: center; }
    h2 { font-size: 1.1rem; font-weight: 400; color: var(--fg-muted); margin-bottom: 32px; letter-spacing: -0.01em; text-align: center; }
    p { font-size: 1.05rem; line-height: 1.5; color: var(--fg-muted); margin-bottom: 24px; font-weight: 400; text-align: center; }
    .label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; text-align: center; }

    /* Institution branding label on PID screen */
    .institution-label { font-size: 0.75rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; text-align: center; opacity: 0.8; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 18px 28px; border-radius: var(--radius); border: none; cursor: pointer; font-family: var(--font); font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:disabled { background: var(--bg-elevated); color: var(--fg-muted); }
    .btn-secondary { background: var(--bg-surface); color: var(--fg); border: 1px solid var(--border); }
    .btn-block { width: 100%; margin-top: auto; flex-shrink: 0; }

    /* PID input */
    .input-group { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 8px; }
    .input-group input { width: 100%; padding: 18px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .input-group input:focus { border-color: var(--accent); background: var(--bg-elevated); }

    /* ======== EMA SCREEN ======== */
    .ema-progress { height: 3px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; margin-bottom: 24px; flex-shrink: 0; }
    .ema-progress-fill { height: 100%; background: var(--accent); transition: width 0.3s ease-out; border-radius: 2px; }
    .ema-item-container { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; overflow-y: auto; padding: 8px 4px; }
    .ema-question { font-size: 1.15rem; font-weight: 500; color: var(--fg); margin-bottom: 24px; line-height: 1.4; text-align: left; }

    /* Slider */
    .slider-group { display: flex; flex-direction: column; gap: 12px; padding: 0 4px; }
    .slider-val-display { font-size: 2.2rem; font-weight: 600; color: var(--accent); text-align: center; font-variant-numeric: tabular-nums; }
    .range-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: var(--bg-elevated); border-radius: 3px; outline: none; }
    .range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 3px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .range-slider::-moz-range-thumb { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 3px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .slider-labels { display: flex; justify-content: space-between; font-size: 0.82rem; color: var(--fg-muted); padding: 0 4px; }

    /* Choice / Checkbox pills */
    .choice-group { display: flex; flex-direction: column; gap: 10px; }
    .choice-btn { display: block; width: 100%; padding: 16px 20px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1rem; font-weight: 500; text-align: left; cursor: pointer; transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1); -webkit-tap-highlight-color: transparent; }
    .choice-btn:hover { border-color: var(--fg-muted); background: var(--bg-elevated); }
    .choice-btn:active { transform: scale(0.99); }
    .choice-btn.selected { border-color: var(--accent); background: var(--bg-elevated); color: var(--accent); font-weight: 600; }
    .choice-btn.selected::before { content: '✓'; display: inline-block; margin-right: 10px; color: var(--accent); font-weight: 700; }

    /* Text / numeric input */
    .text-group { width: 100%; }
    .text-input { width: 100%; padding: 14px 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .text-input:focus { border-color: var(--accent); background: var(--bg-elevated); }

    /* ======== ONBOARDING ======== */
    .ob-progress { height: 3px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; margin-bottom: 20px; flex-shrink: 0; }
    .ob-progress-fill { height: 100%; background: var(--accent); transition: width 0.3s ease-out; }
    .consent-scroll-hint { font-size: 0.8rem; color: var(--accent); text-align: center; margin-bottom: 8px; transition: opacity 0.3s; }
    .consent-scroll { flex: 1; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; overflow-y: auto; margin-bottom: 16px; color: var(--fg); font-size: 0.95rem; line-height: 1.6; text-align: left; }
    .consent-scroll h3 { font-size: 1rem; font-weight: 600; margin: 16px 0 8px 0; color: var(--fg); text-align: left; }
    .consent-scroll p { font-size: 0.95rem; color: var(--fg); margin-bottom: 12px; text-align: left; }
    .checkbox-row { display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; margin-bottom: 12px; width: 100%; max-width: 340px; margin-left: auto; margin-right: auto; transition: opacity 0.3s, pointer-events 0.3s; }
    .checkbox-row input[type="checkbox"] { width: 24px; height: 24px; flex-shrink: 0; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
    .checkbox-row span { font-size: 0.95rem; color: var(--fg-muted); line-height: 1.5; text-align: left; }
    .ob-input { width: 100%; max-width: 340px; margin: 0 auto 20px; display: block; }
    .ob-input input { width: 100%; padding: 16px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.05rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .ob-input input:focus { border-color: var(--accent); background: var(--bg-elevated); }
    .ob-input input:disabled { opacity: 0.5; }

    .schedule-section { width: 100%; max-width: 340px; margin: 0 auto 28px; }
    .schedule-label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; }
    .day-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
    .day-btn { padding: 10px 0; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg-muted); font-size: 0.78rem; font-weight: 600; cursor: pointer; text-align: center; transition: all 0.15s; }
    .day-btn.selected { border-color: var(--accent); background: var(--bg-elevated); color: var(--accent); }
    .time-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .time-row-label { width: 76px; font-size: 0.82rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }
    .time-row input[type="time"] { flex: 1; padding: 12px 8px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font-mono); font-size: 0.9rem; outline: none; }
    .time-sep { color: var(--fg-muted); font-size: 0.85rem; flex-shrink: 0; }

    .check-list { width: 100%; max-width: 340px; margin: 0 auto 16px; }
    .check-item { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; font-size: 0.95rem; color: var(--fg); }
    .check-item.pass { border-color: var(--accent-green); color: var(--accent-green); }
    .check-item.fail { border-color: var(--accent-red); color: var(--accent-red); }
    .check-item.testing { border-color: var(--accent); color: var(--accent); }

    /* ======== ePAT SCREENS ======== */
    .progress-ring { position: relative; width: 180px; height: 180px; margin: 0 auto; }
    .progress-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .progress-ring circle { fill: none; stroke-width: 8; }
    .progress-ring circle.track { stroke: var(--bg-surface); }
    .progress-ring circle.fill { stroke: var(--accent); stroke-linecap: round; stroke-dasharray: 534; stroke-dashoffset: 534; transition: stroke-dashoffset 0.5s linear; }
    .baseline-bpm-box { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .baseline-bpm-number { font-size: 3rem; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
    .baseline-bpm-label { font-size: 0.85rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; }

    .rotary-dial { width: 220px; height: 220px; border-radius: 50%; background: var(--bg-surface); border: 2px solid var(--border); position: relative; cursor: grab; touch-action: none; }
    .rotary-dial:active { cursor: grabbing; }
    .rotary-dial-ticks { position: absolute; inset: 0; }
    .dial-tick { position: absolute; top: 4px; left: 50%; width: 2px; height: 8px; background: var(--fg-muted); transform-origin: 50% 106px; }

    .movement-warning { position: absolute; top: calc(env(safe-area-inset-top, 24px) + 80px); left: 50%; transform: translateX(-50%); background: var(--accent-red); color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity 0.3s; }
    .movement-warning.active { opacity: 1; }

    .sensor-warning-overlay { position: fixed; bottom: 100px; right: 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; opacity: 0; pointer-events: none; transition: opacity 0.3s; z-index: 10; }
    .sensor-warning-overlay.visible { opacity: 1; pointer-events: all; }
    .sensor-preview-circle { width: 60px; height: 60px; border-radius: 50%; border: 2px solid var(--fg); background: #000; transition: border-color 0.2s, box-shadow 0.2s; }
    .sensor-warning-text { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 0.8rem; color: var(--fg); max-width: 180px; text-align: center; line-height: 1.3; }

    .body-map-container { flex: 1; display: flex; align-items: center; justify-content: center; }
    .body-part { cursor: pointer; transition: all 0.15s; }
    .body-part.selected { fill: var(--accent); }
    #nowhere-btn { padding: 10px 20px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg-muted); font-family: var(--font); font-size: 0.9rem; cursor: pointer; margin: 16px auto; display: block; }
    #nowhere-btn.selected { border-color: var(--accent); color: var(--accent); }

    cconst AFFECT_GRID_CSS = 
    /* ======== AFFECT GRID ======== */
    .affect-grid-container { width: 100%; max-width: 360px; margin: 0 auto; }
    /* Values and marker positioning are inline on the SVG — the container
       just centers and spaces. SVG styles use CSS vars via inline style
       attrs set in module-ema.js. */
`;
}

// ==========================================================
// UI WIRING
// ==========================================================
function slugify(str) {
  return (str || 'study').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

document.getElementById('export-btn').addEventListener('click',
  () => document.getElementById('export-modal').classList.add('open'));
document.getElementById('modal-close-btn').addEventListener('click',
  () => document.getElementById('export-modal').classList.remove('open'));

// Single-file HTML export
document.getElementById('export-single-file').addEventListener('click', async () => {
  document.getElementById('export-modal').classList.remove('open');
  const html = await buildStudyHtml({ configInline: true, previewMode: false });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = slugify(state.study.name) + '-study.html';
  a.click();
});

// Static-hosting zip export (NEW — requires #export-zip button in modal)
const zipBtn = document.getElementById('export-zip');
if (zipBtn) {
  zipBtn.addEventListener('click', async () => {
    document.getElementById('export-modal').classList.remove('open');
    const { files } = await buildStaticBundle();
    const blob = makeZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slugify(state.study.name) + '-static.zip';
    a.click();
  });
}
