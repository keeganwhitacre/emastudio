// ==========================================================
// EMA PAGINATION ENGINE
// ==========================================================
const EMA = (function() {
  let emaPages = [];
  let currentPageIndex = 0;
  let emaResponses = { type: "ema_response", responses: {} };

  function buildPages() {
    emaPages = []; let currentBlock = [];
    config.ema.questions.forEach(q => {
      if (q.type === 'page_break') {
        if (currentBlock.length > 0) { emaPages.push(currentBlock); currentBlock = []; }
      } else { currentBlock.push(q); }
    });
    if (currentBlock.length > 0) emaPages.push(currentBlock);
  }

  function renderCurrentPage() {
    const container = document.getElementById('ema-single-container');
    const nextBtn = document.getElementById('ema-next-btn');
    
    // Fast-forward past pages where ALL questions are skipped by conditional logic
    let visibleQuestions = [];
    while (currentPageIndex < emaPages.length) {
      visibleQuestions = emaPages[currentPageIndex].filter(q => evalCond(q.condition, emaResponses.responses));
      if (visibleQuestions.length > 0) break;
      currentPageIndex++;
    }

    if (currentPageIndex >= emaPages.length) {
      sessionData.data.push(emaResponses);
      advancePhase();
      return;
    }

    const pct = Math.round(((currentPageIndex + 1) / emaPages.length) * 100);
    document.getElementById('ema-progress-fill').style.width = pct + '%';
    container.innerHTML = '';

    visibleQuestions.forEach(q => {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '48px';
      
      const qTitle = document.createElement('div');
      qTitle.className = 'ema-question';
      qTitle.textContent = q.text;
      wrapper.appendChild(qTitle);

      const checkSubmit = () => {
        nextBtn.disabled = !visibleQuestions.every(q => !q.required || (emaResponses.responses[q.id] !== undefined && emaResponses.responses[q.id] !== ''));
      };

      if (q.type === 'slider') {
        const mid = ((q.min||0) + (q.max||100)) / 2;
        if (emaResponses.responses[q.id] === undefined) emaResponses.responses[q.id] = mid;
        
        const grp = document.createElement('div'); grp.className = 'slider-group';
        const valDisp = document.createElement('div'); valDisp.className = 'slider-val-display';
        valDisp.textContent = emaResponses.responses[q.id] + (q.unit || '');
        
        const inp = document.createElement('input'); inp.type = 'range'; inp.className = 'range-slider';
        inp.min = q.min; inp.max = q.max; inp.step = q.step || 1; inp.value = emaResponses.responses[q.id];
        
        inp.addEventListener('input', () => {
          emaResponses.responses[q.id] = Number(inp.value);
          valDisp.textContent = inp.value + (q.unit || '');
          checkSubmit();
        });

        const labels = document.createElement('div'); labels.className = 'slider-labels';
        labels.innerHTML = `<span>${q.anchors[0]||''}</span><span>${q.anchors[1]||''}</span>`;
        grp.append(valDisp, inp, labels); wrapper.appendChild(grp);
      } 
      else if (q.type === 'choice') {
        const grp = document.createElement('div'); grp.className = 'bubble-group';
        q.options.forEach(opt => {
          const b = document.createElement('div'); b.className = 'bubble'; b.textContent = opt;
          if (emaResponses.responses[q.id] === opt) b.classList.add('selected');
          b.onclick = () => {
            grp.querySelectorAll('.bubble').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected'); emaResponses.responses[q.id] = opt; checkSubmit();
          };
          grp.appendChild(b);
        });
        wrapper.appendChild(grp);
      }
      else if (q.type === 'checkbox') {
        if (!Array.isArray(emaResponses.responses[q.id])) emaResponses.responses[q.id] = [];
        const grp = document.createElement('div'); grp.className = 'bubble-group';
        q.options.forEach(opt => {
          const b = document.createElement('div'); b.className = 'bubble'; b.textContent = opt;
          if (emaResponses.responses[q.id].includes(opt)) b.classList.add('selected');
          b.onclick = () => {
            b.classList.toggle('selected');
            const arr = emaResponses.responses[q.id];
            if (b.classList.contains('selected')) { if (!arr.includes(opt)) arr.push(opt); } 
            else { const i = arr.indexOf(opt); if (i>-1) arr.splice(i, 1); }
            checkSubmit();
          };
          grp.appendChild(b);
        });
        wrapper.appendChild(grp);
      }
      else if (q.type === 'text' || q.type === 'numeric') {
        const grp = document.createElement('div'); grp.className = 'input-group';
        const inp = document.createElement('input'); 
        inp.type = q.type === 'numeric' ? 'number' : 'text'; inp.placeholder = "Tap to answer";
        if (emaResponses.responses[q.id] !== undefined) inp.value = emaResponses.responses[q.id];
        inp.addEventListener('input', () => { emaResponses.responses[q.id] = q.type === 'numeric' ? Number(inp.value) : inp.value; checkSubmit(); });
        grp.appendChild(inp); wrapper.appendChild(grp);
      }

      container.appendChild(wrapper); checkSubmit();
    });

    nextBtn.textContent = (currentPageIndex === emaPages.length - 1) && (!config.tasks || !config.tasks.includes('pat') || sessionData.currentPhase === sessionData.phases.length - 1) ? 'Submit Check-In' : 'Next';
    
    container.classList.remove('fade-out', 'fade-in');
    void container.offsetWidth; container.classList.add('fade-in');
    setTimeout(() => container.classList.remove('fade-in'), 50);
  }

  document.getElementById('ema-next-btn').addEventListener('click', () => {
    const container = document.getElementById('ema-single-container');
    container.classList.add('fade-out');
    setTimeout(() => { currentPageIndex++; renderCurrentPage(); }, 300);
  });

  return {
    start(phaseId) {
      emaResponses = { type: "ema_response", phase: phaseId, responses: {} };
      
      const cleanEmaId = phaseId.replace('pair_','').replace('ema','');
      const sessionCfg = config.ema?.sessions?.find(s => s.id === cleanEmaId) || { greeting_key: 'afternoon' };
      document.getElementById('ema-greeting').textContent = config.study.greetings?.[sessionCfg.greeting_key] || 'Check-In';

      buildPages(); currentPageIndex = 0;
      show('screen-ema'); renderCurrentPage();
    }
  };
})();