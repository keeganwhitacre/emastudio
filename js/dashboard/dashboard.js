/**
 * EMA Studio - Dashboard Controller
 * Handles UI interactions, file binding, and rendering Chart.js graphs.
 */

Chart.defaults.color = '#768390';
Chart.defaults.font.family = '"TX-02", "Instrument Sans", system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = '#30363d';
const gridConfig = { color: '#30363d', drawBorder: false };

const AppUI = {
  charts: {
    compliance: null,
    disposition: null,
    latency: null
  },

  init() {
    this.bindEvents();
    this.initEmptyCharts();
  },

  bindEvents() {
    const importBtn = document.getElementById('btn-import-data');
    const fileInput = document.getElementById('folder-import-input');
    const exportBtn = document.getElementById('export-csv-btn');
    
    // Filters & Toggles
    const filterRapid = document.getElementById('toggle-filter-rapid');
    const filterMissed = document.getElementById('toggle-exclude-missed');
    const filterDate = document.getElementById('filter-date');
    const filterCohort = document.getElementById('filter-cohort');
    
    // Navigation
    const navTabs = document.querySelectorAll('.topbar-tabs .tab-btn');
    const segBtns = document.querySelectorAll('.seg-ctrl .seg-btn');

    // 1. File Import
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      if (e.target.files.length === 0) return;
      
      this.setStatus("Processing...", "badge-warn");
      try {
        const data = await DataParser.ingestFiles(e.target.files);
        this.populateDateDropdown(data.allSessions);
        this.refreshData(); 
        document.getElementById('empty-state').style.display = 'none';
        this.setStatus("Synced Just Now", "badge-good");
      } catch (err) {
        console.error(err);
        alert("Error parsing folder. Make sure it contains EMA JSON exports.");
        this.setStatus("Error", "badge-danger");
      }
      fileInput.value = "";
    });

    // 2. Interactive Filters (Trigger refresh on any change)
    [filterRapid, filterMissed, filterDate, filterCohort].forEach(el => {
        el.addEventListener('change', () => this.refreshData());
    });

    // 3. Segmented Control (Aggregate vs Per Participant)
    segBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelector('.seg-ctrl .seg-btn.active')?.classList.remove('active');
            e.target.classList.add('active');
            
            const mode = e.target.textContent.trim();
            if (mode === 'Per Participant') {
                // Change dropdown to list individual IDs
                const pList = Array.from(DataParser.state.participants).sort();
                filterCohort.innerHTML = pList.map(p => `<option value="${p}">${p}</option>`).join('');
            } else {
                // Revert to Aggregate
                filterCohort.innerHTML = `<option value="all">All Participants (n=${DataParser.state.participants.size})</option>`;
            }
            this.refreshData(); // Recalculate based on new dropdown state
        });
    });

    // 4. Top Navigation Tabs (Smooth Scroll & Highlight)
    navTabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        document.querySelector('.topbar-tabs .tab-btn.active')?.classList.remove('active');
        e.target.classList.add('active');
        
        const mode = e.target.textContent.trim();
        let targetId = '';
        
        // Map tabs to DOM element IDs
        if (mode === 'Overview') targetId = 'dashboard-panel'; // Scrolls to top
        if (mode === 'Compliance') targetId = 'complianceChart';
        if (mode === 'Signals & Noise') targetId = 'latencyChart';
        if (mode === 'Participants') targetId = 'participant-table-body';
        
        const el = document.getElementById(targetId);
        if (el) {
          // Scroll it into view
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Flash the border of the closest card to draw the user's eye
          const card = el.closest('.chart-card, .data-table-container, .kpi-grid');
          if (card) {
            card.style.transition = 'border-color 0.4s ease';
            card.style.borderColor = 'var(--accent)';
            setTimeout(() => card.style.borderColor = 'var(--border)', 1200);
          }
        }
      });
    });

    // 5. Export CSV
    exportBtn.addEventListener('click', () => this.exportToCSV());
  },

  setStatus(text, badgeClass) {
    const badge = document.getElementById('status-badge');
    badge.textContent = text;
    badge.className = `badge ${badgeClass}`;
  },

  refreshData() {
    if (DataParser.state.allSessions.length === 0) return;
    
    // Read current UI state
    const filters = {
        excludeNoise: document.getElementById('toggle-filter-rapid').checked,
        excludeMissed: document.getElementById('toggle-exclude-missed').checked,
        day: document.getElementById('filter-date').value,
        participant: document.getElementById('filter-cohort').value || 'all'
    };

    // Tell parser to recalculate
    DataParser.calculateMetrics(filters);
    this.updateDashboard(DataParser.state);
  },

  populateDateDropdown(sessions) {
    const select = document.getElementById('filter-date');
    const maxDay = Math.max(...sessions.map(s => s.day), 1);
    
    select.innerHTML = '<option value="all">All available data</option>';
    for(let i = 1; i <= maxDay; i++) {
        const opt = document.createElement('option');
        opt.value = i.toString();
        opt.textContent = `Day ${i}`;
        select.appendChild(opt);
    }
  },

  exportToCSV() {
    const sessions = DataParser.state.filteredSessions;
    if (sessions.length === 0) return alert("No data available to export. Import a folder first.");

    const headerSet = new Set();
    sessions.forEach(s => Object.keys(s).forEach(k => headerSet.add(k)));
    const headers = Array.from(headerSet);

    const csvRows = [];
    csvRows.push(headers.join(',')); 

    sessions.forEach(session => {
        const values = headers.map(header => {
            const val = session[header];
            if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`;
            if (val === undefined || val === null) return "";
            return val;
        });
        csvRows.push(values.join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', 'ema_studio_export.csv');
    a.click();
  },

  initEmptyCharts() {
    const ctxComp = document.getElementById('complianceChart').getContext('2d');
    this.charts.compliance = new Chart(ctxComp, {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } } },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, max: 100, grid: gridConfig, ticks: { callback: v => v + '%' } }
        }
      }
    });

    const ctxDisp = document.getElementById('dispositionChart').getContext('2d');
    this.charts.disposition = new Chart(ctxDisp, {
      type: 'doughnut',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '75%',
        plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, padding: 15 } } }
      }
    });

    const ctxLat = document.getElementById('latencyChart').getContext('2d');
    this.charts.latency = new Chart(ctxLat, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, grid: gridConfig, ticks: { callback: v => v + 'm' } }
        }
      }
    });
  },

  updateDashboard(data) {
    this.updateHeader(data);
    this.updateKPIs(data.metrics);
    this.updateCharts(data.metrics);
    this.updateTable(data);
  },

  updateHeader(data) {
    const studyName = data.studyConfig?.study?.name || "Imported Study Data";
    const cohortFilter = document.getElementById('filter-cohort').value;
    
    document.getElementById('dash-study-name').textContent = studyName;
    document.getElementById('dash-subtitle').textContent = cohortFilter === 'all' 
        ? `Local File Analysis — ${data.participants.size} Active Participants`
        : `Local File Analysis — Isolating Participant ${cohortFilter}`;
    
    const studyDays = data.studyConfig?.study?.days || Object.keys(data.metrics.complianceByDay).length;
    const currentDay = Math.max(...data.allSessions.map(s => s.day), 1);
    const pct = Math.round((currentDay / studyDays) * 100);
    
    document.getElementById('study-progress-text').textContent = `Day ${currentDay} of ${studyDays}`;
    document.getElementById('study-progress-pct').textContent = `${pct}%`;
    document.getElementById('study-progress-bar').style.width = `${pct}%`;
  },

  updateKPIs(m) {
    const fmtPct = (num, den) => den === 0 ? "0%" : Math.round((num / den) * 100) + "%";
    const fmtMsToMinSec = (ms) => {
        if(ms === 0) return "--m --s";
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        return `${mins}m ${secs}s`;
    };

    const compliancePct = m.totalExpectedPings === 0 ? 0 : (m.totalCompleted / m.totalExpectedPings) * 100;
    document.getElementById('kpi-compliance').textContent = fmtPct(m.totalCompleted, m.totalExpectedPings);
    this.setCardStatus('card-compliance', compliancePct >= 80 ? 'good' : (compliancePct >= 60 ? 'warn' : 'danger'));

    document.getElementById('kpi-pings').textContent = m.totalDelivered;
    
    // Calculate noise based on the raw pre-filtered total to give an accurate "% of data that is noise"
    const isExcludingNoise = document.getElementById('toggle-filter-rapid').checked;
    const baseTotal = isExcludingNoise ? (m.totalCompleted + m.totalNoise) : m.totalCompleted;
    const noisePct = baseTotal === 0 ? 0 : (m.totalNoise / baseTotal) * 100;
    
    document.getElementById('kpi-noise').textContent = fmtPct(m.totalNoise, baseTotal);
    this.setCardStatus('card-noise', noisePct < 5 ? 'good' : (noisePct < 15 ? 'warn' : 'danger'));

    document.getElementById('kpi-time').textContent = fmtMsToMinSec(m.avgTimeMs);
  },

  setCardStatus(cardId, statusClass) {
    const el = document.getElementById(cardId);
    if(el) el.className = "kpi-card " + statusClass;
  },

  updateCharts(m) {
    const days = Object.keys(m.complianceByDay).sort((a,b)=>a-b);
    const labels = days.map(d => `Day ${d}`);
    
    // 1. Compliance Stacked Bar
    const completedData = days.map(d => m.complianceByDay[d].completed);
    const missedData = days.map(d => m.complianceByDay[d].missed);
    
    const compPctData = completedData.map((val, i) => {
        const total = val + missedData[i];
        return total === 0 ? 0 : Math.round((val/total)*100);
    });
    const missPctData = missedData.map((val, i) => {
        const total = completedData[i] + val;
        return total === 0 ? 0 : Math.round((val/total)*100);
    });

    this.charts.compliance.data = {
      labels: labels,
      datasets: [
        { label: 'Completed', data: compPctData, backgroundColor: '#3fb950', borderRadius: 4, barPercentage: 0.6 },
        { label: 'Missed', data: missPctData, backgroundColor: '#2d333b', borderRadius: 4, barPercentage: 0.6 }
      ]
    };
    this.charts.compliance.update();

    // 2. Disposition Doughnut
    const isExcludingNoise = document.getElementById('toggle-filter-rapid').checked;
    const valid = m.totalCompleted - (isExcludingNoise ? 0 : m.totalNoise);
    
    this.charts.disposition.data = {
      labels: ['Valid Data', 'Missed', 'Speeding (Noise)'],
      datasets: [{
        data: [valid, m.totalMissed, m.totalNoise],
        backgroundColor: ['#3fb950', '#2d333b', '#e8716a'],
        borderWidth: 0, hoverOffset: 4
      }]
    };
    this.charts.disposition.update();

    // 3. Latency Line
    const latencyDataMins = days.map(d => Math.round(m.latencyByDay[d] / 60000));
    this.charts.latency.data = {
      labels: labels,
      datasets: [{
        label: 'Avg Latency (mins)',
        data: latencyDataMins,
        borderColor: '#388bfd',
        backgroundColor: 'rgba(56,139,253,0.1)',
        borderWidth: 2, tension: 0.4, fill: true,
        pointBackgroundColor: '#161b22', pointBorderColor: '#388bfd', pointRadius: 4
      }]
    };
    this.charts.latency.update();

    const overallLatMin = Math.round(m.avgLatencyMs / 60000);
    document.getElementById('latency-median-badge').textContent = `Avg: ${overallLatMin}m`;
  },

  updateTable(data) {
    const tbody = document.getElementById('participant-table-body');
    tbody.innerHTML = '';

    const pStats = {};
    data.filteredSessions.forEach(s => {
      if(!pStats[s.participantId]) pStats[s.participantId] = { completed: 0 };
      pStats[s.participantId].completed++;
    });

    const currentDayFilter = document.getElementById('filter-date').value;
    const isExcludeMissed = document.getElementById('toggle-exclude-missed').checked;
    const expectedPerDay = data.studyConfig?.schedule?.windows?.length || 3;
    const studyDays = data.studyConfig?.study?.days || 14;
    
    const expectedPerP = currentDayFilter === 'all' ? (studyDays * expectedPerDay) : expectedPerDay;

    const rows = Object.keys(pStats).map(pId => {
      const comp = pStats[pId].completed;
      // If "Exclude Missed" is flipped, the expected denominator becomes exactly what they completed
      const denominator = isExcludeMissed ? comp : expectedPerP;
      const pct = denominator === 0 ? 0 : Math.round((comp / denominator) * 100);
      return { id: pId, pct: Math.min(100, pct) };
    });

    rows.sort((a,b) => a.pct - b.pct);

    rows.forEach(r => {
      const tr = document.createElement('tr');
      
      let color = 'var(--green)';
      let badgeClass = 'badge-good';
      let status = 'Good';

      if (r.pct < 50) { color = 'var(--red)'; badgeClass = 'badge-danger'; status = 'Critical'; }
      else if (r.pct < 75) { color = 'var(--yellow)'; badgeClass = 'badge-warn'; status = 'At Risk'; }

      tr.innerHTML = `
        <td>${r.id}</td>
        <td><span style="color:${color}; font-weight:600;">${r.pct}%</span></td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }
};

document.addEventListener('DOMContentLoaded', () => AppUI.init());
