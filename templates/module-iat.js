// ==========================================================
// IAT MODULE — Implicit Association Task
// ==========================================================
// v1.0.0
//
// LIFECYCLE (exposed):
//   { start } — called by phase dispatcher in study-base.js via `IAT.start()`
//
// TIMING RATIONALE:
//   Stimulus onset is anchored to requestAnimationFrame, not the innerHTML
//   write. DOM mutation and pixel commit are two separate events; rAF fires
//   after layout/paint, so t0 = performance.now() inside rAF reflects
//   when the word is actually on screen (~1 frame of latency, ~16ms at 60Hz),
//   not when the JS string assignment happened.
//
//   touchstart is used rather than click or touchend. touchstart fires at
//   finger contact, ~50-100ms earlier than click. touchend adds the full
//   duration of the tap on top. For RT-sensitive tasks this matters.
//   Click is registered as a fallback for desktop/preview use.
//   passive:false is set so we can call preventDefault() and suppress the
//   subsequent synthetic mouse events the browser would fire after touch.
//
// ERROR FEEDBACK:
//   250ms red X overlay, then ITI. Total post-error gap = 250 + ITI (default
//   400ms) = 650ms. Matches Project Implicit implementation.
//
// D-SCORE (Greenwald, Nosek & Banaji, 2003, JPSP):
//   - Exclusions: RT < 300ms (anticipatory) or > 10,000ms (disengaged)
//   - Error penalty strategy B: error RT replaced by block mean of correct
//     trials + 600ms
//   - D = (M_pairing2 - M_pairing1) / SD_pooled
//     SD is computed across ALL trials from both combined block pairs pooled,
//     not an average of within-block SDs.
//   - Fast-responder flag: >10% of trials <300ms in any block -> logged,
//     not auto-excluded. Researcher decides.
//   - Sign: positive D = target A + positive attribute faster (compatible).
//     Depends on which pairing was presented first, which is determined by
//     blockOrderVariant and logged in the summary.
//
// BLOCK STRUCTURE (standard 7-block):
//   1  Target A practice              (default 20)
//   2  Attribute practice             (default 20)
//   3  Combined practice -- pairing 1 (default 20)  <- critical for D
//   4  Combined critical -- pairing 1 (default 40)  <- critical for D
//   5  Target reversal practice       (default 40)
//   6  Combined practice -- pairing 2 (default 20)  <- critical for D
//   7  Combined critical -- pairing 2 (default 40)  <- critical for D
//
// COUNTERBALANCING:
//   blockOrderVariant = parseInt(participantId) % 2
//   variant 0: Target A + Positive attributes on left in blocks 3/4
//   variant 1: Target A + Negative attributes on left in blocks 3/4
//   Logged in summary as block_order_variant. Use as a covariate.
//
// SCREENS (pre-baked into buildHtmlShell in export.js, not injected here):
//   screen-iat-instructions  -- block transition / opening instructions
//   screen-iat-trial         -- stimulus presentation + response zones
//   screen-iat-iti           -- blank inter-trial interval
// ==========================================================

