let templates = { epatCore: null, studyBase: null };

async function loadTemplates() {
  if (!templates.epatCore) templates.epatCore = await fetch('templates/epat-core.js').then(r => r.text());
  if (!templates.studyBase) templates.studyBase = await fetch('templates/study-base.js').then(r => r.text());
}

async function buildStudyHtml({ configInline, previewMode = false, previewSession: _ps }) {
  await loadTemplates();
  const cfg = buildConfig();
  const accent = cfg.study.accent_color;

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

  // Return the compiled HTML based on the OLED aesthetic
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
/* --- Monochromatic OLED Design (EMA Studio Gen v1.1) --- */
:root {
  --bg: #000000; --bg-surface: #111111; --bg-elevated: #1c1c1e; --border: #2c2c2e;
  --fg: #ffffff; --fg-muted: #8e8e93;
  --accent: ${accent}; 
  --accent-red: #ff453a; --accent-green: #32d74b;
  --radius: 14px; 
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html, body { height: 100%; width: 100%; font-family: var(--font); background: var(--bg); color: var(--fg); overflow: hidden; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding: calc(env(safe-area-inset-top, 24px) + 24px) 24px calc(env(safe-area-inset-bottom, 24px) + 24px); opacity: 0; pointer-events: none; transition: opacity 0.3s ease-in-out; overflow-y: auto; }
.screen.active { opacity: 1; pointer-events: all; }
h1 { font-size: 1.75rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; color: var(--fg); text-align: center; }
h2 { font-size: 1.1rem; font-weight: 400; color: var(--fg-muted); margin-bottom: 32px; letter-spacing: -0.01em; text-align: center; }
p { font-size: 1.05rem; line-height: 1.5; color: var(--fg-muted); margin-bottom: 24px; font-weight: 400; text-align: center; }
.label { font-size: 0.8rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; display: block; text-align: center;}
.btn { display: inline-flex; align-items: center; justify-content: center; padding: 18px 28px; border-radius: var(--radius); border: none; cursor: pointer; font-family: var(--font); font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.btn:active { transform: scale(0.97); }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:disabled { opacity: 0.3; pointer-events: none; background: #333; color: #888; }
.btn-secondary { background: var(--bg-surface); color: var(--fg); border: 1px solid var(--border); }
.btn-block { width: 100%; max-width: 340px; margin-left: auto; margin-right: auto; }
.input-group { width: 100%; max-width: 340px; margin: 0 auto 32px; text-align: left; }
.input-group input { width: 100%; padding: 18px; text-align: center; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-family: var(--font); font-size: 1.1rem; outline: none; transition: border-color 0.2s, background 0.2s; }
.input-group input:focus { border-color: var(--accent); background: var(--bg-elevated); }

/* EMA One-Thing Layout */
#screen-ema { justify-content: space-between; }
.ema-progress { width: 100%; max-width: 340px; margin: 0 auto 28px; height: 3px; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
.ema-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
.ema-item-container { flex: 1; display: flex; flex-direction: column; justify-content: center; opacity: 1; transition: opacity 0.3s ease, transform 0.3s ease; }
.ema-item-container.fade-out { opacity: 0; transform: translateY(-10px); }
.ema-item-container.fade-in { opacity: 0; transform: translateY(10px); }
.ema-question { font-size: 1.7rem; font-weight: 400; color: var(--fg); line-height: 1.25; text-align: center; margin-bottom: 40px; letter-spacing: -0.03em; }

/* Question Components */
.slider-group { width: 100%; max-width: 340px; margin: 0 auto; }
.slider-val-display { font-family: var(--font-mono); font-size: 1.6rem; font-weight: 400; color: var(--accent); text-align: center; margin-bottom: 20px; min-height: 30px; }
.range-slider { -webkit-appearance: none; width: 100%; height: 8px; border-radius: 4px; outline: none; background: var(--bg-elevated); position: relative; margin-bottom: 20px; }
.range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 36px; height: 36px; border-radius: 50%; background: var(--fg); cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
.slider-labels { display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 500; color: var(--fg-muted); }
.bubble-group { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 340px; margin: 0 auto; }
.bubble { padding: 18px 20px; border-radius: 14px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--fg); font-size: 1.05rem; font-weight: 500; cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); text-align: center; }
.bubble:active { transform: scale(0.98); }
.bubble.selected { background: var(--accent); border-color: var(--accent); color: #fff; }

/* PAT Elements */
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
.rotary-dial-indicator { position: absolute; top: 12px; left: 50%; width: 4px; height: 24px; background: var(--accent); border-radius: 2px; transform: translateX(-50%); box-shadow: 0 0 8px var(--accent); }
.dial-labels { display: flex; justify-content: space-between; width: 100%; max-width: 280px; margin: 0 auto; font-size: 0.85rem; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.08em; }
.sensor-warning-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
.sensor-warning-overlay.visible { opacity: 1; pointer-events: all; }
.sensor-preview-circle { width: 120px; height: 120px; border-radius: 50%; background: #000; border: 3px solid var(--fg); object-fit: cover; transition: border-color 0.3s ease; margin-bottom: 24px; }
.movement-warning { position: fixed; top: 40px; left: 50%; transform: translateX(-50%) translateY(-20px); background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg); padding: 10px 20px; border-radius: 20px; font-size: 0.9rem; font-weight: 500; z-index: 50; opacity: 0; transition: all 0.3s ease; }
.movement-warning.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>

  <!-- Background Camera for PAT -->
  <video id="video-feed" playsinline muted style="position:fixed;top:-9999px;opacity:0;"></video>
  <canvas id="sampling-canvas" style="position:fixed;top:-9999px;opacity:0;"></canvas>

  <div class="sensor-warning-overlay" id="sensor-warning-overlay">
    <canvas id="sensor-preview-circle" class="sensor-preview-circle"></canvas>
    <div class="sensor-warning-text" id="sensor-warning-text" style="text-align:center;font-size:1.1rem;font-weight:500;">Place finger on camera</div>
  </div>

  <div class="screen active" id="screen-pid">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <h1 id="study-title">Loading…</h1>
      <h2 id="task-subtitle"></h2>
      <div class="input-group" style="margin-top: 24px;">
        <label class="label">Participant ID</label>
        <input type="text" id="pid-input" autocomplete="off" placeholder="Enter ID">
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="start-btn" disabled>Begin Session</button>
  </div>

  <div class="screen" id="screen-ema">
    <h2 id="ema-greeting" style="margin-bottom: 12px; font-weight: 600; color: var(--fg);">Check-In</h2>
    <div class="ema-progress"><div class="ema-progress-fill" id="ema-progress-fill" style="width:0%"></div></div>
    <div class="ema-item-container" id="ema-single-container"></div>
    <div style="margin-top: 40px; flex-shrink: 0;">
      <button class="btn btn-primary btn-block" id="ema-next-btn" disabled>Next</button>
    </div>
  </div>

  ${cfg.tasks.includes('pat') ? `
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
    <div style="text-align: center; position: absolute; top: 48px; width: 100%;"><p class="label" id="trial-label" style="color: var(--fg-muted);">Trial 1</p></div>
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
  ` : ''}

  <div class="screen" id="screen-end">
    <div style="flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <div style="font-size: 64px; color: var(--accent); margin-bottom: 24px;">✓</div>
      <h1>Session Complete</h1>
      <p>Your data has been successfully saved.</p>
    </div>
  </div>

<script>
${studyJs}
<\/script>
</body>
</html>`;
}

// Ensure the Export button functionality remains identical.
document.getElementById('export-btn').addEventListener('click', () => document.getElementById('export-modal').classList.add('open'));
document.getElementById('modal-close-btn').addEventListener('click', () => document.getElementById('export-modal').classList.remove('open'));

// Helper for file naming
function slugify(str) { return (str||'study').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }

document.getElementById('export-single-file').addEventListener('click', async () => {
  document.getElementById('export-modal').classList.remove('open');
  const html = await buildStudyHtml({ configInline: true, previewMode: false });
  const a = document.createElement('a'); 
  a.href = URL.createObjectURL(new Blob([html], {type:'text/html'})); 
  a.download = slugify(state.study.name) + '-study.html'; 
  a.click();
});