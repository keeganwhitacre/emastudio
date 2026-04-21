"use strict";

// ==========================================================
// EMA Studio — export.js  v1.5.0
// ==========================================================
// Changes from v1.3.1:
//   - Removed modHrCapture — HR capture is a question type handled inline
//     by module-ema.js, not a separate phase module. Fetching a file that
//     doesn't exist was crashing loadTemplates() and blanking the preview.
//   - stitchStudyJs: HR capture is included automatically when ePATCore is
//     present; no separate flag needed.
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
  if (theme === 'light')       css += ` --bg: #f9f9fb; --bg-surface: #ffffff; --bg-elevated: #f0f0f4; --border: #e0e0e5; --fg: #1c1c1e; --fg-muted: #8e8e93;`;
  else if (theme === 'dark')   css += ` --bg: #121212; --bg-surface: #1e1e1e; --bg-elevated: #2d2d2d; --border: #3d3d3d; --fg: #e0e0e0; --fg-muted: #9e9e9e;`;
  else                         css += ` --bg: #000000; --bg-surface: #111111; --bg-elevated: #1c1c1e; --border: #2c2c2e; --fg: #ffffff; --fg-muted: #8e8e93;`;
  return css;
}

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

  const moduleParts = [templates.modOnboarding, templates.modEma];
  if (cfg.modules?.epat) moduleParts.push(templates.modEpat);
  // Heart rate capture is a question type handled inside module-ema.js.
  // No separate module file needed — ePATCore provides BeatDetector when epat is enabled.

  studyJs = studyJs.replace('// {{MODULES_INJECT}}', () => moduleParts.join('\n\n'));
  return studyJs;
}