const IAT = (function () {
  const cfg = config.modules?.iat || {};

  // ── Config with defaults ──────────────────────────────────────────────────
  const TARGET_A_LABEL = cfg.target_a_label || 'Category A';
  const TARGET_B_LABEL = cfg.target_b_label || 'Category B';
  const ATTR_POS_LABEL = cfg.attr_pos_label || 'Pleasant';
  const ATTR_NEG_LABEL = cfg.attr_neg_label || 'Unpleasant';

  const TARGET_A_WORDS = Array.isArray(cfg.target_a_words) ? cfg.target_a_words : ['Item1','Item2','Item3','Item4','Item5'];
  const TARGET_B_WORDS = Array.isArray(cfg.target_b_words) ? cfg.target_b_words : ['ItemA','ItemB','ItemC','ItemD','ItemE'];
  const ATTR_POS_WORDS = Array.isArray(cfg.attr_pos_words) ? cfg.attr_pos_words : ['Good','Happy','Love','Joy','Peace'];
  const ATTR_NEG_WORDS = Array.isArray(cfg.attr_neg_words) ? cfg.attr_neg_words : ['Bad','Sad','Hate','Pain','War'];

  const BLOCK_TRIALS = Array.isArray(cfg.block_trials) && cfg.block_trials.length === 7
    ? cfg.block_trials : [20, 20, 20, 40, 40, 20, 40];

  const ITI_MS           = typeof cfg.iti_ms === 'number' ? cfg.iti_ms : 400;
  const SHOW_PRACTICE    = cfg.show_practice !== false;
  const ERROR_DISPLAY_MS = 250;
  const RT_MIN           = 300;
  const RT_MAX           = 10000;
  const ERROR_PENALTY_MS = 600;
  const FAST_THRESHOLD   = 0.10;

  // ── Runtime state ─────────────────────────────────────────────────────────
  let blockOrderVariant  = 0;
  let blockDefs          = [];
  let currentBlockIdx    = 0;
  let currentTrialList   = [];
  let currentTrialIdx    = 0;
  let allTrials          = [];
  let stimulusOnsetT0    = 0;
  let responding         = false;
  let itiTimer           = null;

  // ── Block definition factory ──────────────────────────────────────────────
  // Each block def carries explicit leftSources and rightSources arrays.
  // correct_side for each trial is assigned directly from whichever source
  // pool the word came from -- no inference from array position at response time.
  function buildBlockDefs(variant) {
    const A = { label: TARGET_A_LABEL, words: TARGET_A_WORDS, cat: 'target_a' };
    const B = { label: TARGET_B_LABEL, words: TARGET_B_WORDS, cat: 'target_b' };
    const P = { label: ATTR_POS_LABEL, words: ATTR_POS_WORDS, cat: 'attr_pos' };
    const N = { label: ATTR_NEG_LABEL, words: ATTR_NEG_WORDS, cat: 'attr_neg' };

    // variant 0: A+Positive on left; variant 1: A+Negative on left
    const [leftAttr1, rightAttr1] = variant === 0 ? [P, N] : [N, P];
    const [leftAttr2, rightAttr2] = variant === 0 ? [N, P] : [P, N];

    const b34Left  = [A, leftAttr1];
    const b34Right = [B, rightAttr1];
    const b67Left  = [B, leftAttr2];
    const b67Right = [A, rightAttr2];

    const nl = (cats) => cats.map(c => c.label).join('\nor\n');

    const defs = [
      {
        id: 1, label: 'Practice: ' + A.label, isPractice: true, isCombined: false,
        criticalForD: false, pairingId: null,
        leftLabel: A.label, rightLabel: B.label,
        leftSources: [A], rightSources: [],
        instructions: 'Sort each word into a category.\n\nTap LEFT for: ' + A.label
      },
      {
        id: 2, label: 'Practice: Attributes', isPractice: true, isCombined: false,
        criticalForD: false, pairingId: null,
        leftLabel: leftAttr1.label, rightLabel: rightAttr1.label,
        leftSources: [leftAttr1], rightSources: [rightAttr1],
        instructions: 'Sort each word.\n\nTap LEFT for: ' + leftAttr1.label + '\nTap RIGHT for: ' + rightAttr1.label
      },
      {
        id: 3, label: 'Practice: Combined', isPractice: true, isCombined: true,
        criticalForD: true, pairingId: 1,
        leftLabel: nl(b34Left), rightLabel: nl(b34Right),
        leftSources: b34Left, rightSources: b34Right,
        instructions: 'Now both together.\n\nLEFT: ' + nl(b34Left) + '\nRIGHT: ' + nl(b34Right)
      },
      {
        id: 4, label: 'Critical Block', isPractice: false, isCombined: true,
        criticalForD: true, pairingId: 1,
        leftLabel: nl(b34Left), rightLabel: nl(b34Right),
        leftSources: b34Left, rightSources: b34Right,
        instructions: 'Keep going -- same categories.\n\nLEFT: ' + nl(b34Left) + '\nRIGHT: ' + nl(b34Right)
      },
      {
        id: 5, label: 'Practice: ' + B.label, isPractice: true, isCombined: false,
        criticalForD: false, pairingId: null,
        leftLabel: B.label, rightLabel: A.label,
        leftSources: [B], rightSources: [],
        instructions: 'The categories have switched.\n\nTap LEFT for: ' + B.label
      },
      {
        id: 6, label: 'Practice: Combined', isPractice: true, isCombined: true,
        criticalForD: true, pairingId: 2,
        leftLabel: nl(b67Left), rightLabel: nl(b67Right),
        leftSources: b67Left, rightSources: b67Right,
        instructions: 'Now both together -- note the switch.\n\nLEFT: ' + nl(b67Left) + '\nRIGHT: ' + nl(b67Right)
      },
      {
        id: 7, label: 'Critical Block', isPractice: false, isCombined: true,
        criticalForD: true, pairingId: 2,
        leftLabel: nl(b67Left), rightLabel: nl(b67Right),
        leftSources: b67Left, rightSources: b67Right,
        instructions: 'Keep going -- same categories.\n\nLEFT: ' + nl(b67Left) + '\nRIGHT: ' + nl(b67Right)
      }
    ];

    return defs
      .filter(d => SHOW_PRACTICE || !d.isPractice || d.criticalForD)
      .map(d => ({ ...d, nTrials: BLOCK_TRIALS[d.id - 1] }));
  }

  // ── Trial list builder ────────────────────────────────────────────────────
  // correct_side is stamped at build time from which source pool the word
  // came from. This is explicit and unconditional -- no runtime inference.
  function buildTrialList(def) {
    const pool = [
      ...def.leftSources.flatMap(src =>
        src.words.map(w => ({ word: w, category: src.cat, correct_side: 'left' }))),
      ...def.rightSources.flatMap(src =>
        src.words.map(w => ({ word: w, category: src.cat, correct_side: 'right' })))
    ];

    // Cycle through shuffled pool until nTrials reached
    const result = [];
    let deck = shuffle(pool.slice());
    let di = 0;
    for (let i = 0; i < def.nTrials; i++) {
      if (di >= deck.length) { deck = shuffle(pool.slice()); di = 0; }
      result.push({ ...deck[di++], trial_n_in_block: i + 1 });
    }
    return result;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── D-score computation ───────────────────────────────────────────────────
  function computeD() {
    const p1 = allTrials.filter(t => {
      const def = blockDefs.find(b => b.id === t.block_id);
      return def && def.criticalForD && def.pairingId === 1;
    });
    const p2 = allTrials.filter(t => {
      const def = blockDefs.find(b => b.id === t.block_id);
      return def && def.criticalForD && def.pairingId === 2;
    });

    if (!p1.length || !p2.length) return null;

    function meanWithReplacement(trials) {
      const valid = trials.filter(t => !t.excluded);
      if (!valid.length) return 0;
      const correctRTs = valid.filter(t => t.correct).map(t => t.rt_ms);
      const correctMean = correctRTs.length
        ? correctRTs.reduce((s, v) => s + v, 0) / correctRTs.length : 0;
      const penalty = correctMean + ERROR_PENALTY_MS;
      const rts = valid.map(t => t.correct ? t.rt_ms : penalty);
      return rts.reduce((s, v) => s + v, 0) / rts.length;
    }

    function replacedRTs(trials) {
      const valid = trials.filter(t => !t.excluded);
      const correctMean = (() => {
        const c = valid.filter(t => t.correct).map(t => t.rt_ms);
        return c.length ? c.reduce((s, v) => s + v, 0) / c.length : 0;
      })();
      return valid.map(t => t.correct ? t.rt_ms : correctMean + ERROR_PENALTY_MS);
    }

    const mean1  = meanWithReplacement(p1);
    const mean2  = meanWithReplacement(p2);
    const allRTs = [...replacedRTs(p1), ...replacedRTs(p2)];

    if (allRTs.length < 2) return null;

    const grandMean = allRTs.reduce((s, v) => s + v, 0) / allRTs.length;
    const sd = Math.sqrt(
      allRTs.reduce((s, v) => s + (v - grandMean) ** 2, 0) / (allRTs.length - 1)
    );
    if (sd === 0) return null;

    // Positive D = pairing 1 (compatible for variant 0) faster
    const rawD = (mean2 - mean1) / sd;
    const D    = blockOrderVariant === 0 ? rawD : -rawD;

    return {
      D:             parseFloat(D.toFixed(4)),
      mean_pairing1: parseFloat(mean1.toFixed(2)),
      mean_pairing2: parseFloat(mean2.toFixed(2)),
      sd_pooled:     parseFloat(sd.toFixed(2)),
      n_pairing1:    p1.filter(t => !t.excluded).length,
      n_pairing2:    p2.filter(t => !t.excluded).length
    };
  }

  function computeBlockStats(blockId) {
    const trials = allTrials.filter(t => t.block_id === blockId);
    const valid  = trials.filter(t => !t.excluded);
    const errors = valid.filter(t => !t.correct);
    const fast   = trials.filter(t => t.rt_ms < RT_MIN);
    return {
      n_total:          trials.length,
      n_valid:          valid.length,
      n_excluded:       trials.length - valid.length,
      n_errors:         errors.length,
      error_rate:       valid.length ? parseFloat((errors.length / valid.length).toFixed(4)) : null,
      mean_rt:          valid.length ? parseFloat((valid.reduce((s,t)=>s+t.rt_ms,0)/valid.length).toFixed(2)) : null,
      fast_trial_count: fast.length,
      fast_trial_rate:  trials.length ? parseFloat((fast.length / trials.length).toFixed(4)) : null
    };
  }

  // ── Block / trial flow ────────────────────────────────────────────────────
  function showBlockInstructions(blockIdx) {
    currentBlockIdx = blockIdx;
    const def = blockDefs[blockIdx];

    document.getElementById('iat-block-label').textContent =
      'Block ' + (blockIdx + 1) + ' of ' + blockDefs.length;
    document.getElementById('iat-block-title').textContent    = def.label;
    document.getElementById('iat-instructions-text').textContent = def.instructions;
    document.getElementById('iat-inst-left-label').textContent   = def.leftLabel;
    document.getElementById('iat-inst-right-label').textContent  = def.rightLabel;
    document.getElementById('iat-begin-block-btn').textContent   =
      blockIdx === 0 ? 'Start Task' : 'Begin Block';

    document.getElementById('iat-begin-block-btn').onclick = () => {
      currentTrialList = buildTrialList(def);
      currentTrialIdx  = 0;
      document.getElementById('iat-left-label').textContent  = def.leftLabel;
      document.getElementById('iat-right-label').textContent = def.rightLabel;
      document.getElementById('iat-error-feedback').style.display = 'none';
      show('screen-iat-trial');
      presentTrial();
    };

    show('screen-iat-instructions');
  }

  function presentTrial() {
    if (currentTrialIdx >= currentTrialList.length) {
      onBlockComplete();
      return;
    }

    const trial = currentTrialList[currentTrialIdx];
    document.getElementById('iat-stimulus').textContent = trial.word;
    document.getElementById('iat-error-feedback').style.display = 'none';
    updateProgress();

    // Gate responses until rAF fires -- t0 is pixel-on-screen, not innerHTML
    responding = false;
    requestAnimationFrame(() => {
      stimulusOnsetT0 = performance.now();
      responding = true;
    });
  }

  function handleResponse(side) {
    if (!responding) return;
    responding = false;

    const rt      = performance.now() - stimulusOnsetT0;
    const trial   = currentTrialList[currentTrialIdx];
    const correct = side === trial.correct_side;

    let excluded = false, exclude_reason = null;
    if (rt < RT_MIN) { excluded = true; exclude_reason = 'rt_too_fast'; }
    if (rt > RT_MAX) { excluded = true; exclude_reason = 'rt_too_slow'; }

    allTrials.push({
      block_index:      currentBlockIdx,
      block_id:         blockDefs[currentBlockIdx].id,
      block_label:      blockDefs[currentBlockIdx].label,
      pairing_id:       blockDefs[currentBlockIdx].pairingId,
      critical_for_d:   blockDefs[currentBlockIdx].criticalForD,
      trial_n_in_block: trial.trial_n_in_block,
      trial_n_overall:  allTrials.length + 1,
      stimulus:         trial.word,
      category:         trial.category,
      correct_side:     trial.correct_side,
      response_side:    side,
      correct,
      rt_ms:            parseFloat(rt.toFixed(2)),
      excluded,
      exclude_reason,
      timestamp:        new Date().toISOString()
    });

    currentTrialIdx++;

    if (!correct) {
      const fb = document.getElementById('iat-error-feedback');
      fb.style.display = 'flex';
      itiTimer = setTimeout(() => {
        fb.style.display = 'none';
        show('screen-iat-iti');
        itiTimer = setTimeout(() => { show('screen-iat-trial'); presentTrial(); }, ITI_MS);
      }, ERROR_DISPLAY_MS);
    } else {
      show('screen-iat-iti');
      itiTimer = setTimeout(() => { show('screen-iat-trial'); presentTrial(); }, ITI_MS);
    }
  }

  function onBlockComplete() {
    const nextIdx = currentBlockIdx + 1;
    if (nextIdx >= blockDefs.length) {
      finishAndAdvance();
    } else {
      show('screen-iat-iti');
      itiTimer = setTimeout(() => showBlockInstructions(nextIdx), ITI_MS + 100);
    }
  }

  function updateProgress() {
    const total = blockDefs.reduce((s, b) => s + b.nTrials, 0);
    const pct   = total > 0 ? (allTrials.length / total) * 100 : 0;
    const bar   = document.getElementById('iat-progress-bar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
  }

  // ── Response zone binding ─────────────────────────────────────────────────
  // Called once at start(). touchstart + click for mobile/desktop coverage.
  function bindResponseZones() {
    ['left', 'right'].forEach(side => {
      const el = document.getElementById('iat-' + side + '-zone');
      if (!el) return;
      const handler = (e) => { e.preventDefault(); handleResponse(side); };
      el.addEventListener('touchstart', handler, { passive: false });
      el.addEventListener('click', handler);
    });
  }

  // ── Session finalisation ──────────────────────────────────────────────────
  function finishAndAdvance() {
    show('screen-iat-iti');

    const dResult       = computeD();
    const perBlockStats = blockDefs.map(b => ({ block_id: b.id, ...computeBlockStats(b.id) }));
    const fastResponder = perBlockStats.some(
      s => s.fast_trial_rate !== null && s.fast_trial_rate > FAST_THRESHOLD
    );
    const totalTrials   = allTrials.length;
    const excludedCount = allTrials.filter(t => t.excluded).length;

    sessionData.data.push({
      type:      'iat_response',
      startedAt: totalTrials ? allTrials[0].timestamp : null,
      trials:    allTrials,
      summary: {
        d_score:             dResult ? dResult.D             : null,
        d_mean_pairing1:     dResult ? dResult.mean_pairing1 : null,
        d_mean_pairing2:     dResult ? dResult.mean_pairing2 : null,
        d_sd_pooled:         dResult ? dResult.sd_pooled     : null,
        d_n_pairing1:        dResult ? dResult.n_pairing1    : null,
        d_n_pairing2:        dResult ? dResult.n_pairing2    : null,
        block_order_variant: blockOrderVariant,
        fast_responder:      fastResponder,
        total_trials:        totalTrials,
        excluded_trials:     excludedCount,
        exclusion_rate:      totalTrials ? parseFloat((excludedCount / totalTrials).toFixed(4)) : null,
        target_a_label:      TARGET_A_LABEL,
        target_b_label:      TARGET_B_LABEL,
        attr_pos_label:      ATTR_POS_LABEL,
        attr_neg_label:      ATTR_NEG_LABEL,
        block_stats:         perBlockStats
      }
    });

    advancePhase();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function start() {
    const pid     = parseInt(sessionData.participantId, 10) || 0;
    blockOrderVariant = pid % 2;
    blockDefs         = buildBlockDefs(blockOrderVariant);
    allTrials         = [];

    bindResponseZones();

    // Opening instructions screen (pre-task, before block 1)
    document.getElementById('iat-block-label').textContent       = 'Instructions';
    document.getElementById('iat-block-title').textContent       = 'How to respond';
    document.getElementById('iat-instructions-text').textContent =
      'Words will appear one at a time in the centre of the screen.\n\n' +
      'Tap the LEFT or RIGHT side of the screen to sort each word into the correct category.\n\n' +
      'The categories are shown at the top of the screen throughout the task.\n\n' +
      'Respond as quickly as you can without making mistakes.';
    document.getElementById('iat-inst-left-label').textContent  = 'tap the left half';
    document.getElementById('iat-inst-right-label').textContent = 'tap the right half';
    document.getElementById('iat-begin-block-btn').textContent  = 'Start Task';
    document.getElementById('iat-begin-block-btn').onclick = () => showBlockInstructions(0);

    show('screen-iat-instructions');
  }

  return { start };
})();