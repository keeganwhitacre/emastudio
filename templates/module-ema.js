// ==========================================================
// EMA PAGINATION ENGINE — v1.3
// ==========================================================
//
// Changes from v1.2:
//
// DATA CONTRACT:
//   - emaResponses.startedAt — ISO timestamp when the phase first rendered
//   - emaResponses.submittedAt — ISO timestamp when the phase was submitted
//   - Each entry in emaResponses.responses is now an object:
//       { value, respondedAt }
//     instead of the bare value. This enables per-question response-latency
//     analyses. evalCond() in study-base.js handles both shapes for
//     backward compatibility with imported data, but new writes always
//     use the object shape.
//
// ROUTER COMPAT:
//   - The legacy "plain window id" phase token path is gone. v1.3 always
//     sends "pre_<wid>" or "post_<wid>". If you see an unprefixed token,
//     it's a bug in the router, not input to tolerate here.
//
// GREETING:
//   - study-base.js sets the greeting before calling EMA.start() — this
//     module doesn't touch the element. Keeps one responsibility per file.
//
// ==========================================================

const EMA = (function() {
  let emaPages         = [];
  let currentPageIndex = 0;
  let emaResponses     = null;

  // -----------------------------------------------------------------------
  // buildPages(windowId, blockDir)
  //
  // Filtering logic:
  //   Window filter: q.windows === null  → appears in all windows
  //                  q.windows includes windowId → appears in this window
  //   Block filter:  blockDir "pre"  → q.block is "pre" or "both"
  //                  blockDir "post" → q.block is "post" or "both"
  //
  // Orphan page breaks (with nothing surviving on one side) are dropped.
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

  // -----------------------------------------------------------------------
  // Record a response with timestamp. This wraps the raw value in the
  // v1.3 { value, respondedAt } envelope.
  // -----------------------------------------------------------------------
  function recordResponse(qid, value) {
    emaResponses.responses[qid] = {
      value: value,
      respondedAt: new Date().toISOString()
    };
  }

  // -----------------------------------------------------------------------
  // Get the bare value for a qid (for skip-logic evaluation during render).
  // -----------------------------------------------------------------------
  function valueOf(qid) {
    const rec = emaResponses.responses[qid];
    if (rec === undefined) return undefined;
    return (rec && typeof rec === 'object' && 'value' in rec) ? rec.value : rec;
  }

  // -----------------------------------------------------------------------
  // renderCurrentPage — builds DOM for the current page, advancing through
  // any pages whose questions all fail skip-logic.
  // -----------------------------------------------------------------------
  function renderCurrentPage() {
    const container = document.getElementById('ema-single-container');
    const nextBtn   = document.getElementById('ema-next-btn');

    let visibleQuestions = [];
    while (currentPageIndex < emaPages.length) {
      visibleQuestions = emaPages[currentPageIndex].filter(q => {
        // Rewrap responses in the shape evalCond expects
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

    // Tracks whether every required question on this page has been answered.
    function checkSubmit() {
      const allAnswered = visibleQuestions.every(q => {
        if (!q.required) return true;
        const v = valueOf(q.id);
        if (v === undefined || v === null || v === '') return false;
        if (Array.isArray(v) && v.length === 0) return false;
        return true;
      });
      nextBtn.disabled = !allAnswered;
    }

    visibleQuestions.forEach(q => {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '48px';

      const qTitle = document.createElement('div');
      qTitle.className = 'ema-question';
      qTitle.textContent = q.text || '';
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
        // Slider needs an explicit interaction before we count it as answered
        let touched = cur !== undefined && cur !== null && cur !== '';
        slider.addEventListener('input', () => {
          touched = true;
          const v = Number(slider.value);
          disp.textContent = v + (q.unit ? ' ' + q.unit : '');
          recordResponse(q.id, v);
          checkSubmit();
        });
        // If pre-filled (resumption case), record it
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

    // Button label: "Submit" on last page of last phase, "Next" otherwise.
    const isLastPage  = currentPageIndex === emaPages.length - 1;
    const isLastPhase = sessionData.currentPhase === sessionData.phases.length - 1;
    nextBtn.textContent = (isLastPage && isLastPhase) ? 'Submit Check-In' : 'Next';

    container.classList.remove('fade-out', 'fade-in');
    void container.offsetWidth;
    container.classList.add('fade-in');
    setTimeout(() => container.classList.remove('fade-in'), 50);
  }

  document.getElementById('ema-next-btn').addEventListener('click', () => {
    const container = document.getElementById('ema-single-container');
    container.classList.add('fade-out');
    setTimeout(() => { currentPageIndex++; renderCurrentPage(); }, 300);
  });

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  return {
    // phaseToken must be "pre_<wid>" or "post_<wid>". The v1.3 router
    // never emits bare window ids. If you're calling this from new code,
    // use the prefixed form.
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
        // Legacy — should not occur from v1.3 router but we tolerate it
        // to keep imports of older session data rendering in preview.
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
        // Nothing to ask — mark submitted_at = started_at and move on
        emaResponses.submittedAt = emaResponses.startedAt;
        sessionData.data.push(emaResponses);
        advancePhase();
        return;
      }

      show('screen-ema');
      renderCurrentPage();
    }
  };
})();
