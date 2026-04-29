"use strict";

// =============================================================================
// EMA Forge — pat-view.js
// ePAT / Interoception Analytics Tab
//
// Renders the "PAT" dashboard tab. Consumes DataParser.state.filteredSessions
// and extracts all epat_response entries. Works in both Aggregate and
// Per-Participant modes (mirrors the existing seg-ctrl paradigm).
//
// Circular statistics notes:
//   Phase offset (phase_ms) is a circular variable — it wraps at the RR
//   interval boundary. We normalise to [0, 2π] using the per-trial RR period
//   (derived from the running HR in instantBpms where available, falling back
//   to the session-level bpm from any heart_rate question in the same session,
//   then to the study-wide median). Treating it as linear would alias near-
//   boundary hits and make the mean vector meaningless.
//
//   Mean vector angle:  θ̄ = atan2(Σ sin θᵢ, Σ cos θᵢ)
//   Resultant length:   R = √((Σ cos θᵢ)² + (Σ sin θᵢ)²) / N   ∈ [0,1]
//   Circular SD:        σ = √(−2 ln R)  (in radians, convert to ms via RR)
//
//   R ≈ 1  → tight clustering around mean phase (consistent interoceptive signal)
//   R ≈ 0  → uniform distribution (at-chance performance)
//   Rayleigh test p-value is included but not rendered directly — it lives in
//   the tooltip data for researchers who want it.
//
// Data shape expected (from epat_response entries):
//   {
//     type: "epat_response",
//     trials: [ { trial, phase_ms, confidence, sqi, bodyPos? }, ... ],
//     summary: { valid_trials, mean_abs_phase_ms, ... }
//   }
//
// Standalone PAT JSON: a file whose top-level data[] contains only
// epat_response entries (no ema_response). The tab handles this; other tabs
// show "no data" naturally because they only look at ema_response entries.
// =============================================================================

