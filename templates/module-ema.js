"use strict";

// ==========================================================
// EMA PAGINATION ENGINE — v1.4
// ==========================================================
//
// Changes from v1.3:
//
// NEW QUESTION TYPE: affect_grid
//   A 2D tap-target for core affect (valence × arousal). Based on the
//   Russell circumplex / affect-grid tradition (Russell, Weiss, & Mendelsohn,
//   1989 and the Yik et al. (2011) refinements). Captures valence and
//   arousal as a joint {x, y} point in [-1, 1] rather than two independent
//   sliders — which is the conceptually-correct way to measure core affect
//   under a constructionist framework because it forces participants to
//   commit to a single integrated location.
//
//   Config:
//     {
//       id: "q_affect",
//       type: "affect_grid",
//       text: "Right now, how are you feeling?",
//       valence_labels:  ["Unpleasant", "Pleasant"],    // [low, high]
//       arousal_labels:  ["Deactivated", "Activated"],  // [low, high]
//       show_quadrant_labels: true,                     // optional
//       required: true, condition, block, windows
//     }
//
//   Stored value: { valence: -1..1, arousal: -1..1 }
//   CSV serialization: "valence;arousal" (see Upload._serializeValue)
//   CSV response_numeric: '' (it's 2D — use valence/arousal columns in R)
//
//   For analysts: the valence/arousal values are already orthogonal and
//   standardized to [-1, 1] so you can drop them straight into a
//   circumplex plot or feed them into ILR/multilevel models without
//   rescaling.
//
// PRESERVED from v1.3:
//   - Per-question respondedAt timestamps
//   - Skip-logic evaluation per page
//   - Orphan page-break dropping
//   - Prefixed phase tokens only (pre_<wid> / post_<wid>)
// ==========================================================

