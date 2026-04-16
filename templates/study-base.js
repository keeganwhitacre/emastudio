"use strict";

// {{CONFIG_LOADER}}

// Set by compiler
const isPreview = window.__PREVIEW_MODE__ === true;

function show(id) { 
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); 
  document.getElementById(id).classList.add('active'); 
}

function evalCond(cond, responses) {
  if (!cond) return true;
  const val = responses[cond.question_id];
  if (val === undefined || val === null || val === '') return false;
  const cv = cond.value;
  switch(cond.operator) {
    case 'eq': return val == cv; case 'neq': return val != cv;
    case 'gt': return Number(val) > Number(cv); case 'gte': return Number(val) >= Number(cv);
    case 'lt': return Number(val) < Number(cv); case 'lte': return Number(val) <= Number(cv);
    case 'includes': { const arr = Array.isArray(cv)?cv:[cv]; const ans = Array.isArray(val)?val:[val]; return arr.some(v => ans.includes(v)); }
    default: return true;
  }
}

(async function() {
  const config = await loadConfig();
  const params = new URLSearchParams(window.location.search);
  
  document.getElementById('study-title').textContent = config.study.name || 'Study';
  document.getElementById('task-subtitle').textContent  = config.study.institution || '';
  
  // {{EXPIRY_CHECK}}
  // {{PREVIEW_SESSION_FORCE}}
  
  const sessionCfg = config.ema?.sessions?.find(s => s.id === sessionId) || { id: sessionId, label: sessionId };
  document.getElementById('ema-greeting').textContent = config.study.greetings?.[sessionCfg.greeting_key] || sessionCfg.label || 'Check-In';

  let sessionData = { 
    participantID: '', 
    session: sessionId, 
    startTime: null,
    endTime: null,
    responses: {}, 
    timestamps: {}, 
    patData: null 
  };
  
  let emaPages = [];
  let currentPageIndex = 0;

  // --- Auto-Save Caching Logic ---
  function getCacheKey() {
    return `ema_cache_${config.study.name.replace(/\s+/g,'')}_${sessionData.participantID}_${sessionId}`;
  }

  function saveCache() {
    if (isPreview) return;
    localStorage.setItem(getCacheKey(), JSON.stringify({ data: sessionData, page: currentPageIndex }));
  }

  function loadCache() {
    if (isPreview) return false;
    const c = localStorage.getItem(getCacheKey());
    if (c) {
      try {
        const parsed = JSON.parse(c);
        sessionData = parsed.data;
        currentPageIndex = parsed.page;
        return true;
      } catch(e) { return false; }
    }
    return false;
  }

  function clearCache() {
    if (!isPreview) localStorage.removeItem(getCacheKey());
  }

  // --- Initialization ---
  const pidInput = document.getElementById('pid-input');
  const startBtn = document.getElementById('start-btn');

  pidInput.addEventListener('input', () => { startBtn.disabled = !pidInput.value.trim(); });

  startBtn.addEventListener('click', () => {
    sessionData.participantID = pidInput.value.trim();
    
    const resumed = loadCache();
    if (!resumed) {
      sessionData.startTime = new Date().toISOString();
      currentPageIndex = 0;
    }
    
    startEMA();
  });

  // ==========================================================
  // EMA PAGINATION ENGINE
  // ==========================================================
  function buildPages() {
    emaPages = [];
    let currentBlock = [];
    config.ema.questions.forEach(q => {
      if (q.type === 'page_break') {
        if (currentBlock.length > 0) { emaPages.push(currentBlock); currentBlock = []; }
      } else {
        currentBlock.push(q);
      }
    });
    if (currentBlock.length > 0) emaPages.push(currentBlock);
  }

  function renderCurrentPage() {
    const container = document.getElementById('ema-single-container');
    const nextBtn = document.getElementById('ema-next-btn');
    
    // Fast-forward past pages where ALL questions are skipped by logic
    let visibleQuestions = [];
    while (currentPageIndex < emaPages.length) {
      visibleQuestions = emaPages[currentPageIndex].filter(q => evalCond(q.condition, sessionData.responses));
      if (visibleQuestions.length > 0) break;
      currentPageIndex++;
    }

    // If we've passed all EMA pages, move to Tasks or Submit
    if (currentPageIndex >= emaPages.length) {
      if (config.tasks && config.tasks.includes('pat') && window.ePATCore) {
        saveCache();
        startPATSession();
      } else {
        finalizeSession();
      }
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
        nextBtn.disabled = !visibleQuestions.every(q => !q.required || (sessionData.responses[q.id] !== undefined && sessionData.responses[q.id] !== ''));
      };

      if (q.type === 'slider') {
        const mid = ((q.min||0) + (q.max||100)) / 2;
        if (sessionData.responses[q.id] === undefined) sessionData.responses[q.id] = mid;
        
        const grp = document.createElement('div'); grp.className = 'slider-group';
        const valDisp = document.createElement('div'); valDisp.className = 'slider-val-display';
        valDisp.textContent = sessionData.responses[q.id] + (q.unit || '');
        
        const inp = document.createElement('input'); inp.type = 'range'; inp.className = 'range-slider';
        inp.min = q.min; inp.max = q.max; inp.step = q.step || 1; inp.value = sessionData.responses[q.id];
        
        inp.addEventListener('input', () => {
          sessionData.responses[q.id] = Number(inp.value);
          sessionData.timestamps[q.id] = new Date().toISOString();
          valDisp.textContent = inp.value + (q.unit || '');
          checkSubmit();
          saveCache();
        });

        const labels = document.createElement('div'); labels.className = 'slider-labels';
        labels.innerHTML = `<span>${q.anchors[0]||''}</span><span>${q.anchors[1]||''}</span>`;
        
        grp.append(valDisp, inp, labels);
        wrapper.appendChild(grp);
      } 
      else if (q.type === 'choice') {
        const grp = document.createElement('div'); grp.className = 'bubble-group';
        q.options.forEach(opt => {
          const b = document.createElement('div'); b.className = 'bubble'; b.textContent = opt;
          if (sessionData.responses[q.id] === opt) b.classList.add('selected');
          b.onclick = () => {
            grp.querySelectorAll('.bubble').forEach(x => x.classList.remove('selected'));
            b.classList.add('selected');
            sessionData.responses[q.id] = opt;
            sessionData.timestamps[q.id] = new Date().toISOString();
            checkSubmit();
            saveCache();
          };
          grp.appendChild(b);
        });
        wrapper.appendChild(grp);
      }
      else if (q.type === 'checkbox') {
        if (!Array.isArray(sessionData.responses[q.id])) sessionData.responses[q.id] = [];
        const grp = document.createElement('div'); grp.className = 'bubble-group';
        q.options.forEach(opt => {
          const b = document.createElement('div'); b.className = 'bubble'; b.textContent = opt;
          if (sessionData.responses[q.id].includes(opt)) b.classList.add('selected');
          b.onclick = () => {
            b.classList.toggle('selected');
            const arr = sessionData.responses[q.id];
            if (b.classList.contains('selected')) { if (!arr.includes(opt)) arr.push(opt); } 
            else { const i = arr.indexOf(opt); if (i>-1) arr.splice(i, 1); }
            sessionData.timestamps[q.id] = new Date().toISOString();
            checkSubmit();
            saveCache();
          };
          grp.appendChild(b);
        });
        wrapper.appendChild(grp);
      }
      else if (q.type === 'text' || q.type === 'numeric') {
        const grp = document.createElement('div'); grp.className = 'input-group';
        const inp = document.createElement('input'); 
        inp.type = q.type === 'numeric' ? 'number' : 'text';
        inp.placeholder = "Tap to answer";
        if (sessionData.responses[q.id] !== undefined) inp.value = sessionData.responses[q.id];
        
        inp.addEventListener('input', () => {
          sessionData.responses[q.id] = q.type === 'numeric' ? Number(inp.value) : inp.value;
          sessionData.timestamps[q.id] = new Date().toISOString();
          checkSubmit();
          saveCache();
        });
        grp.appendChild(inp);
        wrapper.appendChild(grp);
      }

      container.appendChild(wrapper);
      checkSubmit();
    });

    nextBtn.textContent = (currentPageIndex === emaPages.length - 1) && (!config.tasks || !config.tasks.includes('pat')) ? 'Submit Check-In' : 'Next';
    
    // Animation trigger
    container.classList.remove('fade-out', 'fade-in');
    void container.offsetWidth;
    container.classList.add('fade-in');
    setTimeout(() => container.classList.remove('fade-in'), 50);
  }

  function startEMA() {
    buildPages();
    show('screen-ema');
    renderCurrentPage();
  }

  document.getElementById('ema-next-btn').addEventListener('click', () => {
    const container = document.getElementById('ema-single-container');
    container.classList.add('fade-out');
    setTimeout(() => {
      currentPageIndex++;
      saveCache();
      renderCurrentPage();
    }, 300);
  });


  // ==========================================================
  // DATA EXPORT FORMATTING
  // ==========================================================
  function finalizeSession() {
    sessionData.endTime = new Date().toISOString();
    clearCache(); // Remove from local storage since it's complete

    if (isPreview) {
      document.getElementById('screen-end').querySelector('p').textContent = '✓ Preview complete. (No data downloaded in preview mode).'; 
      show('screen-end');
      return;
    }

    const fmt = config.study.output_format || 'json';
    let blob, filename;

    if (fmt === 'csv') {
      // Build Academic Long-Format CSV
      const rows = [['ParticipantID', 'Session', 'StartTime', 'EndTime', 'QuestionID', 'QuestionType', 'QuestionText', 'Response', 'Timestamp']];
      
      const qs = config.ema.questions.filter(q => q.type !== 'page_break');
      qs.forEach(q => { 
        if (sessionData.responses[q.id] !== undefined) {
          const resp = Array.isArray(sessionData.responses[q.id]) ? sessionData.responses[q.id].join('|') : sessionData.responses[q.id];
          const text = q.text.replace(/"/g, '""'); // Escape quotes for CSV
          rows.push([
            sessionData.participantID, 
            sessionData.session, 
            sessionData.startTime, 
            sessionData.endTime, 
            q.id, 
            q.type,
            `"${text}"`, 
            `"${resp}"`, 
            sessionData.timestamps[q.id] || ''
          ]); 
        } 
      });
      
      const csvStr = rows.map(r => r.join(',')).join('\n');
      blob = new Blob([csvStr], {type:'text/csv'});
      filename = `ema_${sessionData.participantID}_${sessionData.session}.csv`;
      
    } else {
      // Clean JSON Output
      const cleanJson = {
        study: config.study.name,
        participantID: sessionData.participantID,
        session: sessionData.session,
        startTime: sessionData.startTime,
        endTime: sessionData.endTime,
        data: config.ema.questions.filter(q => q.type !== 'page_break' && sessionData.responses[q.id] !== undefined).map(q => ({
          question_id: q.id,
          question_text: q.text,
          type: q.type,
          response: sessionData.responses[q.id],
          timestamp: sessionData.timestamps[q.id]
        })),
        tasks: sessionData.patData ? { pat: sessionData.patData } : {}
      };
      blob = new Blob([JSON.stringify(cleanJson, null, 2)], {type:'application/json'});
      filename = `ema_${sessionData.participantID}_${sessionData.session}.json`;
    }

    // Trigger Download
    const url = URL.createObjectURL(blob); 
    const a = document.createElement('a'); 
    a.href = url; a.download = filename; a.click(); 
    URL.revokeObjectURL(url);
    
    show('screen-end');
  }

  // ==========================================================
  // PAT SENSOR LOGIC (Stubbed to call finalizeSession when done)
  // ==========================================================
  async function startPATSession() {
    const core = window.ePATCore;
    if (!core) { finalizeSession(); return; }
    
    sessionData.patData = { completed: false, trials: [] };

    // Initialize UI and Core
    core.AudioEngine.init();
    await core.WakeLockCtrl.request();
    
    /* ... (The visual dial initialization remains the same as previously defined) ... */
    
    // For Prototype testing: fast forward PAT to end
    setTimeout(() => {
        sessionData.patData.completed = true;
        finalizeSession();
    }, 1500); 
  }

})();