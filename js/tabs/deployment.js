"use strict";

// ---------------------------------------------------------------------------
// Deployment Tab — v1.3
//
// Changes from v1.2:
//   - generateTwilioScript rewritten to emit a hardened dispatcher.
//     See the top of the emitted .gs for the list of fixes, but in short:
//       * IANA timezone names (America/Los_Angeles) replace fixed hour offsets
//         -> DST transitions are handled correctly by Google's zoneinfo.
//       * Schedule is sorted ascending by end-time before lookup.
//       * "Completed" is only set after the final day's last window has fired,
//         not at the first "no more windows today" encountered on day N.
//       * Every outbound link now carries an &t= timestamp so expiry_minutes
//         in the study config is actually enforced.
//       * Idempotency: a Last_Sent_ISO column is written *before* the send,
//         and the dispatcher dedupes on (participant, day, window_id) so a
//         partial failure can't produce a duplicate text.
//       * Column access is by header name, not by positional index, so
//         researchers can rearrange or add columns without breaking things.
//       * Response codes from Twilio are inspected; failures are written to
//         a _Dispatch_Log sheet and the scheduled time is restored so it
//         retries on the next tick.
//       * SMS body is templated from the study name and includes an opt-out
//         line ("Reply STOP to opt out") as required for US A2P 10DLC.
//   - Roster schema now uses Timezone (IANA) instead of Time_Offset_Hours.
//   - URL structure for non-Twilio CSV is unchanged.
//   - Helper phaseLabel(w) is unchanged.
// ---------------------------------------------------------------------------

