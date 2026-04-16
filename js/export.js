let templates = { epatCore: null, studyBase: null, modOnboarding: null, modEma: null, modEpat: null };

async function loadTemplates() {
  if (!templates.epatCore) templates.epatCore = await fetch('templates/epat-core.js').then(r => r.text());
  if (!templates.studyBase) templates.studyBase = await fetch('templates/study-base.js').then(r => r.text());
  if (!templates.modOnboarding) templates.modOnboarding = await fetch('templates/module-onboarding.js').then(r => r.text());
  if (!templates.modEma) templates.modEma = await fetch('templates/module-ema.js').then(r => r.text());
  if (!templates.modEpat) templates.modEpat = await fetch('templates/module-epat.js').then(r => r.text());
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

async function buildStudyHtml({ configInline, previewMode = false, previewSession: _ps }) {
  await loadTemplates();
  const cfg = buildConfig();
  const themeCSS = getThemeCSS(cfg.study.theme, cfg.study.accent_color);

  const configBlock = configInline ? `<script>window.__CONFIG__ = ${JSON.stringify(cfg)};<\/script>` : '';
  const configLoader = configInline 
    ? `async function loadConfig() { return Promise.resolve(window.__CONFIG__); }` 
    : `async function loadConfig() { const r = await fetch('config.json'); if (!r.ok) throw new Error('Could not load config.json'); return r.json(); }`;
  
  const patCoreBlock = cfg.tasks.includes('pat') ? `<script>\n${templates.epatCore}\n<\/script>` : '';

  // Setup mode flags for study-base.js
  const previewFlag = `window.__PREVIEW_MODE__ = ${previewMode};`;
  
  const expiryCheck = previewMode ? '' : `
    const tParam = params.get('t');
    const expiryMs = (config.ema.scheduling.timing?.expiry_minutes || 60) * 60 * 1000;
    if (tParam && (Date.now() - parseInt(tParam)) > expiryMs) {
      document.getElementById('task-subtitle').textContent = 'Link Expired';
      document.getElementById('start-btn').disabled = true;
      document.getElementById('start-btn').textContent = 'Session no longer active';
      return;
    }`;

  const previewSessionForce = previewMode 
    ? `const sessionId = "${_ps || 'afternoon'}";` 
    : `const sessionId = params.get('session') || 'afternoon';`;

  let studyJs = templates.studyBase;
  studyJs = studyJs.replace('// {{CONFIG_LOADER}}', () => configLoader + '\n' + previewFlag);
  studyJs = studyJs.replace('// {{EXPIRY_CHECK}}', () => expiryCheck);
  studyJs = studyJs.replace('// {{PREVIEW_SESSION_FORCE}}', () => previewSessionForce);

  // Stitch the modules into the router template
  let injectedModules = templates.modOnboarding + '\n\n' + templates.modEma + '\n\n' + templates.modEpat;
  studyJs = studyJs.replace('// {{MODULES_INJECT}}', () => injectedModules);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <title>${escH(cfg.study.name)}</title>
  ${configBlock}
  ${patCoreBlock}
  <style>
    :root { ${themeCSS} }

    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; width: 100%; font-family: var(--font); background: var(--bg); color: var(--fg); overflow: hidden; touch-action: manipulation; user-select: none; -webkit-user-select: none; }

    /* Screen Transitions */
    .screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(env(safe-area-inset-top, 24px) + 24px) 24px calc(env(safe-area-inset-bottom, 24px) + 24px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease-in-out; overflow-y: auto; }
    .screen.active { opacity: 1; pointer-events: all; }

    /* Typography */
    h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; color: var(--fg); text-align: center; }
    h2 { font-size: 1.1rem; font-weight: 400; color: var(--fg-muted); margin-bottom: 32px; letter-spacing: -0.01em; text-align: center; }
    p { font-size: 1.05rem; line-height: 1.5; color: var(--fg-muted); margin-bottom: 24px; font-weight: 400; text-align: center; }
    .label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; text-align: center;}

    /* Inputs */
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 18px 28px; border-radius: var(--radius); border: none; cursor: pointer; font-family: var(--font); font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
    .btn:active { transform: scale(0.97); }
    .btn-primary { background: var(--accent); color: #fff; box-shadow: 0 4px 14px var(--accent-dim); }
    .btn-primary:active { background: var(--accent-hover); box-shadow: 0 2px 8px var(--accent-dim); }
    .btn-primary:disabled { opacity: 0.3; pointer-events: none; box-shadow: none; background: #333; color: #888; }
    .btn-secondary { background: var(--bg-surface); color: var(--fg); border: 1px solid var(--border); }
    .btn-secondary:active { background: var(--bg-elevated); }
    .btn-block { width: 100%; max-width: 340px; margin-left: auto; margin-right: auto; }
    .input-group { width: 100%; max-width: 340px; margin: 0 auto 32px; text-align: left; }
    .input-group input { width: 100%; padding: 18px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .input-group input:focus { border-color: var(--accent); background: var(--bg-elevated); }

    /* EMA Layout */
    #screen-ema { justify-content: space-between; }
    .ema-progress { width: 100%; max-width: 340px; margin: 0 auto 28px; height: 3px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
    .ema-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
    .ema-item-container { flex: 1; display: flex; flex-direction: column; justify-content: center; opacity: 1; transition: opacity 0.3s ease, transform 0.3s ease; }
    .ema-item-container.fade-out { opacity: 0; transform: translateY(-10px); }
    .ema-item-container.fade-in { opacity: 0; transform: translateY(10px); }
    .ema-question { font-size: 1.9rem; font-weight: 400; color: var(--fg); line-height: 1.25; text-align: center; margin-bottom: 48px; letter-spacing: -0.03em; }

    /* Interactive Components */
    .slider-group { width: 100%; max-width: 340px; margin: 0 auto; }
    .slider-val-display { font-family: var(--font-mono); font-size: 1.6rem; font-weight: 400; color: var(--accent); text-align: center; margin-bottom: 20px; min-height:30px; }
    .range-slider { -webkit-appearance: none; width: 100%; height: 8px; border-radius: 4px; outline: none; background: var(--bg-elevated); position: relative; margin-bottom: 20px; }
    .range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 36px; height: 36px; border-radius: 50%; background: var(--fg); cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
    .slider-labels { display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 500; color: var(--fg-muted); }
    .bubble-group { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 340px; margin: 0 auto; }
    .bubble { padding: 18px 20px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--fg); font-size: 1.05rem; font-weight: 500; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); text-align: center; }
    .bubble:active { transform: scale(0.98); }
    .bubble.selected { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 4px 14px var(--accent-dim); }

    /* Onboarding Overrides */
    .ob-progress { width: 100%; max-width: 340px; margin: 0 auto 32px; height: 3px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
    .ob-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.4s cubic-bezier(0.4,0,0.2,1); }
    .consent-scroll { flex: 1; overflow-y: auto; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 20px; min-height: 0; -webkit-user-select: text; user-select: text; font-size: 0.95rem; line-height: 1.7; color: var(--fg-muted); }
    .consent-scroll h3 { color: var(--fg); font-size: 1rem; font-weight: 600; margin: 16px 0 6px; text-align: left; }
    .consent-scroll h3:first-child { margin-top: 0; }
    .consent-scroll p { font-size: 0.95rem; margin-bottom: 10px; text-align: left; color: var(--fg-muted); }
    .consent-scroll-hint { font-size: 0.8rem; color: var(--fg-muted); text-align: center; margin-bottom: 12px; flex-shrink: 0; transition: opacity 0.3s; }
    .checkbox-row { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; cursor: pointer; flex-shrink: 0; max-width: 340px; margin-left: auto; margin-right: auto; }
    .checkbox-row input[type="checkbox"] { width: 24px; height: 24px; flex-shrink: 0; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
    .checkbox-row span { font-size: 0.95rem; color: var(--fg-muted); line-height: 1.5; text-align: left; }
    .ob-input { width: 100%; max-width: 340px; margin: 0 auto 20px; display: block; }
    .ob-input input { width: 100%; padding: 16px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.05rem; outline: none; transition: border-color 0.2s, background 0.2s; }
    .ob-input input:focus { border-color: var(--accent); background: var(--bg-elevated); }
    .schedule-section { width: 100%; max-width: 340px; margin: 0 auto 28px; }
    .schedule-label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; }
    .day-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
    .day-btn { padding: 10px 0; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg-muted); font-size: 0.78rem; font-weight: 600; cursor: pointer; text-align: center; transition: all 0.15s; }
    .day-btn.selected { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
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
    .training-timeline { width: 100%; max-width: 340px; height: 72px; margin: 0 auto 28px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; flex-shrink: 0; }
    #training-canvas { width: 100%; height: 100%; display: block; }
    .training-dial-wrapper { position: relative; width: 240px; height: 240px; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; border-radius: 50%; user-select: none; flex-shrink: 0; }
    .training-dial-ticks { position: absolute; inset: 0; pointer-events: none; border-radius: 50%; }
    .training-tick { position: absolute; width: 2px; height: 5px; background: var(--border); top: 7px; left: 50%; transform-origin: 50% 113px; margin-left: -1px; }
    .training-dial { width: 140px; height: 140px; border-radius: 50%; background: linear-gradient(145deg, #1f1f23, #121214); box-shadow: 8px 8px 16px rgba(0,0,0,0.8), -4px -4px 12px rgba(255,255,255,0.03), inset 0 2px 4px rgba(255,255,255,0.05); border: 1px solid var(--border); position: relative; touch-action: none; cursor: grab; z-index: 2; }
    .training-dial:active { cursor: grabbing; }
    .training-dial-indicator { position: absolute; top: 10px; left: 50%; width: 4px; height: 22px; background: var(--accent); border-radius: 2px; transform: translateX(-50%); box-shadow: 0 0 8px var(--accent-dim); }
    .training-dial-labels { display: flex; justify-content: space-between; width: 240px; margin: 0 auto 20px; font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.07em; flex-shrink: 0; }
    .training-status { text-align: center; font-size: 0.95rem; color: var(--fg-muted); min-height: 1.4em; transition: color 0.3s; flex-shrink: 0; margin-bottom: 8px; }
    .training-status.aligned { color: var(--accent-green); }

    /* PAT Specific Layouts */
    #screen-baseline, #screen-trial { align-items: center; justify-content: center; }
    .progress-ring { width: 180px; height: 180px; position: relative; display: flex; align-items: center; justify-content: center; margin: 0 auto; }
    .progress-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); z-index: 2; width: 100%; height: 100%; }
    .progress-ring circle { fill: none; stroke-width: 3; }
    .progress-ring .track { stroke: var(--bg-elevated); }
    .progress-ring .fill { stroke: var(--accent); stroke-dasharray: 534; stroke-dashoffset: 534; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
    .baseline-bpm-box { text-align: center; z-index: 3; }
    .baseline-bpm-number { font-size: 3.8rem; font-weight: 500; font-family: var(--font-mono); color: var(--fg); line-height: 1; letter-spacing: -0.04em; }
    .baseline-bpm-label { font-size: 0.8rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.1em; margin-top: 4px; }
    
    .rotary-dial-wrapper { position: relative; width: 280px; height: 280px; margin: 0 auto 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; user-select: none; }
    .rotary-dial-ticks { position: absolute; inset: 0; pointer-events: none; border-radius: 50%; z-index: 1; }
    .dial-tick { position: absolute; width: 2px; height: 6px; background: var(--border); top: 8px; left: 50%; transform-origin: 50% 132px; margin-left: -1px; }
    .rotary-dial { width: 160px; height: 160px; border-radius: 50%; background: linear-gradient(145deg, #1f1f23, #121214); box-shadow: 8px 8px 16px rgba(0,0,0,0.8), -4px -4px 12px rgba(255,255,255,0.03), inset 0 2px 4px rgba(255,255,255,0.05); border: 1px solid var(--border); position: relative; touch-action: none; cursor: grab; z-index: 2; display: flex; align-items: center; justify-content: center; }
    .rotary-dial:active { cursor: grabbing; background: linear-gradient(145deg, #1a1a1d, #0f0f11); }
    .rotary-dial-indicator { position: absolute; top: 12px; left: 50%; width: 4px; height: 24px; background: var(--accent); border-radius: 2px; transform: translateX(-50%); box-shadow: 0 0 8px var(--accent-dim); }
    .dial-labels { display: flex; justify-content: space-between; width: 100%; max-width: 280px; margin: 0 auto; font-size: 0.85rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; }
    
    .sensor-warning-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
    .sensor-warning-overlay.visible { opacity: 1; pointer-events: all; }
    .sensor-preview-circle { width: 120px; height: 120px; border-radius: 50%; background: #000; border: 3px solid var(--fg); object-fit: cover; transition: border-color 0.3s ease; margin-bottom: 24px; }
    .movement-warning { position: fixed; top: 40px; left: 50%; transform: translateX(-50%) translateY(-20px); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg); padding: 10px 20px; border-radius: 20px; font-size: 0.9rem; font-weight: 500; z-index: 50; opacity: 0; transition: all 0.3s ease; }
    .movement-warning.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* Body Map */
    .body-map-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; max-width: 340px; margin: 0 auto; }
    .body-part { padding: 16px; border-radius: 12px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--fg); font-size: 1rem; cursor: pointer; text-align: center; font-weight: 500; transition: all 0.2s; }
    .body-part.selected { background: var(--accent); border-color: var(--accent); color: #fff; }
  </style>
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
      <span>I have read and understood the above. I voluntarily agree to participate.</span>
    </label>
    <div class="ob-input">
      <input type="text" id="ob-initials" placeholder="Your initials" maxlength="5" autocomplete="off" style="text-transform:uppercase;" disabled>
    </div>
    <button class="btn btn-primary btn-block" id="ob-consent-next" disabled>I Consent — Continue</button>
  </div>

  <div class="screen" id="screen-ob-schedule">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:40%"></div></div>
    <h1>Scheduling</h1>
    <p style="margin-bottom:24px;">Choose your available days and preferred check-in windows.</p>
    <div class="schedule-section">
      <span class="schedule-label">Available days</span>
      <div class="day-grid" id="ob-day-grid">
        <div class="day-btn selected" data-day="Mon">Mon</div><div class="day-btn selected" data-day="Tue">Tue</div>
        <div class="day-btn selected" data-day="Wed">Wed</div><div class="day-btn selected" data-day="Thu">Thu</div>
        <div class="day-btn selected" data-day="Fri">Fri</div><div class="day-btn selected" data-day="Sat">Sat</div>
        <div class="day-btn selected" data-day="Sun">Sun</div>
      </div>
    </div>
    <div class="schedule-section">
      <span class="schedule-label">Check-in time windows</span>
      <div class="time-row"><span class="time-row-label">Morning</span><input type="time" id="ob-am-start" value="08:00"><span class="time-sep">–</span><input type="time" id="ob-am-end" value="10:00"></div>
      <div class="time-row"><span class="time-row-label">Afternoon</span><input type="time" id="ob-pm-start" value="13:00"><span class="time-sep">–</span><input type="time" id="ob-pm-end" value="15:00"></div>
      <div class="time-row"><span class="time-row-label">Evening</span><input type="time" id="ob-ev-start" value="19:00"><span class="time-sep">–</span><input type="time" id="ob-ev-end" value="21:00"></div>
    </div>
    <div style="flex:1; min-height:16px;"></div>
    <button class="btn btn-primary btn-block" id="ob-schedule-next">Continue</button>
  </div>

  <div class="screen" id="screen-ob-device">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:60%"></div></div>
    <h1>Device Check</h1>
    <p style="margin-bottom:24px;">We'll confirm your device supports the task.</p>
    <div class="check-list">
      <div class="check-item" id="ob-check-camera"><div class="check-icon">📷</div><div class="check-info"><div class="check-title">Camera</div><div class="check-status" id="ob-check-camera-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-torch"><div class="check-icon">🔦</div><div class="check-info"><div class="check-title">Flashlight</div><div class="check-status" id="ob-check-torch-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-audio"><div class="check-icon">🔊</div><div class="check-info"><div class="check-title">Audio</div><div class="check-status" id="ob-check-audio-status">Waiting…</div></div></div>
      <div class="check-item" id="ob-check-signal"><div class="check-icon">♥</div><div class="check-info"><div class="check-title">PPG Signal</div><div class="check-status" id="ob-check-signal-status">Waiting…</div></div></div>
      <div id="ob-signal-preview-wrap" style="display:none; justify-content:center; margin: 4px 0 8px;"><canvas id="ob-signal-preview" style="width:80px; height:80px; border-radius:50%; border:2px solid var(--border); background:#000; display:block;"></canvas></div>
    </div>
    <p id="ob-device-status" style="text-align:center; font-size:0.9rem; min-height:1.4em; color:var(--fg-muted);"></p>
    <div style="flex:1; min-height:16px;"></div>
    <button class="btn btn-primary btn-block" id="ob-device-start">Run Checks</button>
    <button class="btn btn-primary btn-block" id="ob-device-next" style="display:none; margin-top:12px;">Continue</button>
    <button class="btn btn-secondary btn-block" id="ob-device-retry" style="display:none; margin-top:8px;">Retry</button>
  </div>

  <div class="screen" id="screen-ob-training">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:80%"></div></div>
    <h1>Learn the Task</h1>
    <p style="margin-bottom:16px;">A simulated heartbeat plays below. Rotate the dial to align the tone with each beat.</p>
    <div class="training-timeline"><canvas id="training-canvas"></canvas></div>
    <div class="training-dial-wrapper"><div class="training-dial-ticks" id="training-dial-ticks"></div><div class="training-dial" id="training-dial"><div class="training-dial-indicator"></div></div></div>
    <div class="training-dial-labels"><span>Earlier</span><span>Later</span></div>
    <p class="training-status" id="training-status">Rotate the dial to align the tone</p>
    <div style="flex:1; min-height:8px;"></div>
    <button class="btn btn-primary btn-block" id="ob-training-next" disabled>Continue</button>
  </div>

  <div class="screen" id="screen-ob-complete">
    <div class="ob-progress"><div class="ob-progress-fill" style="width:100%"></div></div>
    <div style="flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center;">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:24px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <h1>You're All Set</h1>
      <p>Setup is complete. Your check-in schedule has been saved.</p>
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
    <div style="text-align: center; position: absolute; top: calc(env(safe-area-inset-top, 24px) + 24px); width: 100%;"><p class="label" id="trial-label" style="color: var(--fg-muted);">Trial 1</p></div>
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; width: 100%;">
      <p style="margin-bottom: 40px;">Rotate the dial until the tone precisely aligns with your heartbeat.</p>
      <div class="rotary-dial-wrapper">
        <div class="rotary-dial-ticks" id="rotary-dial-ticks"></div>
        <div class="rotary-dial" id="rotary-dial"><div class="rotary-dial-indicator"></div></div>
      </div>
      <div class="dial-labels"><span>Earlier</span><span>Later</span></div>
    </div>
    <button class="btn btn-primary btn-block" id="confirm-trial-btn" disabled style="margin-top: 40px;">Confirm Timing</button>
  </div>

  <div class="screen" id="screen-bodymap">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
      <h1>Sensation</h1>
      <p>Where did you primarily feel your heartbeat?</p>
      <button class="btn btn-secondary btn-block" id="nowhere-btn" style="margin-bottom: 16px; border-radius: 12px; font-weight: 500;">Did not feel it</button>
      <div class="body-map-grid">
        <div class="body-part" data-value="1">Chest</div><div class="body-part" data-value="2">Fingers</div>
        <div class="body-part" data-value="3">Neck</div><div class="body-part" data-value="4">Ears</div>
        <div class="body-part" data-value="5">Abdomen</div><div class="body-part" data-value="6">Legs</div>
        <div class="body-part" data-value="7" style="grid-column: span 2;">Head</div>
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="confirm-bodymap-btn" disabled style="margin-top: 32px;">Confirm Location</button>
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

<script>
${studyJs}
<\/script>
</body>
</html>`;
}

document.getElementById('export-btn').addEventListener('click', () => document.getElementById('export-modal').classList.add('open'));
document.getElementById('modal-close-btn').addEventListener('click', () => document.getElementById('export-modal').classList.remove('open'));

function slugify(str) { return (str||'study').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }

document.getElementById('export-single-file').addEventListener('click', async () => {
  document.getElementById('export-modal').classList.remove('open');
  const html = await buildStudyHtml({ configInline: true, previewMode: false });
  const a = document.createElement('a'); 
  a.href = URL.createObjectURL(new Blob([html], {type:'text/html'})); 
  a.download = slugify(state.study.name) + '-study.html'; 
  a.click();
});