function buildHtmlShell({ cfg, themeCSS, includeEpatCore, configTag, coreTag, studyTag, cssTag }) {
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
  <video id="video-feed" playsinline muted style="position:fixed;top:-999px;opacity:0;"></video>
  <canvas id="sampling-canvas" style="position:fixed;top:-999px;opacity:0;"></canvas>
  <div class="sensor-warning-overlay" id="sensor-warning-overlay">
    <canvas id="sensor-preview-circle" class="sensor-preview-circle"></canvas>
    <div class="sensor-warning-text" id="sensor-warning-text">Place finger on camera</div>
  </div>

  <div class="screen active" id="screen-pid">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:24px;"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <h1 id="study-title">Loading…</h1>
      <h2 id="task-subtitle"></h2>
      <div id="day-label" style="display:none;font-family:var(--font-mono);font-size:0.8rem;color:var(--accent);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;"></div>
      <div class="input-group" id="participant-input-group" style="margin-top:24px;">
        <label class="label">Participant ID</label>
        <input type="text" id="pid-input" autocomplete="off" placeholder="Enter ID">
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="start-btn" disabled>Begin Session</button>
  </div>

  <div class="screen" id="screen-onboarding">
    <div class="ema-item-container" id="onboarding-container"></div>
    <div style="margin-top:32px;"><button class="btn btn-primary btn-block" id="onboarding-next-btn">Continue</button></div>
  </div>

  <div class="screen" id="screen-ob-consent">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:20%"></div></div>
    <h1>Informed Consent</h1>
    <p class="consent-scroll-hint" id="ob-consent-hint">↓ Scroll to read</p>
    <div class="consent-scroll" id="ob-consent-scroll"></div>
    <label class="checkbox-row" id="ob-consent-check-row" style="opacity:0.4;pointer-events:none;">
      <input type="checkbox" id="ob-consent-check">
      <span>I have read and understood the above. I voluntarily agree to participate.</span>
    </label>
    <div class="ob-input"><input type="text" id="ob-initials" placeholder="Your initials" maxlength="5" autocomplete="off" style="text-transform:uppercase;" disabled></div>
    <button class="btn btn-primary btn-block" id="ob-consent-next" disabled>I Consent — Continue</button>
  </div>

  <div class="screen" id="screen-ob-schedule">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:40%"></div></div>
    <h1>Scheduling</h1>
    <p>Choose your available days and preferred check-in windows.</p>
    <div class="schedule-section">
      <span class="schedule-label">Available days</span>
      <div class="day-grid" id="ob-day-grid">
        <button class="day-btn selected" data-day="Mon">Mon</button><button class="day-btn selected" data-day="Tue">Tue</button>
        <button class="day-btn selected" data-day="Wed">Wed</button><button class="day-btn selected" data-day="Thu">Thu</button>
        <button class="day-btn selected" data-day="Fri">Fri</button><button class="day-btn selected" data-day="Sat">Sat</button>
        <button class="day-btn selected" data-day="Sun">Sun</button>
      </div>
    </div>
    <div class="schedule-section">
      <span class="schedule-label">Check-in time windows</span>
      <div class="time-row"><span class="time-row-label">Morning</span><input type="time" id="ob-am-start" value="08:00"><span class="time-sep">–</span><input type="time" id="ob-am-end" value="10:00"></div>
      <div class="time-row"><span class="time-row-label">Afternoon</span><input type="time" id="ob-pm-start" value="13:00"><span class="time-sep">–</span><input type="time" id="ob-pm-end" value="15:00"></div>
      <div class="time-row"><span class="time-row-label">Evening</span><input type="time" id="ob-ev-start" value="19:00"><span class="time-sep">–</span><input type="time" id="ob-ev-end" value="21:00"></div>
    </div>
    <div style="flex:1;min-height:16px;"></div>
    <button class="btn btn-primary btn-block" id="ob-schedule-next">Continue</button>
  </div>

  <div class="screen" id="screen-ob-device">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:60%"></div></div>
    <h1>Device Check</h1>
    <p style="margin-bottom:24px;">We'll confirm your device supports the task. For multi-lens phones, cover the lens <em>closest</em> to the flashlight.</p>
    <div class="check-list">
      <div class="check-item" id="ob-check-camera"><div class="check-icon">📷</div><div class="check-info"><div class="check-title">Camera</div><div class="check-status" id="ob-check-camera-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-torch"><div class="check-icon">🔦</div><div class="check-info"><div class="check-title">Flashlight</div><div class="check-status" id="ob-check-torch-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-audio"><div class="check-icon">🔊</div><div class="check-info"><div class="check-title">Audio</div><div class="check-status" id="ob-check-audio-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-signal"><div class="check-icon">♥</div><div class="check-info"><div class="check-title">PPG Signal</div><div class="check-status" id="ob-check-signal-status">Waiting…</div></div></div>
      <div id="ob-signal-preview-wrap" style="display:none;justify-content:center;margin:4px 0 8px;">
        <canvas id="ob-signal-preview" style="width:80px;height:80px;border-radius:50%;border:2px solid var(--border);background:#000;display:block;"></canvas>
      </div>
    </div>
    <p id="ob-device-status" style="text-align:center;font-size:0.9rem;min-height:1.4em;color:var(--fg-muted);"></p>
    <div style="flex:1;min-height:16px;"></div>
    <button class="btn btn-primary btn-block" id="ob-device-start">Run Checks</button>
    <button class="btn btn-primary btn-block" id="ob-device-next" style="display:none;margin-top:12px;">Continue</button>
    <button class="btn btn-secondary btn-block" id="ob-device-retry" style="display:none;margin-top:8px;">Retry</button>
  </div>

  <div class="screen" id="screen-ob-training">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:80%"></div></div>
    <h1>Learn the Task</h1>
    <p style="margin-bottom:16px;">A simulated heartbeat plays below. Rotate the dial to move the tone earlier or later until it lands on each beat.</p>
    <div class="training-timeline"><canvas id="training-canvas"></canvas></div>
    <div class="training-dial-wrapper">
      <div class="training-dial-ticks" id="training-dial-ticks"></div>
      <div class="training-dial" id="training-dial"><div class="training-dial-indicator"></div></div>
    </div>
    <div class="training-dial-labels"><span>Earlier</span><span>Later</span></div>
    <p class="training-status" id="training-status">Rotate the dial to align the tone with the beats</p>
    <div style="flex:1;min-height:8px;"></div>
    <button class="btn btn-primary btn-block" id="ob-training-next" disabled>Continue</button>
  </div>

  <div class="screen" id="screen-ob-complete">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:100%"></div></div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:24px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <h1>You're All Set</h1>
      <p>Setup is complete. Your first session begins now.</p>
    </div>
    <button class="btn btn-primary btn-block" id="ob-complete-pat">Begin First Session →</button>
  </div>

  <div class="screen" id="screen-ema">
    <h2 id="ema-greeting" style="margin-bottom:12px;font-weight:600;color:var(--fg);">Check-In</h2>
    <div class="ema-progress"><div class="ema-progress-fill" id="ema-progress-fill" style="width:0%"></div></div>
    <div class="ema-item-container" id="ema-single-container"></div>
    <div style="margin-top:40px;flex-shrink:0;"><button class="btn btn-primary btn-block" id="ema-next-btn" disabled>Next</button></div>
  </div>

  <div class="screen" id="screen-baseline">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
      <div style="margin-bottom:40px;"><h1>Calibration</h1><p class="label">Keep your finger completely still</p></div>
      <div class="progress-ring">
        <svg viewBox="0 0 180 180"><circle class="track" cx="90" cy="90" r="85"/><circle class="fill" id="baseline-progress-circle" cx="90" cy="90" r="85"/></svg>
        <div class="baseline-bpm-box"><div class="baseline-bpm-number" id="baseline-bpm">--</div><div class="baseline-bpm-label">BPM</div></div>
      </div>
    </div>
  </div>

  <div class="screen" id="screen-trial">
    <div class="movement-warning" id="trial-movement-warning">Keep still</div>
    <div class="trial-header" style="text-align:center;position:absolute;top:calc(env(safe-area-inset-top,24px) + 24px);width:100%;">
      <p class="label" id="trial-label" style="color:var(--fg-muted);">Trial 1</p>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;width:100%;">
      <p class="trial-instruction">Rotate the dial until the tone precisely aligns with your heartbeat.</p>
      <div class="rotary-dial-wrapper">
        <div class="rotary-dial-ticks" id="rotary-dial-ticks"></div>
        <div class="rotary-dial" id="rotary-dial"><div class="rotary-dial-indicator"></div></div>
      </div>
      <div class="dial-labels"><span>Earlier</span><span>Later</span></div>
    </div>
    <button class="btn btn-primary btn-block" id="confirm-trial-btn" disabled style="margin-top:40px;">Confirm Timing</button>
  </div>

  <div class="screen" id="screen-bodymap">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
      <h1>Sensation</h1>
      <p>Where did you primarily feel your heartbeat?</p>
      <button id="nowhere-btn" style="margin-bottom:16px;">Did not feel it</button>
      <div class="body-map-grid">
        <div class="body-part" data-value="1">Chest</div>
        <div class="body-part" data-value="2">Fingers</div>
        <div class="body-part" data-value="3">Neck</div>
        <div class="body-part" data-value="4">Ears</div>
        <div class="body-part" data-value="5">Abdomen</div>
        <div class="body-part" data-value="6">Legs</div>
        <div class="body-part" data-value="7">Head</div>
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="confirm-bodymap-btn" disabled style="margin-top:32px;">Confirm Location</button>
  </div>

  <div class="screen" id="screen-end">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:24px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <h1>Session Complete</h1>
      <p>Thank you for your participation.</p>
      <p id="end-beat-count" style="display:none;font-family:var(--font-mono);font-size:1rem;color:var(--accent);margin-top:0;"></p>
    </div>
    <button class="btn btn-secondary btn-block" id="download-btn">Save Local Copy</button>
  </div>

  ${studyTag}
</body>
</html>`;
}

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
  return buildHtmlShell({ cfg, themeCSS, includeEpatCore: !!cfg.modules?.epat, configTag, coreTag, studyTag, cssTag });
}

async function buildStaticBundle() {
  await loadTemplates();
  const cfg = buildConfig();
  const themeCSS = getThemeCSS(cfg.study.theme, cfg.study.accent_color);
  const runtimeCss = getRuntimeCss();
  const studyJs = stitchStudyJs(cfg, { configInline: false, previewMode: false });
  const configTag = '';
  const coreTag   = cfg.modules?.epat ? `<script src="js/epat-core.js"></script>` : '';
  const cssTag    = `<link rel="stylesheet" href="css/study.css">`;
  const studyTag  = `<script src="js/study.js"></script>`;
  const html = buildHtmlShell({ cfg, themeCSS, includeEpatCore: !!cfg.modules?.epat, configTag, coreTag, studyTag, cssTag });
  const files = [
    { path: 'index.html',    content: html },
    { path: 'config.json',   content: JSON.stringify(cfg, null, 2) },
    { path: 'css/study.css', content: runtimeCss },
    { path: 'js/study.js',   content: studyJs }
  ];
  if (cfg.modules?.epat) files.push({ path: 'js/epat-core.js', content: templates.epatCore });
  files.push({ path: 'README.txt', content: `${cfg.study.name} — deploy to any static host.\nParticipants open: index.html?id=<PID>&day=<N>&session=<windowId>\n` });
  return { files };
}

function makeZip(files) {
  const enc = new TextEncoder();
  const fr = [], cr = [];
  let off = 0;
  const ct = (() => { const t = new Uint32Array(256); for(let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[i]=c>>>0;} return t; })();
  const crc32 = b => { let c=0xffffffff; for(let i=0;i<b.length;i++)c=ct[(c^b[i])&0xff]^(c>>>8); return(c^0xffffffff)>>>0; };
  const w16=(dv,p,v)=>dv.setUint16(p,v,true), w32=(dv,p,v)=>dv.setUint32(p,v,true);
  files.forEach(f => {
    const nb=enc.encode(f.path), db=enc.encode(f.content), crc=crc32(db), sz=db.length;
    const lh=new ArrayBuffer(30), lv=new DataView(lh);
    w32(lv,0,0x04034b50);w16(lv,4,20);w16(lv,6,0);w16(lv,8,0);w16(lv,10,0);w16(lv,12,0);
    w32(lv,14,crc);w32(lv,18,sz);w32(lv,22,sz);w16(lv,26,nb.length);w16(lv,28,0);
    fr.push(new Uint8Array(lh),nb,db);
    const cd=new ArrayBuffer(46), cv=new DataView(cd);
    w32(cv,0,0x02014b50);w16(cv,4,20);w16(cv,6,20);w16(cv,8,0);w16(cv,10,0);w16(cv,12,0);w16(cv,14,0);
    w32(cv,16,crc);w32(cv,20,sz);w32(cv,24,sz);w16(cv,28,nb.length);w16(cv,30,0);w16(cv,32,0);
    w16(cv,34,0);w16(cv,36,0);w32(cv,38,0);w32(cv,42,off);
    cr.push(new Uint8Array(cd),nb);
    off+=30+nb.length+db.length;
  });
  let cds=0; cr.forEach(r=>cds+=r.length);
  const eo=new ArrayBuffer(22), ev=new DataView(eo);
  w32(ev,0,0x06054b50);w16(ev,4,0);w16(ev,6,0);w16(ev,8,files.length);w16(ev,10,files.length);
  w32(ev,12,cds);w32(ev,16,off);w16(ev,20,0);
  return new Blob([...fr,...cr,new Uint8Array(eo)],{type:'application/zip'});
}

function getRuntimeCss() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; width: 100%; font-family: var(--font); background: var(--bg); color: var(--fg); overflow: hidden; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
    .screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(env(safe-area-inset-top, 24px) + 24px) 24px calc(env(safe-area-inset-bottom, 24px) + 24px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease-in-out; overflow-y: auto; }
    .screen.active { opacity: 1; pointer-events: all; }
    h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; color: var(--fg); text-align: center; }
    h2 { font-size: 1.1rem; font-weight: 400; color: var(--fg-muted); margin-bottom: 32px; letter-spacing: -0.01em; text-align: center; }
    p { font-size: 1.05rem; line-height: 1.5; color: var(--fg-muted); margin-bottom: 24px; font-weight: 400; text-align: center; }
    .label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; text-align: center; }
    .institution-label { font-size: 0.75rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; text-align: center; opacity: 0.8; }
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 18px 28px; border-radius: var(--radius); border: none; cursor: pointer; font-family: var(--font); font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,0.15); }
    .btn-primary:active { background: var(--accent-hover); }
    .btn-primary:disabled { background: var(--bg-elevated); color: var(--fg-muted); box-shadow: none; }
    .btn-secondary { background: var(--bg-surface); color: var(--fg); border: 1px solid var(--border); }
    .btn-secondary:active { background: var(--bg-elevated); }
    .btn-block { width: 100%; margin-top: auto; flex-shrink: 0; }
    .input-group { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 8px; }
    .input-group input { width: 100%; padding: 18px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .input-group input:focus { border-color: var(--accent); background: var(--bg-elevated); }
    .ema-progress { height: 3px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; margin-bottom: 24px; flex-shrink: 0; }
    .ema-progress-fill { height: 100%; background: var(--accent); transition: width 0.3s ease-out; border-radius: 2px; }
    .ema-item-container { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; overflow-y: auto; padding: 8px 4px; }
    .ema-question { font-size: 1.15rem; font-weight: 500; color: var(--fg); margin-bottom: 24px; line-height: 1.4; text-align: left; }
    .slider-group { display: flex; flex-direction: column; gap: 12px; padding: 0 4px; }
    .slider-val-display { font-size: 2.2rem; font-weight: 600; color: var(--accent); text-align: center; font-variant-numeric: tabular-nums; }
    .range-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; background: var(--bg-elevated); border-radius: 3px; outline: none; }
    .range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 3px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .range-slider::-moz-range-thumb { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); cursor: pointer; border: 3px solid var(--bg); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .slider-labels { display: flex; justify-content: space-between; font-size: 0.82rem; color: var(--fg-muted); padding: 0 4px; }
    .choice-group { display: flex; flex-direction: column; gap: 10px; }
    .choice-btn { display: block; width: 100%; padding: 16px 20px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1rem; font-weight: 500; text-align: left; cursor: pointer; transition: all 0.15s; -webkit-tap-highlight-color: transparent; }
    .choice-btn:active { transform: scale(0.99); }
    .choice-btn.selected { border-color: var(--accent); background: var(--bg-elevated); color: var(--accent); font-weight: 600; }
    .choice-btn.selected::before { content: '✓'; display: inline-block; margin-right: 10px; color: var(--accent); font-weight: 700; }
    .text-group { width: 100%; }
    .text-input { width: 100%; padding: 14px 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .text-input:focus { border-color: var(--accent); background: var(--bg-elevated); }
    .ob-progress { height: 3px; background: var(--bg-surface); border-radius: 2px; overflow: hidden; margin-bottom: 20px; flex-shrink: 0; }
    .ob-progress-fill { height: 100%; background: var(--accent); transition: width 0.3s ease-out; }
    .consent-scroll-hint { font-size: 0.8rem; color: var(--accent); text-align: center; margin-bottom: 8px; transition: opacity 0.3s; }
    .consent-scroll { flex: 1; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; overflow-y: auto; margin-bottom: 16px; font-size: 0.95rem; line-height: 1.6; text-align: left; -webkit-user-select: text; user-select: text; min-height: 0; }
    .consent-scroll h3 { font-size: 1rem; font-weight: 600; margin: 16px 0 8px 0; color: var(--fg); text-align: left; }
    .consent-scroll h3:first-child { margin-top: 0; }
    .consent-scroll p { font-size: 0.95rem; color: var(--fg-muted); margin-bottom: 12px; text-align: left; }
    .checkbox-row { display: flex; align-items: flex-start; gap: 12px; padding: 14px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; margin-bottom: 12px; width: 100%; max-width: 340px; margin-left: auto; margin-right: auto; }
    .checkbox-row input[type="checkbox"] { width: 24px; height: 24px; flex-shrink: 0; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
    .checkbox-row span { font-size: 0.95rem; color: var(--fg-muted); line-height: 1.5; text-align: left; }
    .ob-input { width: 100%; max-width: 340px; margin: 0 auto 20px; display: block; }
    .ob-input input { width: 100%; padding: 16px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.05rem; outline: none; transition: border-color 0.2s; }
    .ob-input input:focus { border-color: var(--accent); background: var(--bg-elevated); }
    .ob-input input:disabled { opacity: 0.5; }
    .schedule-section { width: 100%; max-width: 340px; margin: 0 auto 28px; }
    .schedule-label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; }
    .day-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
    .day-btn { padding: 10px 0; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg-muted); font-size: 0.78rem; font-weight: 600; cursor: pointer; text-align: center; transition: all 0.15s; -webkit-tap-highlight-color: transparent; }
    .day-btn.selected { border-color: var(--accent); background: var(--bg-elevated); color: var(--accent); }
    .time-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .time-row-label { width: 76px; font-size: 0.82rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }
    .time-row input[type="time"] { flex: 1; padding: 12px 8px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font-mono); font-size: 0.9rem; outline: none; }
    .time-sep { color: var(--fg-muted); font-size: 0.85rem; flex-shrink: 0; }
    .check-list { width: 100%; max-width: 340px; margin: 0 auto 16px; }
    .check-item { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; transition: border-color 0.3s; }
    .check-item.pass { border-color: var(--accent-green); }
    .check-item.fail { border-color: var(--accent-red); }
    .check-item.testing { border-color: var(--accent); }
    .check-icon { width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--bg-elevated); font-size: 0.9rem; }
    .check-item.pass .check-icon { background: rgba(50,215,75,0.15); }
    .check-item.fail .check-icon { background: rgba(255,69,58,0.15); }
    .check-info { flex: 1; }
    .check-title { font-size: 0.95rem; font-weight: 600; color: var(--fg); }
    .check-status { font-size: 0.8rem; color: var(--fg-muted); margin-top: 2px; }
    .check-item.pass .check-status { color: var(--accent-green); }
    .check-item.fail .check-status { color: var(--accent-red); }
    .progress-ring { position: relative; width: 180px; height: 180px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
    .progress-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); z-index: 2; width: 100%; height: 100%; }
    .progress-ring circle { fill: none; stroke-width: 3; }
    .progress-ring circle.track { stroke: var(--bg-elevated); }
    .progress-ring circle.fill { stroke: var(--accent); stroke-dasharray: 534; stroke-dashoffset: 534; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
    .baseline-bpm-box { text-align: center; z-index: 3; }
    .baseline-bpm-number { font-size: 3.8rem; font-weight: 500; font-family: var(--font-mono); color: var(--fg); line-height: 1; letter-spacing: -0.04em; }
    .baseline-bpm-label { font-size: 0.8rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 4px; }
    #screen-trial { align-items: center; justify-content: center; }
    .trial-instruction { font-size: 1.1rem; color: var(--fg-muted); text-align: center; max-width: 300px; line-height: 1.4; margin-bottom: 40px; font-weight: 400; }
    .rotary-dial-wrapper { position: relative; width: 280px; height: 280px; margin: 0 auto 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; user-select: none; }
    .rotary-dial-ticks { position: absolute; inset: 0; pointer-events: none; border-radius: 50%; z-index: 1; }
    .dial-tick { position: absolute; width: 2px; height: 6px; background: var(--border); top: 8px; left: 50%; transform-origin: 50% 132px; margin-left: -1px; transition: background 0.2s; }
    .rotary-dial { width: 160px; height: 160px; border-radius: 50%; background: var(--bg-elevated); box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); border: 1px solid var(--border); position: relative; touch-action: none; cursor: grab; z-index: 2; display: flex; align-items: center; justify-content: center; }
    .rotary-dial:active { cursor: grabbing; filter: brightness(0.9); }
   .rotary-dial-indicator { position: absolute; top: 12px; left: 50%; width: 4px; height: 24px; background: var(--accent); border-radius: 2px; transform: translateX(-50%); box-shadow: 0 0 8px rgba(232, 113, 106, 0.6); }
    .dial-labels { display: flex; justify-content: space-between; width: 100%; max-width: 280px; margin: 0 auto; font-size: 0.85rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .movement-warning { position: fixed; top: calc(env(safe-area-inset-top, 24px) + 16px); left: 50%; transform: translateX(-50%) translateY(-20px); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg); padding: 10px 20px; border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); font-size: 0.9rem; font-weight: 500; z-index: 50; pointer-events: none; opacity: 0; transition: all 0.3s ease; }
    .movement-warning.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .sensor-warning-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
    .sensor-warning-overlay.visible { opacity: 1; pointer-events: all; }
    .sensor-preview-circle { width: 120px; height: 120px; border-radius: 50%; background: #000; border: 3px solid var(--fg); transition: border-color 0.3s ease, box-shadow 0.3s ease; margin-bottom: 24px; }
    .sensor-warning-text { text-align: center; font-size: 1.1rem; color: var(--fg); font-weight: 500; line-height: 1.4; }
    .body-map-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; max-width: 340px; margin: 0 auto; }
    .body-part { padding: 16px; border-radius: 12px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg); font-size: 1rem; cursor: pointer; text-align: center; font-weight: 500; transition: all 0.2s; -webkit-tap-highlight-color: transparent; }
    .body-part.selected { background: var(--accent); border-color: var(--accent); color: #fff; }
    #nowhere-btn { display: block; width: 100%; max-width: 340px; margin: 0 auto 16px; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg-muted); font-family: var(--font); font-size: 1rem; font-weight: 500; cursor: pointer; text-align: center; transition: all 0.2s; }
    #nowhere-btn.selected { border-color: var(--accent); color: var(--accent); }
    .training-timeline { width: 100%; max-width: 340px; height: 72px; margin: 0 auto 28px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; flex-shrink: 0; }
    #training-canvas { width: 100%; height: 100%; display: block; }
    .training-dial-wrapper { position: relative; width: 240px; height: 240px; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; border-radius: 50%; user-select: none; flex-shrink: 0; }
    .training-dial-ticks { position: absolute; inset: 0; pointer-events: none; border-radius: 50%; }
    .training-tick { position: absolute; width: 2px; height: 5px; background: var(--border); top: 7px; left: 50%; transform-origin: 50% 113px; margin-left: -1px; }
    .training-dial { width: 140px; height: 140px; border-radius: 50%; background: var(--bg-elevated); box-shadow: inset 0 2px 4px rgba(0,0,0,0.05); border: 1px solid var(--border); position: relative; touch-action: none; cursor: grab; z-index: 2; }
    .training-dial:active { cursor: grabbing; filter: brightness(0.9); }
    .training-dial-indicator { position: absolute; top: 10px; left: 50%; width: 4px; height: 22px; background: var(--accent); border-radius: 2px; transform: translateX(-50%); box-shadow: 0 0 8px rgba(232,113,106,0.6); }
    .training-dial-labels { display: flex; justify-content: space-between; width: 240px; margin: 0 auto 20px; font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.07em; flex-shrink: 0; }
    .training-status { text-align: center; font-size: 0.95rem; color: var(--fg-muted); min-height: 1.4em; transition: color 0.3s; flex-shrink: 0; margin-bottom: 8px; }
    .training-status.aligned { color: var(--accent-green); }
    .affect-grid-container { width: 100%; max-width: 360px; margin: 0 auto; }
  `;
}

function slugify(str) { return (str||'study').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
document.getElementById('export-btn').addEventListener('click', () => document.getElementById('export-modal').classList.add('open'));
document.getElementById('modal-close-btn').addEventListener('click', () => document.getElementById('export-modal').classList.remove('open'));
document.getElementById('export-single-file').addEventListener('click', async () => {
  document.getElementById('export-modal').classList.remove('open');
  const html = await buildStudyHtml({ configInline: true, previewMode: false });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = slugify(state.study.name) + '-study.html'; a.click();
});
const zipBtn = document.getElementById('export-zip');
if (zipBtn) { zipBtn.addEventListener('click', async () => {
  document.getElementById('export-modal').classList.remove('open');
  const { files } = await buildStaticBundle(); const blob = makeZip(files);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = slugify(state.study.name) + '-static.zip'; a.click();
}); }