const PATView = (() => {

  // ── Chart instances ────────────────────────────────────────────────────────
  const _charts = {};
  let _tooltipEl = null;

  // ── Body position label map (from module-epat.js bodyPos encoding) ─────────
  const BODY_LABELS = {
    0: 'Chest', 1: 'Throat', 2: 'Abdomen', 3: 'Head',
    4: 'Arms', 5: 'Legs', 6: 'Hands', '-1': 'Not recorded'
  };

  // ── Colour helpers using CSS vars ─────────────────────────────────────────
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Interpolate accent → green based on R value (0 = danger, 1 = good)
  function rColour(R) {
    if (R >= 0.6) return cssVar('--green') || '#3fb950';
    if (R >= 0.35) return cssVar('--yellow') || '#d29922';
    return cssVar('--accent') || '#e8716a';
  }

  // ── Circular statistics ────────────────────────────────────────────────────
  function toAngle(phase_ms, rr_ms) {
    // Normalise phase_ms to [0, 2π]. phase_ms can be negative (early) so mod first.
    const rr = rr_ms > 0 ? rr_ms : 800; // fallback 75 BPM
    const wrapped = ((phase_ms % rr) + rr) % rr;
    return (wrapped / rr) * 2 * Math.PI;
  }

  function circularStats(angles) {
    // angles: array of radians
    if (!angles.length) return { mean: 0, R: 0, sd_rad: 0, p_rayleigh: 1 };
    const N = angles.length;
    let sc = 0, ss = 0;
    for (const a of angles) { sc += Math.cos(a); ss += Math.sin(a); }
    const meanAngle = Math.atan2(ss / N, sc / N);
    const R = Math.sqrt((sc / N) ** 2 + (ss / N) ** 2);
    const sd_rad = R > 0 ? Math.sqrt(-2 * Math.log(R)) : Math.PI;
    // Rayleigh test: z = N * R², approximate p-value
    const z = N * R * R;
    const p_rayleigh = Math.exp(-z) * (1 + (2 * z - z * z) / (4 * N) - (24 * z - 132 * z ** 2 + 76 * z ** 3 - 9 * z ** 4) / (288 * N * N));
    return { mean: meanAngle, R, sd_rad, p_rayleigh: Math.max(0, Math.min(1, p_rayleigh)) };
  }

  function angleToDeg(rad) {
    return ((rad * 180 / Math.PI) + 360) % 360;
  }

  function angleToMs(rad, rr_ms) {
    return (rad / (2 * Math.PI)) * rr_ms;
  }

  // ── Data extraction ────────────────────────────────────────────────────────
  // Returns array of enriched trial objects across all relevant sessions.
  // Each entry: { participantId, day, sessionId, sessionDate, trialIndex,
  //               phase_ms, angle_rad, rr_ms, confidence, sqi, bodyPos, valid }
  function extractTrials(sessions) {
    const trials = [];

    for (const session of sessions) {
      const pid = session.participantId || 'Unknown';
      const day = session.day || 1;
      const sid = session.sessionId || '';
      const sessionDate = session.startedAt ? session.startedAt.slice(0, 10) : '';

      // Try to find a BPM from the session's heart_rate question responses
      let sessionBpm = null;
      for (const entry of (session.data || [])) {
        if (entry.type === 'ema_response') {
          for (const [, rec] of Object.entries(entry.responses || {})) {
            const v = rec && typeof rec === 'object' && 'value' in rec ? rec.value : rec;
            if (v && typeof v === 'object' && typeof v.bpm === 'number' && v.bpm > 30) {
              sessionBpm = v.bpm;
            }
          }
        }
      }

      for (const entry of (session.data || [])) {
        if (entry.type !== 'epat_response') continue;

        const trialArr = entry.trials || [];
        for (let i = 0; i < trialArr.length; i++) {
          const t = trialArr[i];
          if (t.isPractice) continue; // skip practice trials stored in some versions

          // Derive RR interval: prefer rr_ms stamped by the envelope (Option B),
          // fall back to per-trial recordedHR, then session BPM, then 800ms.
          let rr_ms = typeof t.rr_ms === 'number' && t.rr_ms > 0 ? t.rr_ms : 0;
          if (!rr_ms) {
            if (Array.isArray(t.recordedHR) && t.recordedHR.length > 0) {
              const medHR = median(t.recordedHR.filter(v => v > 30 && v < 220));
              if (medHR) rr_ms = 60000 / medHR;
            }
            if (!rr_ms && sessionBpm) rr_ms = 60000 / sessionBpm;
            if (!rr_ms) rr_ms = 800;
          }

          const phase_ms = typeof t.phase_ms === 'number' ? t.phase_ms :
                           (typeof t.visualOffset === 'number' ? t.visualOffset : null);
          if (phase_ms === null) continue;

          const angle_rad = toAngle(phase_ms, rr_ms);
          const confidence = typeof t.confidence === 'number' && t.confidence >= 0 ? t.confidence : null;
          const sqi = typeof t.sqi === 'number' ? t.sqi :
                      (t.qualitySummary ? t.qualitySummary.sqiFinalValue : null);
          const bodyPos = typeof t.bodyPos === 'number' ? t.bodyPos : -1;

          trials.push({
            participantId: pid,
            day,
            sessionId: sid,
            sessionDate,
            trialIndex: i,
            phase_ms,
            angle_rad,
            rr_ms,
            confidence,
            sqi,
            bodyPos,
            valid: sqi === null || sqi >= 0.3
          });
        }
      }
    }

    return trials;
  }

  // ── Session-level summaries ────────────────────────────────────────────────
  // Returns one object per session containing aggregated ePAT stats.
  function sessionSummaries(sessions) {
    const summaries = [];
    for (const session of sessions) {
      const pid = session.participantId || 'Unknown';
      const day = session.day || 1;
      const sid = session.sessionId || '';
      const date = session.startedAt ? session.startedAt.slice(0, 10) : '';

      for (const entry of (session.data || [])) {
        if (entry.type !== 'epat_response') continue;

        // Use embedded summary if present, otherwise recompute
        const s = entry.summary || {};
        const trialArr = (entry.trials || []).filter(t => !t.isPractice);
        if (trialArr.length === 0) continue;

        let sessionBpm = null;
        for (const e2 of (session.data || [])) {
          if (e2.type === 'ema_response') {
            for (const [, rec] of Object.entries(e2.responses || {})) {
              const v = rec && typeof rec === 'object' && 'value' in rec ? rec.value : rec;
              if (v && typeof v === 'object' && typeof v.bpm === 'number' && v.bpm > 30) sessionBpm = v.bpm;
            }
          }
        }

        const phases = [];
        const angles = [];
        const confs = [];
        const sqis = [];

        for (const t of trialArr) {
          const pm = typeof t.phase_ms === 'number' ? t.phase_ms :
                     (typeof t.visualOffset === 'number' ? t.visualOffset : null);
          if (pm === null) continue;

          let rr_ms = 800;
          if (Array.isArray(t.recordedHR) && t.recordedHR.length > 0) {
            const mhr = median(t.recordedHR.filter(v => v > 30 && v < 220));
            if (mhr) rr_ms = 60000 / mhr;
          } else if (sessionBpm) rr_ms = 60000 / sessionBpm;

          phases.push(pm);
          angles.push(toAngle(pm, rr_ms));
          if (typeof t.confidence === 'number' && t.confidence >= 0) confs.push(t.confidence);
          const sq = typeof t.sqi === 'number' ? t.sqi : (t.qualitySummary?.sqiFinalValue ?? null);
          if (sq !== null) sqis.push(sq);
        }

        const cs = circularStats(angles);
        const meanAbsPhase = mean(phases.map(Math.abs));
        const medianRR = 800; // rough fallback

        summaries.push({
          participantId: pid,
          day,
          sessionId: sid,
          date,
          validTrials: s.valid_trials ?? trialArr.length,
          totalTrials: trialArr.length,
          meanAbsPhase_ms: meanAbsPhase,
          meanAngle_deg: angleToDeg(cs.mean),
          R: cs.R,
          sd_rad: cs.sd_rad,
          p_rayleigh: cs.p_rayleigh,
          meanConfidence: confs.length ? mean(confs) : null,
          meanSqi: sqis.length ? mean(sqis) : null,
        });
      }
    }
    return summaries;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmt(v, dec = 0) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return Number(v).toFixed(dec);
  }
  function fmtMs(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return `${Math.round(v)} ms`;
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────
  function ensureTooltip() {
    if (_tooltipEl) return;
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'pat-tooltip';
    _tooltipEl.style.cssText = `
      position: fixed; z-index: 9999; pointer-events: none; opacity: 0;
      background: var(--bg-1); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 10px 14px;
      font-size: 12px; color: var(--fg-2); line-height: 1.6;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      transition: opacity 0.12s ease;
      max-width: 220px;
    `;
    document.body.appendChild(_tooltipEl);
  }

  function showTooltip(html, x, y) {
    ensureTooltip();
    _tooltipEl.innerHTML = html;
    _tooltipEl.style.opacity = '1';
    const rect = _tooltipEl.getBoundingClientRect();
    const left = Math.min(x + 14, window.innerWidth - rect.width - 8);
    const top = Math.min(y - 10, window.innerHeight - rect.height - 8);
    _tooltipEl.style.left = left + 'px';
    _tooltipEl.style.top = top + 'px';
  }

  function hideTooltip() {
    if (_tooltipEl) _tooltipEl.style.opacity = '0';
  }

  // ── Destroy all chart instances ───────────────────────────────────────────
  function destroyCharts() {
    for (const key of Object.keys(_charts)) {
      try { _charts[key].destroy(); } catch (e) {}
      delete _charts[key];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POLAR CLOCK FACE  — drawn on a plain <canvas> (not Chart.js)
  // Shows individual trial dots on the cardiac cycle circle.
  // 0° (top) = R-peak. Clockwise = later in cycle.
  // ═══════════════════════════════════════════════════════════════════════════
  function drawClockFace(canvasId, trials, opts = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 320;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.42;
    const innerR = outerR * 0.18;
    const dotR = opts.dotR || 5;

    // Clear
    ctx.clearRect(0, 0, size, size);

    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, outerR + 4, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--bg-2') || '#1a1a1a';
    ctx.fill();

    // Tick marks (12 like a clock, but representing ~83ms segments at 800ms RR)
    ctx.strokeStyle = cssVar('--border') || '#333';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const r0 = outerR * 0.88;
      const r1 = outerR * (i % 3 === 0 ? 0.96 : 0.92);
      ctx.beginPath();
      ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
      ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.stroke();
    }

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--border-hi') || '#444';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Quadrant labels (ms at 800ms RR as reference)
    ctx.fillStyle = cssVar('--fg-3') || '#666';
    ctx.font = `10px ${cssVar('--font-mono') || 'monospace'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelR = outerR * 1.13;
    const quadLabels = ['R-peak', '+25%', '+50%', '+75%'];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      ctx.fillText(quadLabels[i], cx + labelR * Math.cos(a), cy + labelR * Math.sin(a));
    }

    if (!trials.length) {
      ctx.fillStyle = cssVar('--fg-3') || '#666';
      ctx.font = `13px var(--font)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No trial data', cx, cy);
      return;
    }

    // Compute circular stats for this set of trials
    const angles = trials.map(t => t.angle_rad);
    const cs = circularStats(angles);

    // Draw density shading — soft arcs where trials cluster
    // We bin into 36 sectors of 10° and draw alpha-weighted fills
    const bins = new Array(36).fill(0);
    for (const a of angles) {
      const deg = angleToDeg(a);
      bins[Math.floor(deg / 10) % 36]++;
    }
    const maxBin = Math.max(...bins);
    if (maxBin > 0) {
      const accentRgb = cssVar('--accent-rgb') || '232,113,106';
      for (let i = 0; i < 36; i++) {
        if (!bins[i]) continue;
        const alpha = (bins[i] / maxBin) * 0.22;
        const startA = (i / 36) * Math.PI * 2 - Math.PI / 2;
        const endA = ((i + 1) / 36) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, outerR - 2, startA, endA);
        ctx.closePath();
        ctx.fillStyle = `rgba(${accentRgb}, ${alpha})`;
        ctx.fill();
      }
    }

    // Individual trial dots
    // Store hit rects for hover detection
    canvas._patTrials = trials.map((t, idx) => {
      const a = t.angle_rad - Math.PI / 2; // rotate so 0=top
      const r = innerR + (outerR - innerR) * 0.75;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);

      const sqi = t.sqi ?? 1;
      const alpha = 0.5 + sqi * 0.5;
      const isLowConf = t.confidence !== null && t.confidence < 4;

      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      const accent = cssVar('--accent') || '#e8716a';
      ctx.fillStyle = isLowConf ? (cssVar('--fg-3') || '#666') : accent;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;

      return { x, y, r: dotR + 4, trial: t, idx };
    });

    // Mean vector arrow
    const mvA = cs.mean - Math.PI / 2;
    const mvLen = outerR * 0.72 * cs.R;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + mvLen * Math.cos(mvA), cy + mvLen * Math.sin(mvA));
    ctx.strokeStyle = cssVar('--green') || '#3fb950';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.stroke();

    // Arrowhead
    const tip = { x: cx + mvLen * Math.cos(mvA), y: cy + mvLen * Math.sin(mvA) };
    const headLen = 10;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
      tip.x - headLen * Math.cos(mvA - 0.4),
      tip.y - headLen * Math.sin(mvA - 0.4)
    );
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
      tip.x - headLen * Math.cos(mvA + 0.4),
      tip.y - headLen * Math.sin(mvA + 0.4)
    );
    ctx.strokeStyle = cssVar('--green') || '#3fb950';
    ctx.lineWidth = 2;
    ctx.stroke();

    // R circle (resultant length indicator at inner ring)
    ctx.beginPath();
    ctx.arc(cx, cy, innerR + (outerR - innerR) * cs.R * 0.72, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${cssVar('--accent-rgb') || '232,113,106'}, 0.2)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Centre pulse icon
    ctx.beginPath();
    ctx.arc(cx, cy, innerR * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--bg-1') || '#111';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR * 0.6, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--border-hi') || '#444';
    ctx.lineWidth = 1;
    ctx.stroke();

    // R label in centre
    ctx.fillStyle = cssVar('--fg') || '#eee';
    ctx.font = `bold 13px var(--font-mono, monospace)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`R=${cs.R.toFixed(2)}`, cx, cy);

    // Hover listener — attach once, replace on re-render
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (size / rect.width);
      const my = (e.clientY - rect.top) * (size / rect.height);
      let hit = null;
      for (const h of (canvas._patTrials || [])) {
        if ((mx - h.x) ** 2 + (my - h.y) ** 2 < h.r ** 2) { hit = h; break; }
      }
      if (hit) {
        const t = hit.trial;
        const bpLabel = BODY_LABELS[t.bodyPos] || BODY_LABELS['-1'];
        const confLabel = t.confidence !== null ? `${t.confidence}/9` : 'n/r';
        showTooltip(`
          <div style="font-weight:600;color:var(--fg);margin-bottom:4px">Trial ${hit.idx + 1}</div>
          <div>Phase offset: <b>${fmtMs(t.phase_ms)}</b></div>
          <div>Angle: <b>${angleToDeg(t.angle_rad).toFixed(1)}°</b></div>
          <div>Confidence: <b>${confLabel}</b></div>
          <div>SQI: <b>${t.sqi !== null ? t.sqi.toFixed(3) : '--'}</b></div>
          <div>Felt in: <b>${bpLabel}</b></div>
          ${t.participantId ? `<div style="color:var(--fg-3);font-size:11px;margin-top:4px">PID: ${t.participantId}</div>` : ''}
        `, e.clientX, e.clientY);
        canvas.style.cursor = 'crosshair';
      } else {
        hideTooltip();
        canvas.style.cursor = 'default';
      }
    };
    canvas.onmouseleave = hideTooltip;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGGREGATE POLAR HISTOGRAM  — binned distribution across all trials
  // ═══════════════════════════════════════════════════════════════════════════
  function drawPolarHistogram(canvasId, trials) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 300;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.40;
    const N_BINS = 24; // 15° each

    ctx.clearRect(0, 0, size, size);

    // Background
    ctx.beginPath();
    ctx.arc(cx, cy, outerR + 8, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--bg-2') || '#1a1a1a';
    ctx.fill();

    if (!trials.length) {
      ctx.fillStyle = cssVar('--fg-3') || '#666';
      ctx.font = '13px var(--font)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data', cx, cy);
      return;
    }

    const bins = new Array(N_BINS).fill(0);
    for (const t of trials) {
      const deg = angleToDeg(t.angle_rad);
      bins[Math.floor(deg / (360 / N_BINS)) % N_BINS]++;
    }
    const maxBin = Math.max(...bins);
    const innerR = outerR * 0.22;
    const accent = cssVar('--accent') || '#e8716a';
    const accentRgb = cssVar('--accent-rgb') || '232,113,106';

    for (let i = 0; i < N_BINS; i++) {
      if (!bins[i]) continue;
      const ratio = bins[i] / maxBin;
      const startA = (i / N_BINS) * Math.PI * 2 - Math.PI / 2;
      const endA = ((i + 1) / N_BINS) * Math.PI * 2 - Math.PI / 2;
      const barR = innerR + (outerR - innerR) * ratio;

      ctx.beginPath();
      ctx.moveTo(cx + innerR * Math.cos(startA), cy + innerR * Math.sin(startA));
      ctx.arc(cx, cy, barR, startA, endA);
      ctx.arc(cx, cy, innerR, endA, startA, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(${accentRgb}, ${0.3 + ratio * 0.65})`;
      ctx.fill();
    }

    // Rings
    for (const r of [0.33, 0.66, 1.0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, innerR + (outerR - innerR) * r, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar('--border') || '#333';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Mean vector
    const cs = circularStats(trials.map(t => t.angle_rad));
    const mvA = cs.mean - Math.PI / 2;
    const mvLen = outerR * cs.R;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + mvLen * Math.cos(mvA), cy + mvLen * Math.sin(mvA));
    ctx.strokeStyle = cssVar('--green') || '#3fb950';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Labels
    ctx.fillStyle = cssVar('--fg-3') || '#666';
    ctx.font = `10px var(--font-mono, monospace)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lr = outerR * 1.18;
    const ql = ['R', '+90°', '+180°', '+270°'];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      ctx.fillText(ql[i], cx + lr * Math.cos(a), cy + lr * Math.sin(a));
    }

    // n label
    ctx.fillStyle = cssVar('--fg-3') || '#666';
    ctx.font = `11px var(--font)`;
    ctx.textAlign = 'center';
    ctx.fillText(`n = ${trials.length}`, cx, cy + outerR + 22);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART: Phase offset over days (line/scatter)
  // ═══════════════════════════════════════════════════════════════════════════
  function renderPhaseTimeline(canvasId, summaries) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch(e){} }

    const sorted = [...summaries].sort((a, b) => a.day - b.day || a.date.localeCompare(b.date));

    _charts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: sorted.map(s => `Day ${s.day}`),
        datasets: [{
          label: 'Mean |phase| (ms)',
          data: sorted.map(s => s.meanAbsPhase_ms !== null ? Math.round(s.meanAbsPhase_ms) : null),
          borderColor: cssVar('--accent') || '#e8716a',
          backgroundColor: (cssVar('--accent-rgb') ? `rgba(${cssVar('--accent-rgb')},0.12)` : 'rgba(232,113,106,0.12)'),
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.35,
          spanGaps: true,
        }, {
          label: 'R (consistency)',
          data: sorted.map(s => s.R !== null ? +(s.R * 1000).toFixed(0) : null), // scaled ×1000 for visibility
          borderColor: cssVar('--green') || '#3fb950',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 3,
          spanGaps: true,
          yAxisID: 'yR',
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: cssVar('--fg-3'), font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label(ctx) {
                if (ctx.datasetIndex === 0) return `|Phase|: ${ctx.raw} ms`;
                return `R: ${(ctx.raw / 1000).toFixed(3)}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: cssVar('--fg-3'), font: { size: 11 } }, grid: { color: cssVar('--border') } },
          y: { ticks: { color: cssVar('--fg-3'), font: { size: 11 } }, grid: { color: cssVar('--border') }, title: { display: true, text: 'ms', color: cssVar('--fg-3') } },
          yR: { position: 'right', min: 0, max: 1000, ticks: { color: cssVar('--green') || '#3fb950', font: { size: 10 }, callback: v => (v / 1000).toFixed(2) }, grid: { display: false }, title: { display: true, text: 'R', color: cssVar('--green') } }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART: Confidence vs accuracy scatter
  // ═══════════════════════════════════════════════════════════════════════════
  function renderConfidenceScatter(canvasId, trials) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch(e){} }

    const pts = trials
      .filter(t => t.confidence !== null)
      .map(t => ({ x: t.confidence, y: Math.abs(t.phase_ms) }));

    _charts[canvasId] = new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Trial',
          data: pts,
          backgroundColor: (cssVar('--accent-rgb') ? `rgba(${cssVar('--accent-rgb')},0.55)` : 'rgba(232,113,106,0.55)'),
          pointRadius: 4,
          pointHoverRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `Conf ${ctx.raw.x}/9 → ${Math.round(ctx.raw.y)} ms` } } },
        scales: {
          x: { title: { display: true, text: 'Confidence (0–9)', color: cssVar('--fg-3') }, ticks: { color: cssVar('--fg-3'), font: { size: 11 } }, grid: { color: cssVar('--border') }, min: 0, max: 9 },
          y: { title: { display: true, text: '|Phase offset| (ms)', color: cssVar('--fg-3') }, ticks: { color: cssVar('--fg-3'), font: { size: 11 } }, grid: { color: cssVar('--border') } }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART: Trial-by-trial phase sparkline (per-participant)
  // ═══════════════════════════════════════════════════════════════════════════
  function renderTrialSparkline(canvasId, trials) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch(e){} }

    _charts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: trials.map((_, i) => `T${i + 1}`),
        datasets: [{
          label: 'Phase offset (ms)',
          data: trials.map(t => t.phase_ms),
          borderColor: cssVar('--accent') || '#e8716a',
          backgroundColor: (cssVar('--accent-rgb') ? `rgba(${cssVar('--accent-rgb')},0.08)` : 'rgba(232,113,106,0.08)'),
          borderWidth: 1.5,
          pointRadius: 3,
          fill: true,
          tension: 0.3,
        }, {
          label: '|Phase| trend',
          data: trials.map(t => Math.abs(t.phase_ms)),
          borderColor: cssVar('--green') || '#3fb950',
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          tension: 0.4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: cssVar('--fg-3'), font: { size: 11 }, boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: cssVar('--fg-3'), font: { size: 10 }, maxRotation: 0 }, grid: { color: cssVar('--border') } },
          y: { ticks: { color: cssVar('--fg-3'), font: { size: 11 } }, grid: { color: cssVar('--border') }, title: { display: true, text: 'ms', color: cssVar('--fg-3') } }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CHART: SQI distribution bar
  // ═══════════════════════════════════════════════════════════════════════════
  function renderSqiBar(canvasId, trials) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch(e){} }

    const sqiTrials = trials.filter(t => t.sqi !== null);
    if (!sqiTrials.length) return;

    // Bin into 10 buckets [0, 0.1), [0.1, 0.2), ...
    const bins = new Array(10).fill(0);
    for (const t of sqiTrials) { bins[Math.min(9, Math.floor(t.sqi * 10))]++; }
    const labels = ['0–0.1','0.1–0.2','0.2–0.3','0.3–0.4','0.4–0.5','0.5–0.6','0.6–0.7','0.7–0.8','0.8–0.9','0.9–1.0'];
    const colors = labels.map((_, i) => i < 3
      ? (cssVar('--accent-rgb') ? `rgba(${cssVar('--accent-rgb')},0.7)` : 'rgba(232,113,106,0.7)')
      : (cssVar('--green') ? cssVar('--green') + 'aa' : '#3fb950aa'));

    _charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw} trials` } } },
        scales: {
          x: { ticks: { color: cssVar('--fg-3'), font: { size: 9 }, maxRotation: 30 }, grid: { display: false } },
          y: { ticks: { color: cssVar('--fg-3'), font: { size: 10 } }, grid: { color: cssVar('--border') }, title: { display: true, text: 'Count', color: cssVar('--fg-3') } }
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KPI STRIP HTML
  // ═══════════════════════════════════════════════════════════════════════════
  function kpiHtml(label, value, sub, cls = '') {
    return `
      <div class="kpi-card ${cls}">
        <span class="kpi-title">${label}</span>
        <span class="kpi-value" style="font-size:22px">${value}</span>
        <div class="kpi-trend trend-neutral">${sub}</div>
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER AGGREGATE VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  function renderAggregate(sessions) {
    const el = document.getElementById('pat-aggregate');
    if (!el) return;

    const allTrials = extractTrials(sessions);
    const allSummaries = sessionSummaries(sessions);

    if (!allTrials.length) {
      el.innerHTML = `<div class="pat-empty-inner">No ePAT data in loaded sessions.</div>`;
      return;
    }

    const validTrials = allTrials.filter(t => t.valid);
    const cs = circularStats(validTrials.map(t => t.angle_rad));
    const medRR = median(validTrials.map(t => t.rr_ms).filter(Boolean)) || 800;
    const meanAbsPhase = mean(validTrials.map(t => Math.abs(t.phase_ms)));
    const meanConf = mean(validTrials.filter(t => t.confidence !== null).map(t => t.confidence));
    const meanSqi = mean(validTrials.filter(t => t.sqi !== null).map(t => t.sqi));
    const validRate = allSummaries.length ? mean(allSummaries.map(s => s.validTrials / Math.max(1, s.totalTrials))) : null;
    const sd_ms = cs.sd_rad * medRR / (2 * Math.PI);
    const nSessions = allSummaries.length;
    const nParts = new Set(allSummaries.map(s => s.participantId)).size;

    el.innerHTML = `
      <!-- KPI Strip -->
      <div class="kpi-grid" style="grid-template-columns:repeat(6,1fr)">
        ${kpiHtml('Mean |Phase|', fmtMs(meanAbsPhase), 'Interoceptive accuracy', meanAbsPhase !== null && meanAbsPhase < 200 ? 'good' : meanAbsPhase < 350 ? 'warn' : 'danger')}
        ${kpiHtml('Circular Mean', `${fmt(angleToDeg(cs.mean), 1)}°`, 'Of cardiac cycle')}
        ${kpiHtml('Resultant (R)', fmt(cs.R, 3), cs.R >= 0.6 ? 'Strong clustering' : cs.R >= 0.35 ? 'Moderate' : 'Near-chance', cs.R >= 0.6 ? 'good' : cs.R >= 0.35 ? 'warn' : 'danger')}
        ${kpiHtml('Circ. SD', fmtMs(sd_ms), 'Spread around mean')}
        ${kpiHtml('Avg Confidence', meanConf !== null ? `${fmt(meanConf, 1)}/9` : '--', `${validTrials.filter(t => t.confidence !== null).length} ratings`)}
        ${kpiHtml('Valid Trial Rate', validRate !== null ? `${Math.round(validRate * 100)}%` : '--', `${nSessions} sessions · ${nParts} participants`)}
      </div>

      <!-- Main charts row -->
      <div class="chart-grid" style="grid-template-columns:1fr 1fr 1fr;gap:16px">
        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">Phase Distribution</span>
            <span class="badge badge-neutral" title="Circular histogram. Each bin = 15° of cardiac cycle. Arrow = mean vector (R = resultant length).">24 bins · 15°</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:center;height:280px">
            <canvas id="pat-polar-hist" style="width:260px;height:260px;display:block"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">Phase Offset Over Study Days</span>
            <span class="badge badge-neutral">|phase| + R</span>
          </div>
          <div class="chart-container" style="height:260px">
            <canvas id="pat-timeline-agg"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">Confidence vs. Accuracy</span>
            <span class="badge badge-neutral">Per trial</span>
          </div>
          <div class="chart-container" style="height:260px">
            <canvas id="pat-conf-scatter"></canvas>
          </div>
        </div>
      </div>

      <!-- Second row -->
      <div class="chart-grid" style="grid-template-columns:2fr 1fr;gap:16px">
        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">Signal Quality Index Distribution</span>
            <span class="badge badge-neutral">SQI threshold = 0.3</span>
          </div>
          <div class="chart-container" style="height:200px">
            <canvas id="pat-sqi-agg"></canvas>
          </div>
        </div>

        <div class="chart-card" style="justify-content:center">
          <div class="chart-header">
            <span class="chart-title">Rayleigh Test</span>
          </div>
          <div style="padding:8px 0;display:flex;flex-direction:column;gap:10px">
            <div class="pat-stat-row">
              <span class="pat-stat-label">z statistic</span>
              <span class="pat-stat-val">${fmt(validTrials.length * cs.R * cs.R, 2)}</span>
            </div>
            <div class="pat-stat-row">
              <span class="pat-stat-label">p (uniform?)</span>
              <span class="pat-stat-val ${cs.p_rayleigh < 0.05 ? 'pat-sig' : ''}">${cs.p_rayleigh < 0.001 ? '< .001' : fmt(cs.p_rayleigh, 3)}</span>
            </div>
            <div class="pat-stat-row">
              <span class="pat-stat-label">N trials</span>
              <span class="pat-stat-val">${validTrials.length}</span>
            </div>
            <div class="pat-stat-row">
              <span class="pat-stat-label">Mean RR</span>
              <span class="pat-stat-val">${fmtMs(medRR)}</span>
            </div>
            <div class="pat-stat-row">
              <span class="pat-stat-label">Circ. SD</span>
              <span class="pat-stat-val">${fmtMs(sd_ms)}</span>
            </div>
            <div style="margin-top:8px;font-size:10px;color:var(--fg-3);line-height:1.5">
              p < .05 → phase distribution is non-uniform (signal above chance). 
              R is the resultant length; z = N·R².
            </div>
          </div>
        </div>
      </div>
    `;

    // Render canvases after DOM is updated
    requestAnimationFrame(() => {
      drawPolarHistogram('pat-polar-hist', validTrials);
      renderPhaseTimeline('pat-timeline-agg', allSummaries);
      renderConfidenceScatter('pat-conf-scatter', validTrials);
      renderSqiBar('pat-sqi-agg', allTrials);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER PER-PARTICIPANT VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  function renderPerParticipant(sessions, selectedPid) {
    const el = document.getElementById('pat-per-participant');
    if (!el) return;

    const allTrials = extractTrials(sessions);
    const allSummaries = sessionSummaries(sessions);
    const pids = [...new Set(allTrials.map(t => t.participantId))].sort();

    if (!pids.length) {
      el.innerHTML = `<div class="pat-empty-inner">No ePAT data in loaded sessions.</div>`;
      return;
    }

    const pid = selectedPid || pids[0];
    const pidTrials = allTrials.filter(t => t.participantId === pid);
    const pidSummaries = allSummaries.filter(s => s.participantId === pid);

    // Session selector
    const sids = [...new Set(pidTrials.map(t => t.sessionId))];
    const selectedSid = sids[sids.length - 1]; // default to most recent
    const sessionTrials = pidTrials.filter(t => t.sessionId === selectedSid);

    const cs = circularStats(sessionTrials.map(t => t.angle_rad));
    const medRR = median(sessionTrials.map(t => t.rr_ms).filter(Boolean)) || 800;
    const meanAbsPhase = mean(sessionTrials.map(t => Math.abs(t.phase_ms)));
    const meanConf = mean(sessionTrials.filter(t => t.confidence !== null).map(t => t.confidence));
    const sd_ms = cs.sd_rad * medRR / (2 * Math.PI);
    const curSummary = pidSummaries.find(s => s.sessionId === selectedSid) || {};

    el.innerHTML = `
      <!-- Participant selector row -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
        <span class="section-title" style="margin:0">Participant</span>
        <select id="pat-pid-select" style="width:180px;font-size:12px;padding:5px 8px">
          ${pids.map(p => `<option value="${p}" ${p === pid ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <span class="section-title" style="margin:0">Session</span>
        <select id="pat-sid-select" style="width:200px;font-size:12px;padding:5px 8px">
          ${pidSummaries.map(s => `<option value="${s.sessionId}" ${s.sessionId === selectedSid ? 'selected' : ''}>Day ${s.day} · ${s.date} (${s.validTrials} trials)</option>`).join('')}
        </select>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <span class="badge ${cs.p_rayleigh < 0.05 ? 'badge-danger' : 'badge-neutral'}" title="Rayleigh test p-value">
            ${cs.p_rayleigh < 0.001 ? 'p < .001 ✓' : `p = ${fmt(cs.p_rayleigh, 3)}`}
          </span>
          <span class="badge badge-neutral">${sessionTrials.length} trials this session</span>
        </div>
      </div>

      <!-- KPI Strip -->
      <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr)">
        ${kpiHtml('Mean |Phase|', fmtMs(meanAbsPhase), 'This session', meanAbsPhase !== null && meanAbsPhase < 200 ? 'good' : meanAbsPhase < 350 ? 'warn' : 'danger')}
        ${kpiHtml('Resultant (R)', fmt(cs.R, 3), 'Phase consistency', cs.R >= 0.6 ? 'good' : cs.R >= 0.35 ? 'warn' : 'danger')}
        ${kpiHtml('Mean Angle', `${fmt(angleToDeg(cs.mean), 1)}°`, `${fmtMs(angleToMs(cs.mean < 0 ? cs.mean + 2*Math.PI : cs.mean, medRR))} into RR`)}
        ${kpiHtml('Circ. SD', fmtMs(sd_ms), 'Spread')}
        ${kpiHtml('Avg Confidence', meanConf !== null ? `${fmt(meanConf, 1)}/9` : '--', `${sessionTrials.filter(t=>t.confidence!==null).length} rated`)}
      </div>

      <!-- Main row: clock face + longitudinal -->
      <div class="chart-grid" style="grid-template-columns:320px 1fr;gap:16px">
        <div class="chart-card" style="align-items:center">
          <div class="chart-header" style="width:100%">
            <span class="chart-title">Phase Hit Map</span>
            <span class="badge badge-neutral" title="Each dot = one trial. Top = R-peak. Clockwise = later in cycle. Hover for details.">hover for details</span>
          </div>
          <canvas id="pat-clockface" style="width:280px;height:280px;display:block"></canvas>
          <div style="margin-top:12px;display:flex;gap:16px;font-size:11px;color:var(--fg-3)">
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block"></span>High conf.
            </span>
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:10px;height:10px;border-radius:50%;background:var(--fg-3);display:inline-block"></span>Low conf.
            </span>
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:18px;height:2px;background:var(--green);display:inline-block"></span>Mean vec.
            </span>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:16px;flex:1">
          <div class="chart-card">
            <div class="chart-header">
              <span class="chart-title">Session History — |Phase| & R</span>
            </div>
            <div class="chart-container" style="height:160px">
              <canvas id="pat-pid-timeline"></canvas>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-header">
              <span class="chart-title">Trial-by-Trial Phase Offset</span>
              <span class="badge badge-neutral">Within this session</span>
            </div>
            <div class="chart-container" style="height:160px">
              <canvas id="pat-trial-sparkline"></canvas>
            </div>
          </div>
        </div>
      </div>
    `;

    // Bind selectors
    document.getElementById('pat-pid-select').addEventListener('change', e => {
      renderPerParticipant(sessions, e.target.value);
    });
    document.getElementById('pat-sid-select').addEventListener('change', e => {
      renderPerParticipantSession(sessions, pid, e.target.value);
    });

    // Render charts
    requestAnimationFrame(() => {
      drawClockFace('pat-clockface', sessionTrials);
      renderPhaseTimeline('pat-pid-timeline', pidSummaries);
      renderTrialSparkline('pat-trial-sparkline', sessionTrials);
    });
  }

  function renderPerParticipantSession(sessions, pid, sid) {
    // Re-render just the session-specific charts without rebuilding the whole view
    const allTrials = extractTrials(sessions);
    const sessionTrials = allTrials.filter(t => t.participantId === pid && t.sessionId === sid);

    const cs = circularStats(sessionTrials.map(t => t.angle_rad));
    const medRR = median(sessionTrials.map(t => t.rr_ms).filter(Boolean)) || 800;
    const sd_ms = cs.sd_rad * medRR / (2 * Math.PI);
    const meanAbsPhase = mean(sessionTrials.map(t => Math.abs(t.phase_ms)));

    // Update KPI cards inline
    const kpis = document.querySelectorAll('#pat-per-participant .kpi-value');
    if (kpis[0]) kpis[0].textContent = fmtMs(meanAbsPhase);
    if (kpis[1]) kpis[1].textContent = fmt(cs.R, 3);
    if (kpis[2]) kpis[2].textContent = `${fmt(angleToDeg(cs.mean), 1)}°`;
    if (kpis[3]) kpis[3].textContent = fmtMs(sd_ms);

    requestAnimationFrame(() => {
      drawClockFace('pat-clockface', sessionTrials);
      renderTrialSparkline('pat-trial-sparkline', sessionTrials);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════
  return {

    // Called from AppUI.refreshData() whenever data or filters change.
    render() {
      const sessions = (typeof DataParser !== 'undefined') ? DataParser.state.filteredSessions : [];
      const isAggregate = document.querySelector('.seg-ctrl .seg-btn.active')?.textContent.trim() === 'Aggregate';

      destroyCharts();

      const viewEl = document.getElementById('view-pat');
      if (!viewEl || !viewEl.classList.contains('active')) return;

      if (isAggregate) {
        document.getElementById('pat-aggregate')?.style && (document.getElementById('pat-aggregate').style.display = 'flex');
        document.getElementById('pat-per-participant')?.style && (document.getElementById('pat-per-participant').style.display = 'none');
        renderAggregate(sessions);
      } else {
        document.getElementById('pat-aggregate')?.style && (document.getElementById('pat-aggregate').style.display = 'none');
        document.getElementById('pat-per-participant')?.style && (document.getElementById('pat-per-participant').style.display = 'flex');
        const selectedPid = document.getElementById('filter-cohort')?.value;
        renderPerParticipant(sessions, selectedPid === 'all' ? null : selectedPid);
      }
    },

    // Called when the tab becomes active (resize + render)
    onTabActivate() {
      this.render();
    },

    // Ingest a standalone PAT-only JSON file
    ingestStandalonePAT(json) {
      if (!window.DataParser) return false;
      try {
        const payload = typeof json === 'string' ? JSON.parse(json) : json;
        // Normalise: if it's already a session-shaped object, pass through normaliser
        const session = DataParser.normalizeSession(payload);
        session.sessionId = payload.sessionId || `pat_standalone_${Date.now()}`;
        session.startedAt = payload.startedAt || new Date().toISOString();
        session.completedAt = payload.completedAt || session.startedAt;
        DataParser.state.allSessions.push(session);
        DataParser.state.filteredSessions = [...DataParser.state.allSessions];
        return true;
      } catch (e) {
        console.error('[PATView] Failed to ingest standalone PAT JSON:', e);
        return false;
      }
    }
  };

})();