const EMA = (function() {
  let emaPages         = [];
  let currentPageIndex = 0;
  let emaResponses     = null;

  // -----------------------------------------------------------------------
  // buildPages — unchanged from v1.3
  // -----------------------------------------------------------------------
  function buildPages(windowId, blockDir) {
    emaPages = [];
    let currentBlock = [];

    config.ema.questions.forEach(q => {
      if (q.type === 'page_break') {
        if (currentBlock.length > 0) {
          emaPages.push(currentBlock);
          currentBlock = [];
        }
        return;
      }

      const windowMatch = q.windows === null
        || q.windows === undefined
        || (windowId && q.windows.includes(windowId));

      const block = q.block || 'both';
      const blockMatch = blockDir === 'post'
        ? (block === 'post' || block === 'both')
        : (block === 'pre'  || block === 'both');

      if (windowMatch && blockMatch) {
        currentBlock.push(q);
      }
    });

    if (currentBlock.length > 0) emaPages.push(currentBlock);
  }

  function recordResponse(qid, value) {
    emaResponses.responses[qid] = {
      value: value,
      respondedAt: new Date().toISOString()
    };
  }

  function valueOf(qid) {
    const rec = emaResponses.responses[qid];
    if (rec === undefined) return undefined;
    return (rec && typeof rec === 'object' && 'value' in rec) ? rec.value : rec;
  }

  function interpolate(text, responses) {
    // Replace {{question_id}} tokens with the current response value.
    // e.g. "Your heart rate was {{q_hr_1}} BPM — are you anxious?"
    // If the question hasn't been answered yet, leaves the token as-is.
    return text.replace(/\{\{([^}]+)\}\}/g, (match, qid) => {
      const rec = responses[qid.trim()];
      if (rec === undefined || rec === null) return match;
      const val = (rec && typeof rec === 'object' && 'value' in rec) ? rec.value : rec;
      if (val === null || val === undefined) return match;
      if (typeof val === 'object') return JSON.stringify(val);
      return String(Math.round(Number(val) * 10) / 10); // round to 1dp for readability
    });
  }

  // -----------------------------------------------------------------------
  // Affect grid builder — builds an SVG tap-target and wires pointer events.
  // Uses CSS variables for theming so it stays consistent across dark/light.
  // -----------------------------------------------------------------------
  function buildAffectGrid(q, wrapper) {
    const cur = valueOf(q.id);
    const initial = (cur && typeof cur === 'object' && 'valence' in cur && 'arousal' in cur)
      ? cur
      : null;

    const vLabels = q.valence_labels || ['Unpleasant', 'Pleasant'];
    const aLabels = q.arousal_labels || ['Deactivated', 'Activated'];
    const showQuadrants = q.show_quadrant_labels !== false; // default true

    const container = document.createElement('div');
    container.className = 'affect-grid-container';
    container.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;margin:0 auto;max-width:360px;width:100%;';

    // Arousal high label (top)
    const aHi = document.createElement('div');
    aHi.textContent = aLabels[1];
    aHi.style.cssText = 'font-size:0.82rem;color:var(--fg-muted);font-weight:500;';
    container.appendChild(aHi);

    // Row: [valence-low label] [grid] [valence-high label]
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;';

    const vLo = document.createElement('div');
    vLo.textContent = vLabels[0];
    vLo.style.cssText = 'font-size:0.82rem;color:var(--fg-muted);font-weight:500;writing-mode:vertical-rl;transform:rotate(180deg);flex-shrink:0;';
    row.appendChild(vLo);

    // The grid itself — SVG so we get crisp rendering + easy hit testing
    const gridWrap = document.createElement('div');
    gridWrap.style.cssText = 'flex:1;aspect-ratio:1/1;position:relative;touch-action:none;user-select:none;';

    const SIZE = 300;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    svg.style.cssText = 'width:100%;height:100%;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);display:block;cursor:crosshair;';

    // Grid lines (3x3 reference lines)
    for (let i = 1; i <= 3; i++) {
      const x = (SIZE / 4) * i;
      const lineV = document.createElementNS(svgNS, 'line');
      lineV.setAttribute('x1', x); lineV.setAttribute('x2', x);
      lineV.setAttribute('y1', 0); lineV.setAttribute('y2', SIZE);
      lineV.setAttribute('stroke', 'var(--border)');
      lineV.setAttribute('stroke-width', i === 2 ? '1.5' : '0.5');
      lineV.setAttribute('stroke-dasharray', i === 2 ? '' : '2,3');
      svg.appendChild(lineV);

      const lineH = document.createElementNS(svgNS, 'line');
      lineH.setAttribute('y1', x); lineH.setAttribute('y2', x);
      lineH.setAttribute('x1', 0); lineH.setAttribute('x2', SIZE);
      lineH.setAttribute('stroke', 'var(--border)');
      lineH.setAttribute('stroke-width', i === 2 ? '1.5' : '0.5');
      lineH.setAttribute('stroke-dasharray', i === 2 ? '' : '2,3');
      svg.appendChild(lineH);
    }

    // Optional quadrant labels (faint)
    if (showQuadrants) {
      const quadLabels = [
        { x: SIZE * 0.25, y: SIZE * 0.25, text: 'Tense'    },   // high arousal, low valence
        { x: SIZE * 0.75, y: SIZE * 0.25, text: 'Excited'  },   // high arousal, high valence
        { x: SIZE * 0.25, y: SIZE * 0.75, text: 'Depressed'},   // low arousal, low valence
        { x: SIZE * 0.75, y: SIZE * 0.75, text: 'Calm'     }    // low arousal, high valence
      ];
      quadLabels.forEach(q => {
        const txt = document.createElementNS(svgNS, 'text');
        txt.setAttribute('x', q.x); txt.setAttribute('y', q.y);
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'middle');
        txt.setAttribute('fill', 'var(--fg-muted)');
        txt.setAttribute('font-size', '11');
        txt.setAttribute('opacity', '0.5');
        txt.textContent = q.text;
        svg.appendChild(txt);
      });
    }

    // The marker
    const marker = document.createElementNS(svgNS, 'circle');
    marker.setAttribute('r', '14');
    marker.setAttribute('fill', 'var(--accent)');
    marker.setAttribute('stroke', 'var(--bg)');
    marker.setAttribute('stroke-width', '3');
    marker.style.display = initial ? 'block' : 'none';
    svg.appendChild(marker);

    // "Tap to respond" hint, shown until first touch
    const hint = document.createElementNS(svgNS, 'text');
    hint.setAttribute('x', SIZE / 2);
    hint.setAttribute('y', SIZE / 2 + 4);
    hint.setAttribute('text-anchor', 'middle');
    hint.setAttribute('fill', 'var(--fg-muted)');
    hint.setAttribute('font-size', '13');
    hint.textContent = 'Tap to place';
    hint.style.pointerEvents = 'none';
    if (initial) hint.style.display = 'none';
    svg.appendChild(hint);

    // ---- Coordinate math ----
    // Screen → [-1, 1]:
    //   valence = (x / SIZE) * 2 - 1         (left = -1, right = +1)
    //   arousal = 1 - (y / SIZE) * 2         (top = +1, bottom = -1)
    function svgPointFromClientPoint(clientX, clientY) {
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }

    function updateFromPoint(svgX, svgY) {
      const x = Math.max(0, Math.min(SIZE, svgX));
      const y = Math.max(0, Math.min(SIZE, svgY));
      marker.setAttribute('cx', x);
      marker.setAttribute('cy', y);
      marker.style.display = 'block';
      hint.style.display = 'none';

      const valence = +((x / SIZE) * 2 - 1).toFixed(3);
      const arousal = +(1 - (y / SIZE) * 2).toFixed(3);
      recordResponse(q.id, { valence, arousal });
      checkSubmitFn();
    }

    // Place initial marker if we had a prior value (resumption or going back)
    if (initial) {
      const x = ((initial.valence + 1) / 2) * SIZE;
      const y = ((1 - initial.arousal) / 2) * SIZE;
      marker.setAttribute('cx', x);
      marker.setAttribute('cy', y);
    }

    // Unified pointer handling (works for mouse + touch + pen)
    let dragging = false;
    const onDown = e => {
      dragging = true;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const pt = svgPointFromClientPoint(clientX, clientY);
      updateFromPoint(pt.x, pt.y);
    };
    const onMove = e => {
      if (!dragging) return;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const pt = svgPointFromClientPoint(clientX, clientY);
      updateFromPoint(pt.x, pt.y);
    };
    const onUp = () => { dragging = false; };

    svg.addEventListener('mousedown',  onDown);
    svg.addEventListener('mousemove',  onMove);
    window.addEventListener('mouseup', onUp);
    svg.addEventListener('touchstart', onDown, { passive: false });
    svg.addEventListener('touchmove',  onMove, { passive: false });
    svg.addEventListener('touchend',   onUp);

    gridWrap.appendChild(svg);
    row.appendChild(gridWrap);

    const vHi = document.createElement('div');
    vHi.textContent = vLabels[1];
    vHi.style.cssText = 'font-size:0.82rem;color:var(--fg-muted);font-weight:500;writing-mode:vertical-rl;flex-shrink:0;';
    row.appendChild(vHi);

    container.appendChild(row);

    // Arousal low label (bottom)
    const aLo = document.createElement('div');
    aLo.textContent = aLabels[0];
    aLo.style.cssText = 'font-size:0.82rem;color:var(--fg-muted);font-weight:500;';
    container.appendChild(aLo);

    wrapper.appendChild(container);
  }

  function buildHeartRateCapture(q, wrapper, checkSubmit) {
    const core = window.ePATCore;
    const durationSec = q.duration_sec || 30;
 
    // Start with null so required check blocks Next until capture completes
    if (valueOf(q.id) === undefined) recordResponse(q.id, null);
 
    const circ = 2 * Math.PI * 85;
    const uid = q.id.replace(/[^a-z0-9]/gi, '_');
 
    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0;';
    container.innerHTML = `
      <div class="progress-ring" style="width:160px;height:160px;">
        <svg viewBox="0 0 180 180">
          <circle class="track" cx="90" cy="90" r="85"/>
          <circle class="fill" id="hr-ring-${uid}" cx="90" cy="90" r="85"/>
        </svg>
        <div class="baseline-bpm-box">
          <div class="baseline-bpm-number" id="hr-bpm-${uid}" style="font-size:2.8rem;">--</div>
          <div class="baseline-bpm-label">BPM</div>
        </div>
      </div>
      <p style="font-size:0.88rem;color:var(--fg-muted);text-align:center;margin:0;">
        Cover the rear <strong style="color:var(--fg);">camera + flashlight</strong> with your fingertip
      </p>
      <div id="hr-status-${uid}" style="font-size:0.82rem;color:var(--fg-muted);text-align:center;min-height:1.2em;"></div>
    `;
    wrapper.appendChild(container);
 
    // Disable Next until capture completes
    const nextBtn = document.getElementById('ema-next-btn');
    if (nextBtn) nextBtn.disabled = true;
 
    const ringEl   = container.querySelector(`#hr-ring-${uid}`);
    const bpmEl    = container.querySelector(`#hr-bpm-${uid}`);
    const statusEl = container.querySelector(`#hr-status-${uid}`);
 
    if (!core) {
      // Preview mode — simulate
      if (statusEl) statusEl.textContent = 'Preview: simulating…';
      let t = 0;
      const sim = setInterval(() => {
        t++;
        const fakeBpm = 65 + Math.round(Math.random() * 10);
        if (bpmEl) bpmEl.textContent = String(fakeBpm);
        if (ringEl) ringEl.style.strokeDashoffset = String(circ * (1 - t / durationSec));
        if (statusEl) statusEl.textContent = `${durationSec - t}s remaining`;
        if (t >= durationSec) {
          clearInterval(sim);
          recordResponse(q.id, fakeBpm);
          if (statusEl) statusEl.textContent = `Captured: ${fakeBpm} BPM`;
          checkSubmit();
        }
      }, 1000);
      return;
    }
 
    const videoEl  = document.getElementById('video-feed');
    const canvasEl = document.getElementById('sampling-canvas');
    const bpms = [];
    const startMs = Date.now();
    let done = false;
 
    const timer = setInterval(() => {
      if (done) return;
      const elapsed   = (Date.now() - startMs) / 1000;
      const remaining = Math.max(0, durationSec - elapsed);
      if (ringEl) ringEl.style.strokeDashoffset = String(circ * (1 - Math.min(1, elapsed / durationSec)));
      if (statusEl) statusEl.textContent = `${Math.ceil(remaining)}s remaining`;
      if (remaining <= 0) {
        done = true; clearInterval(timer);
        core.BeatDetector.setCallbacks({ onBeatCb: null, onFingerChangeCb: null, onSqiUpdateCb: null, onPPGSampleCb: null });
        core.BeatDetector.stop().then(() => {
          const avg = bpms.length > 0
            ? Math.round((bpms.reduce((a,b)=>a+b,0) / bpms.length) * 10) / 10
            : null;
          recordResponse(q.id, avg);
          if (bpmEl && avg) bpmEl.textContent = String(Math.round(avg));
          if (statusEl) statusEl.textContent = avg ? `Captured: ${Math.round(avg)} BPM` : 'No signal detected';
          checkSubmit();
        });
      }
    }, 250);
 
    core.BeatDetector.start({
      video: videoEl, canvas: canvasEl,
      onBeatCb: (beat) => {
        bpms.push(beat.averageBPM);
        if (bpmEl) bpmEl.textContent = String(Math.round(beat.averageBPM));
      },
      onFingerChangeCb: (present) => {
        if (!done && statusEl) statusEl.textContent = present ? 'Detecting…' : 'Place finger on camera and flashlight';
      },
      onSqiUpdateCb: () => {},
      onPPGSampleCb: () => {}
    }).catch(() => {
      clearInterval(timer);
      recordResponse(q.id, null);
      if (statusEl) statusEl.textContent = 'Camera unavailable';
      checkSubmit();
    });
  }

  // Shared checkSubmit reference so affect-grid can call it.
  // Set inside renderCurrentPage before any question builder runs.
  let checkSubmitFn = () => {};

  // -----------------------------------------------------------------------
  // renderCurrentPage
  // -----------------------------------------------------------------------
  function renderCurrentPage() {
    const container = document.getElementById('ema-single-container');
    const nextBtn   = document.getElementById('ema-next-btn');

    let visibleQuestions = [];
    while (currentPageIndex < emaPages.length) {
      visibleQuestions = emaPages[currentPageIndex].filter(q => {
        return evalCond(q.condition, emaResponses.responses);
      });
      if (visibleQuestions.length > 0) break;
      currentPageIndex++;
    }

    if (currentPageIndex >= emaPages.length) {
      emaResponses.submittedAt = new Date().toISOString();
      sessionData.data.push(emaResponses);
      advancePhase();
      return;
    }

    const pct = Math.round(((currentPageIndex + 1) / emaPages.length) * 100);
    document.getElementById('ema-progress-fill').style.width = pct + '%';
    container.innerHTML = '';

    function checkSubmit() {
      const allAnswered = visibleQuestions.every(q => {
        if (!q.required) return true;
        const v = valueOf(q.id);
        if (v === undefined || v === null || v === '') return false;
        if (Array.isArray(v) && v.length === 0) return false;
        // affect_grid has an object shape — check for both coords
        if (q.type === 'affect_grid') {
          return v && typeof v === 'object' && 'valence' in v && 'arousal' in v;
        }
        return true;
      });
      nextBtn.disabled = !allAnswered;
    }
    checkSubmitFn = checkSubmit;  // share with builders

    visibleQuestions.forEach(q => {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '48px';

      const qTitle = document.createElement('div');
      qTitle.className = 'ema-question';
      qTitle.textContent = interpolate(q.text || '', emaResponses.responses);
      wrapper.appendChild(qTitle);

      if (q.type === 'slider') {
        const grp = document.createElement('div');
        grp.className = 'slider-group';
        const cur = valueOf(q.id);
        const defaultVal = (cur !== undefined && cur !== null && cur !== '')
          ? cur
          : Math.round((Number(q.min) + Number(q.max)) / 2);
        grp.innerHTML = `
          <div class="slider-val-display" data-for="${q.id}">${defaultVal}${q.unit ? ' ' + q.unit : ''}</div>
          <input type="range" class="range-slider" data-qid="${q.id}"
                 min="${q.min}" max="${q.max}" step="${q.step || 1}" value="${defaultVal}">
          <div class="slider-labels">
            <span>${(q.anchors || ['',''])[0] || ''}</span>
            <span>${(q.anchors || ['',''])[1] || ''}</span>
          </div>
        `;
        const slider = grp.querySelector('input');
        const disp   = grp.querySelector('.slider-val-display');
        let touched = cur !== undefined && cur !== null && cur !== '';
        slider.addEventListener('input', () => {
          touched = true;
          const v = Number(slider.value);
          disp.textContent = v + (q.unit ? ' ' + q.unit : '');
          recordResponse(q.id, v);
          checkSubmit();
        });
        if (touched && (cur !== valueOf(q.id))) {
          recordResponse(q.id, Number(defaultVal));
        }
        wrapper.appendChild(grp);

      } else if (q.type === 'choice') {
        const grp = document.createElement('div');
        grp.className = 'choice-group';
        (q.options || []).forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'choice-btn';
          btn.textContent = opt;
          btn.dataset.val = opt;
          btn.addEventListener('click', () => {
            grp.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            recordResponse(q.id, opt);
            checkSubmit();
          });
          if (valueOf(q.id) === opt) btn.classList.add('selected');
          grp.appendChild(btn);
        });
        wrapper.appendChild(grp);

      } else if (q.type === 'checkbox') {
        const grp = document.createElement('div');
        grp.className = 'choice-group';
        const selected = new Set(Array.isArray(valueOf(q.id)) ? valueOf(q.id) : []);
        (q.options || []).forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'choice-btn';
          btn.textContent = opt;
          btn.dataset.val = opt;
          if (selected.has(opt)) btn.classList.add('selected');
          btn.addEventListener('click', () => {
            if (selected.has(opt)) { selected.delete(opt); btn.classList.remove('selected'); }
            else { selected.add(opt); btn.classList.add('selected'); }
            recordResponse(q.id, Array.from(selected));
            checkSubmit();
          });
          grp.appendChild(btn);
        });
        wrapper.appendChild(grp);

      } else if (q.type === 'affect_grid') {
        buildAffectGrid(q, wrapper);

        } else if (q.type === 'heart_rate') {
        buildHeartRateCapture(q, wrapper, checkSubmit);

      } else {
        // Generic text / numeric input
        const grp = document.createElement('div');
        grp.className = 'text-group';
        const inp = document.createElement('input');
        inp.type = (q.type === 'numeric') ? 'number' : 'text';
        inp.className = 'text-input';
        const cur = valueOf(q.id);
        if (cur !== undefined && cur !== null) inp.value = cur;
        inp.addEventListener('input', () => {
          const v = (q.type === 'numeric' && inp.value !== '') ? Number(inp.value) : inp.value;
          recordResponse(q.id, v);
          checkSubmit();
        });
        grp.appendChild(inp);
        wrapper.appendChild(grp);
      }

      container.appendChild(wrapper);
    });

    checkSubmit();

    const isLastPage  = currentPageIndex === emaPages.length - 1;
    const isLastPhase = sessionData.currentPhase === sessionData.phases.length - 1;
    nextBtn.textContent = (isLastPage && isLastPhase) ? 'Submit Check-In' : 'Next';

    container.classList.remove('fade-out', 'fade-in');
    void container.offsetWidth;
    container.classList.add('fade-in');
    setTimeout(() => container.classList.remove('fade-in'), 50);
  }

  function installNextHandler() {
    document.getElementById('ema-next-btn').onclick = () => {
      const container = document.getElementById('ema-single-container');
      container.classList.add('fade-out');
      setTimeout(() => { currentPageIndex++; renderCurrentPage(); }, 300);
    };
  }

  return {
    start(phaseToken) {
      let blockDir = 'pre';
      let windowId = null;

      if (phaseToken.startsWith('pre_')) {
        blockDir = 'pre';
        windowId = phaseToken.slice(4);
      } else if (phaseToken.startsWith('post_')) {
        blockDir = 'post';
        windowId = phaseToken.slice(5);
      } else {
        console.warn('EMA.start received unprefixed phase token:', phaseToken);
        windowId = phaseToken;
      }

      emaResponses = {
        type:        'ema_response',
        phase:       phaseToken,
        windowId:    windowId,
        block:       blockDir,
        startedAt:   new Date().toISOString(),
        submittedAt: null,
        responses:   {}
      };

      buildPages(windowId, blockDir);
      currentPageIndex = 0;

      if (emaPages.length === 0) {
        emaResponses.submittedAt = emaResponses.startedAt;
        sessionData.data.push(emaResponses);
        advancePhase();
        return;
      }

      installNextHandler();
      show('screen-ema');
      renderCurrentPage();
    }
  };
})();