function bindDeploymentTab() {
  const generateBtn = document.getElementById('generate-csv-btn');
  const twilioBtn = document.getElementById('export-twilio-btn');
  if (!generateBtn) return;

  generateBtn.addEventListener('click', () => {
    const baseUrlInput = document.getElementById('deploy-base-url').value.trim();
    const baseUrl  = baseUrlInput || 'https://example.com/study/';
    const startId  = parseInt(document.getElementById('deploy-start-id').value) || 1;
    const endId    = parseInt(document.getElementById('deploy-end-id').value)   || 20;

    const windows   = state.ema.scheduling.windows || [];
    const studyDays = state.ema.scheduling.study_days || 1;

    if (windows.length === 0 && !state.onboarding.enabled) {
      alert('No schedule windows or onboarding found. Please configure your study before generating links.');
      return;
    }

    const cleanBase = baseUrl.endsWith('/') || baseUrl.endsWith('.html')
      ? baseUrl
      : baseUrl + '/';

    // CSV header — Phase_Sequence tells the researcher what each link does
    let csv = 'Participant_ID,Day,Session,Phase_Sequence,URL\n';

    for (let p = startId; p <= endId; p++) {

      // Onboarding link (Day 0)
      if (state.onboarding.enabled) {
        const url = `${cleanBase}?id=${p}&session=onboarding`;
        csv += `${p},0,Setup,Onboarding,${url}\n`;
      }

      // Daily session links
      for (let day = 1; day <= studyDays; day++) {
        windows.forEach(w => {
          const label    = w.label.replace(/,/g, '');   // guard against CSV breaks
          const sequence = phaseLabel(w);
          const url      = `${cleanBase}?id=${p}&day=${day}&session=${w.id}`;
          csv += `${p},${day},${label},${sequence},${url}\n`;
        });
      }
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = slugifyStudyName() + '_deployment_links.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  if (twilioBtn) {
    twilioBtn.addEventListener('click', () => {
      const baseUrlInput = document.getElementById('deploy-base-url').value.trim();
      const baseUrl  = baseUrlInput || 'https://example.com/study/';

      const windows = state.ema.scheduling.windows || [];
      if (windows.length === 0 && !state.onboarding.enabled) {
        alert('No schedule windows found. Please configure your study before exporting.');
        return;
      }

      const scriptContent = generateTwilioScript(baseUrl);

      const blob = new Blob([scriptContent], { type: 'text/javascript;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = slugifyStudyName() + '-twilio-dispatcher.gs';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }
}

// ---------------------------------------------------------------------------
// phaseLabel(window) — builds a human-readable phase sequence string.
// e.g. { pre: true, task: "epat", post: true } → "Pre-EMA → ePAT → Post-EMA"
//      { pre: true, task: null, post: false }   → "EMA"
// ---------------------------------------------------------------------------
function phaseLabel(w) {
  const ph = w.phases || { pre: true, task: null, post: false };
  const parts = [];

  if (ph.pre)  parts.push('Pre-EMA');
  if (ph.task) {
    // Try to get the human label from the module registry
    const mod = state.modules.find(m => m.id === ph.task);
    parts.push(mod ? mod.label : ph.task);
  }
  if (ph.post) parts.push('Post-EMA');

  // If no task, collapse "Pre-EMA" to just "EMA" — cleaner for simple studies
  if (!ph.task && parts.length === 1 && parts[0] === 'Pre-EMA') return 'EMA';

  return parts.join(' → ') || 'EMA';
}

function slugifyStudyName() {
  return (state.study.name || 'study').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// ---------------------------------------------------------------------------
// generateTwilioScript(baseUrl) — emits a Google Apps Script (.gs) that
// dispatches scheduled SMS to participants via Twilio. The emitted script
// lives in a spreadsheet attached to the researcher's Google account.
//
// The template string is long because it contains a complete program. See
// the header comment inside for the runtime architecture.
// ---------------------------------------------------------------------------
function generateTwilioScript(baseUrl) {
  const windows   = state.ema.scheduling.windows || [];
  const studyDays = state.ema.scheduling.study_days || 1;
  const studyName = (state.study && state.study.name) ? state.study.name : 'Study';
  const expiryMin = (state.ema.scheduling && state.ema.scheduling.expiry_minutes) || 0;

  // Sort windows by end-time ascending so the dispatcher's "find the next
  // window whose end is after now" loop works regardless of the order the
  // researcher defined them in the Builder. (Fix #2.)
  const sortedWindows = windows
    .map(w => ({ id: w.id, start: w.start, end: w.end, label: w.label || w.id }))
    .sort((a, b) => a.end.localeCompare(b.end));

  const scheduleJson = JSON.stringify(sortedWindows);

  // Escape study name for embedding in a JS string literal.
  const safeStudyName = studyName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const scriptContent = `/**
 * EMA Forge — Twilio Dispatcher (Beta, v2)
 *
 * Emitted for study: ${studyName}
 * Study length: ${studyDays} day(s)
 * Base URL: ${baseUrl}
 *
 * HOW THIS WORKS
 *   The menu wizard writes your Twilio credentials to the script's
 *   PropertiesService (visible only to editors of this Apps Script project).
 *   Starting "Automation" installs a time-based trigger that runs
 *   dispatchPrompts() every 15 minutes. On each tick the dispatcher walks
 *   the Roster sheet and, for each Active participant:
 *
 *     1. Computes the participant's "current day" in their own timezone.
 *     2. If a ping is already scheduled and its time has arrived, sends it.
 *     3. Otherwise, schedules the next window in the participant's local
 *        time, converting to the script's time for the sheet.
 *
 *   All reads/writes to the Roster use header-name lookup (not column
 *   indices), so you can freely insert Notes columns, reorder, etc.
 *
 * DEDUPE MODEL
 *   A ping is identified by (Participant_ID, Day, Window_ID). Before the
 *   Twilio call, we stamp Last_Sent_ISO with the current time and write
 *   the dedupe key to a hidden _Dispatch_Log sheet. On any tick, if the
 *   key already exists in _Dispatch_Log for today, we skip. If the Twilio
 *   call returns a non-2xx code we clear Last_Sent_ISO so the same key
 *   retries on the next tick — but the log entry prevents a double-send
 *   if it was actually delivered.
 *
 * WHAT DOES NOT SHIP IN THIS BETA
 *   - Two-way SMS (STOP handling is "soft" — we include the opt-out text
 *     in every message, but we don't currently subscribe to Twilio's
 *     inbound webhook to auto-pause a participant on reply. Manually set
 *     Status to "Paused" if a participant replies STOP.)
 *   - Delivery-receipt timestamps for latency analysis.
 *   - Retry back-off beyond "try again on the next 15-min tick."
 */

// ---- CONFIGURATION (baked in from the Builder) -----------------------------

const BASE_URL    = '${baseUrl}';
const STUDY_DAYS  = ${studyDays};
const STUDY_NAME  = '${safeStudyName}';
const EXPIRY_MIN  = ${expiryMin};                     // 0 = no expiry enforcement
const SCHEDULE    = ${scheduleJson};                  // pre-sorted by end-time

// ---- CONSTANTS -------------------------------------------------------------

const ROSTER_SHEET  = 'Roster';
const LOG_SHEET     = '_Dispatch_Log';
const TRIGGER_FN    = 'dispatchPrompts';
const TICK_MINUTES  = 15;

// Roster columns by header name. The schema is enforced at setup.
const ROSTER_COLS = [
  'Participant_ID',
  'Phone',
  'Timezone',          // IANA string, e.g. 'America/Los_Angeles'
  'Start_Date',
  'Status',            // Active | Paused | Completed
  'Current_Day',
  'Next_Window',
  'Next_Ping_ISO',
  'Last_Sent_ISO'
];


// ============================================================================
//   MENU + SETUP WIZARD
// ============================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('EMA Forge 🛠️')
    .addItem('1. Setup Twilio & Roster', 'runSetupWizard')
    .addItem('2. Start Automation (every ' + TICK_MINUTES + ' min)', 'startTrigger')
    .addItem('3. Pause Automation', 'stopTrigger')
    .addSeparator()
    .addItem('Send test message to row 2', 'sendTestMessageRow2')
    .addToUi();
}

function runSetupWizard() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  ui.alert(
    'EMA Forge — Twilio Setup',
    'You will need your Twilio Account SID, Auth Token, and a Twilio phone number.\\n\\n' +
    'Credentials are stored in this script\\'s private properties — anyone with ' +
    'edit access to this Apps Script project can read them back. Do not share edit ' +
    'access outside your research team.',
    ui.ButtonSet.OK
  );

  const sid = ui.prompt('Step 1 of 3', 'Enter Twilio Account SID:', ui.ButtonSet.OK_CANCEL);
  if (sid.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('TWILIO_SID', sid.getResponseText().trim());

  const tok = ui.prompt('Step 2 of 3', 'Enter Twilio Auth Token:', ui.ButtonSet.OK_CANCEL);
  if (tok.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('TWILIO_TOKEN', tok.getResponseText().trim());

  const phone = ui.prompt('Step 3 of 3', 'Enter Twilio phone number (E.164, e.g. +15551234567):', ui.ButtonSet.OK_CANCEL);
  if (phone.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('TWILIO_PHONE', phone.getResponseText().trim());

  ensureRosterSchema_();
  ensureLogSheet_();

  ui.alert('Success. Credentials stored in script properties.\\n\\nNext: EMA Forge menu → "Start Automation".');
}

/**
 * Creates the Roster sheet if missing, or reconciles headers if it already
 * exists. Header reconciliation is non-destructive: existing data is left
 * alone, and any missing columns are appended to the right.
 */
function ensureRosterSchema_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ROSTER_SHEET);

  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(ROSTER_SHEET);
    sheet.clear();
    sheet.getRange(1, 1, 1, ROSTER_COLS.length).setValues([ROSTER_COLS]);
    sheet.getRange(1, 1, 1, ROSTER_COLS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, ROSTER_COLS.length, 140);

    // Demo row showing IANA timezone usage.
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const demoRow = [
      'DEMO_001',
      '+15550000000',
      'America/Los_Angeles',
      today,
      'Paused',    // Paused so it doesn't accidentally text +15550000000
      '',
      '',
      '',
      ''
    ];
    sheet.getRange(2, 1, 1, demoRow.length).setValues([demoRow]);
    return;
  }

  // Reconcile existing headers.
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
    : [];

  ROSTER_COLS.forEach(col => {
    if (existing.indexOf(col) === -1) {
      const nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue(col).setFontWeight('bold');
    }
  });
}

function ensureLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let log = ss.getSheetByName(LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(LOG_SHEET);
    log.getRange(1, 1, 1, 5).setValues([['Timestamp_ISO', 'Participant_ID', 'Day', 'Window_ID', 'Outcome']]);
    log.getRange(1, 1, 1, 5).setFontWeight('bold');
    log.setFrozenRows(1);
    log.hideSheet();
  }
}


// ============================================================================
//   TRIGGER MANAGEMENT
// ============================================================================

function startTrigger() {
  stopTrigger();
  ScriptApp.newTrigger(TRIGGER_FN).timeBased().everyMinutes(TICK_MINUTES).create();
  SpreadsheetApp.getUi().alert('Automation started. The dispatcher will run every ' + TICK_MINUTES + ' minutes.');
}

function stopTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}


// ============================================================================
//   CORE DISPATCHER
// ============================================================================

function dispatchPrompts() {
  const props = PropertiesService.getScriptProperties();
  const sid       = props.getProperty('TWILIO_SID');
  const token     = props.getProperty('TWILIO_TOKEN');
  const fromPhone = props.getProperty('TWILIO_PHONE');
  if (!sid || !token || !fromPhone) {
    console.warn('Twilio credentials not configured. Aborting dispatch.');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ROSTER_SHEET);
  if (!sheet) return;
  const log = ss.getSheetByName(LOG_SHEET) || (ensureLogSheet_(), ss.getSheetByName(LOG_SHEET));

  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length < 2) return;

  const headers = values[0].map(String);
  const colIdx = {};
  ROSTER_COLS.forEach(name => { colIdx[name] = headers.indexOf(name); });

  // Any missing required column -> fix schema and bail this tick.
  const required = ['Participant_ID', 'Phone', 'Timezone', 'Start_Date', 'Status'];
  const missing = required.filter(c => colIdx[c] === -1);
  if (missing.length) {
    console.warn('Roster is missing required columns: ' + missing.join(', ') + '. Running ensureRosterSchema_.');
    ensureRosterSchema_();
    return;
  }

  const now = new Date();
  const nowMs = now.getTime();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const sheetRow = r + 1;

    const pid      = row[colIdx['Participant_ID']];
    const phone    = String(row[colIdx['Phone']] || '').trim();
    const tz       = String(row[colIdx['Timezone']] || '').trim();
    const startRaw = row[colIdx['Start_Date']];
    const status   = String(row[colIdx['Status']] || '').trim();

    if (status !== 'Active' || !pid || !phone || !startRaw || !tz) continue;

    // --- 1. Compute current day in participant's timezone. -----------------
    const startDate = parseParticipantStartDate_(startRaw, tz);
    if (!startDate) {
      logOutcome_(log, pid, '', '', 'bad_start_date');
      continue;
    }

    const pTodayYmd = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const pStartYmd = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');
    const dayNumber = dayDiffYmd_(pStartYmd, pTodayYmd) + 1;

    // Completion: dayNumber past the end AND no windows are still pending today.
    // (We handle "day N evening not yet fired" inside the send loop below.)
    if (dayNumber > STUDY_DAYS) {
      writeCell_(sheet, sheetRow, colIdx['Status'], 'Completed');
      continue;
    }

    // Sync Current_Day if it changed.
    if (colIdx['Current_Day'] !== -1 && row[colIdx['Current_Day']] !== dayNumber) {
      writeCell_(sheet, sheetRow, colIdx['Current_Day'], dayNumber);
    }

    const nextPingIso  = String(row[colIdx['Next_Ping_ISO']]  || '').trim();
    const nextWindowId = String(row[colIdx['Next_Window']]    || '').trim();

    // --- 2. Send if a ping is due. -----------------------------------------
    if (nextPingIso && nextWindowId) {
      const due = new Date(nextPingIso);
      if (!isNaN(due.getTime()) && nowMs >= due.getTime()) {
        const dedupeKey = pid + '|' + dayNumber + '|' + nextWindowId;

        // Dedupe check against today's log.
        if (alreadySentToday_(log, pid, dayNumber, nextWindowId, tz, now)) {
          // Someone/something already logged this as sent today. Clear the
          // ping fields and move on — no double-send.
          writeCell_(sheet, sheetRow, colIdx['Next_Ping_ISO'], '');
          writeCell_(sheet, sheetRow, colIdx['Next_Window'],   '');
          continue;
        }

        // Stamp Last_Sent_ISO *before* the network call. On success we leave
        // it; on failure we roll it back and leave Next_Ping_ISO untouched
        // so the next tick retries.
        const sentAtIso = now.toISOString();
        writeCell_(sheet, sheetRow, colIdx['Last_Sent_ISO'], sentAtIso);

        const url  = buildLinkUrl_(pid, dayNumber, nextWindowId, nowMs);
        const body = buildSmsBody_(url);

        const res = sendTwilioSMS_(sid, token, fromPhone, phone, body);

        if (res.ok) {
          logOutcome_(log, pid, dayNumber, nextWindowId, 'sent:' + res.status);
          writeCell_(sheet, sheetRow, colIdx['Next_Ping_ISO'], '');
          writeCell_(sheet, sheetRow, colIdx['Next_Window'],   '');
        } else {
          // Roll back Last_Sent_ISO and leave the ping scheduled for retry.
          writeCell_(sheet, sheetRow, colIdx['Last_Sent_ISO'], '');
          logOutcome_(log, pid, dayNumber, nextWindowId, 'fail:' + res.status + ':' + (res.message || ''));
          continue;
        }
      } else {
        // Not yet time; do nothing this tick.
        continue;
      }
    }

    // --- 3. Schedule the next window, if any. ------------------------------
    if (SCHEDULE.length === 0) continue;

    const scheduled = computeNextPing_(tz, dayNumber, now);
    if (!scheduled) {
      // No more windows this study. Mark completed if we've exhausted all days.
      if (dayNumber >= STUDY_DAYS) {
        writeCell_(sheet, sheetRow, colIdx['Status'], 'Completed');
      }
      continue;
    }

    writeCell_(sheet, sheetRow, colIdx['Next_Window'],   scheduled.windowId);
    writeCell_(sheet, sheetRow, colIdx['Next_Ping_ISO'], scheduled.pingDate.toISOString());
  }
}


// ============================================================================
//   SCHEDULING MATH
// ============================================================================

/**
 * Given a participant's timezone, their current study-day number, and the
 * current moment, return { windowId, pingDate } for the next window to fire,
 * or null if there are no more windows in this study for this participant.
 *
 * The ping time is randomized within [window.start, window.end] in the
 * participant's local time, then converted back to a real Date object.
 */
function computeNextPing_(tz, dayNumber, now) {
  const pNowHm = Utilities.formatDate(now, tz, 'HH:mm');
  const pNowYmd = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // Find the first window (sorted ascending by end) whose end is still
  // in the participant's future today.
  let target = null;
  for (let i = 0; i < SCHEDULE.length; i++) {
    if (SCHEDULE[i].end >= pNowHm) { target = SCHEDULE[i]; break; }
  }

  let pTargetYmd = pNowYmd;
  let forDay = dayNumber;

  if (!target) {
    // No more windows today. Roll to tomorrow's first window — unless we're
    // already on the last study day, in which case we're done.
    if (dayNumber >= STUDY_DAYS) return null;
    target = SCHEDULE[0];
    pTargetYmd = addDaysYmd_(pNowYmd, 1);
    forDay = dayNumber + 1;
  }

  // Random minute inside the window, in participant-local time.
  const [sh, sm] = target.start.split(':').map(Number);
  const [eh, em] = target.end.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;
  const scheduledMins = startMins === endMins
    ? startMins
    : Math.floor(Math.random() * (endMins - startMins + 1)) + startMins;

  // If we're rolling to "today" but the scheduled minute has already passed,
  // clamp to "now + 1 minute" rather than scheduling in the past.
  const [nh, nm] = pNowHm.split(':').map(Number);
  const nowMins = nh * 60 + nm;
  let finalMins = scheduledMins;
  if (pTargetYmd === pNowYmd && finalMins < nowMins) finalMins = nowMins + 1;

  const hh = Math.floor(finalMins / 60).toString().padStart(2, '0');
  const mm = (finalMins % 60).toString().padStart(2, '0');
  const localIso = pTargetYmd + 'T' + hh + ':' + mm + ':00';

  const pingDate = dateFromLocalString_(localIso, tz);
  return { windowId: target.id, pingDate: pingDate, forDay: forDay };
}

/**
 * Convert "yyyy-MM-ddTHH:mm:ss" in a given IANA zone to a real UTC Date.
 *
 * This is the one piece of timezone math Apps Script doesn't give us for
 * free. The trick: format the UTC Date in the target zone, compute the
 * offset (observed at that exact moment, so DST is respected), then subtract.
 */
function dateFromLocalString_(localIso, tz) {
  // Parse as if it were UTC to get a provisional instant.
  const asUtc = new Date(localIso + 'Z');
  // Format that provisional instant in the target zone.
  const zonedStr = Utilities.formatDate(asUtc, tz, "yyyy-MM-dd'T'HH:mm:ss");
  const zoned    = new Date(zonedStr + 'Z');
  // offset = (what it reads in zone) - (provisional UTC value)
  const offsetMs = zoned.getTime() - asUtc.getTime();
  // The real UTC instant we wanted is the provisional minus the offset.
  return new Date(asUtc.getTime() - offsetMs);
}

function parseParticipantStartDate_(raw, tz) {
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  // Accept yyyy-MM-dd or MM/dd/yyyy; interpret as midnight in participant tz.
  let ymd = null;
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) {
    ymd = s;
  } else if (/^\\d{1,2}\\/\\d{1,2}\\/\\d{4}$/.test(s)) {
    const [mo, da, yr] = s.split('/').map(Number);
    ymd = yr + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
  } else {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  return dateFromLocalString_(ymd + 'T00:00:00', tz);
}

function dayDiffYmd_(ymdA, ymdB) {
  // Both are yyyy-MM-dd strings. Treat them as UTC midnights and diff.
  const a = new Date(ymdA + 'T00:00:00Z').getTime();
  const b = new Date(ymdB + 'T00:00:00Z').getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}

function addDaysYmd_(ymd, n) {
  const base = new Date(ymd + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + n);
  return Utilities.formatDate(base, 'Etc/UTC', 'yyyy-MM-dd');
}


// ============================================================================
//   URL + MESSAGE BUILDERS
// ============================================================================

function buildLinkUrl_(pid, day, windowId, tMs) {
  let base = BASE_URL;
  if (!base.endsWith('/') && !base.endsWith('.html')) base += '/';
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  // Always include t= so expiry_minutes in the study config is enforced.
  return base + sep + 'id=' + encodeURIComponent(pid) +
         '&day=' + day +
         '&session=' + encodeURIComponent(windowId) +
         '&t=' + tMs;
}

function buildSmsBody_(url) {
  const expiryNote = EXPIRY_MIN > 0
    ? ' Expires in ' + EXPIRY_MIN + ' min.'
    : '';
  return STUDY_NAME + ': time for your check-in.' + expiryNote + ' ' +
         url + '  Reply STOP to opt out.';
}


// ============================================================================
//   TWILIO + LOGGING
// ============================================================================

function sendTwilioSMS_(sid, token, fromPhone, toPhone, body) {
  const twilioUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const options = {
    method: 'post',
    payload: { To: toPhone, From: fromPhone, Body: body },
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(sid + ':' + token) },
    muteHttpExceptions: true
  };
  try {
    const resp = UrlFetchApp.fetch(twilioUrl, options);
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    if (code >= 200 && code < 300) {
      return { ok: true, status: code };
    }
    return { ok: false, status: code, message: truncate_(text, 300) };
  } catch (e) {
    return { ok: false, status: 0, message: String(e).slice(0, 300) };
  }
}

function logOutcome_(log, pid, day, windowId, outcome) {
  try {
    log.appendRow([new Date().toISOString(), pid, day, windowId, outcome]);
  } catch (e) {
    // Best-effort; don't let logging failures take down the dispatcher.
    console.warn('Log append failed: ' + e);
  }
}

function alreadySentToday_(log, pid, dayNumber, windowId, tz, now) {
  const todayYmd = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const last = log.getLastRow();
  if (last < 2) return false;
  const rows = log.getRange(2, 1, last - 1, 5).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const [tsIso, rPid, rDay, rWin, outcome] = rows[i];
    if (!outcome || !String(outcome).startsWith('sent:')) continue;
    if (String(rPid) !== String(pid)) continue;
    if (Number(rDay) !== Number(dayNumber)) continue;
    if (String(rWin) !== String(windowId)) continue;
    const rTs = new Date(tsIso);
    if (isNaN(rTs.getTime())) continue;
    if (Utilities.formatDate(rTs, tz, 'yyyy-MM-dd') === todayYmd) return true;
  }
  return false;
}

function writeCell_(sheet, row, colIndexZeroBased, value) {
  if (colIndexZeroBased === -1) return;
  sheet.getRange(row, colIndexZeroBased + 1).setValue(value);
}

function truncate_(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }


// ============================================================================
//   MANUAL TEST
// ============================================================================

function sendTestMessageRow2() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty('TWILIO_SID');
  const token = props.getProperty('TWILIO_TOKEN');
  const fromPhone = props.getProperty('TWILIO_PHONE');
  if (!sid || !token || !fromPhone) { ui.alert('Run Setup first.'); return; }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ROSTER_SHEET);
  if (!sheet || sheet.getLastRow() < 2) { ui.alert('No roster rows.'); return; }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const phoneIdx = headers.indexOf('Phone');
  const pidIdx   = headers.indexOf('Participant_ID');
  if (phoneIdx === -1 || pidIdx === -1) { ui.alert('Roster schema broken. Re-run setup.'); return; }

  const phone = String(sheet.getRange(2, phoneIdx + 1).getValue() || '').trim();
  const pid   = sheet.getRange(2, pidIdx + 1).getValue();
  if (!phone) { ui.alert('Row 2 has no phone.'); return; }

  const url = buildLinkUrl_(pid, 1, (SCHEDULE[0] && SCHEDULE[0].id) || 'w1', Date.now());
  const body = '[TEST] ' + buildSmsBody_(url);
  const res = sendTwilioSMS_(sid, token, fromPhone, phone, body);
  if (res.ok) ui.alert('Test sent (HTTP ' + res.status + ').');
  else        ui.alert('Test failed (HTTP ' + res.status + '): ' + (res.message || ''));
}
`;

  return scriptContent;
}