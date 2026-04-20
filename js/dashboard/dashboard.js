/**
 * EMA Studio - Dashboard Controller
 * Handles UI interactions, file binding, and rendering Chart.js graphs.
 */

// Global Chart configurations to match EMA Studio Dark Theme
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

    importBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      if (e.target.files.length === 0) return;
      
      document.getElementById('status-badge').textContent = "Processing...";
      document.getElementById('status-badge').className = "badge badge-warn";
      
      try {
        const data = await DataParser.ingestFiles(e.target.files);
        this.updateDashboard(data);
        
        // Hide empty state
        document.getElementById('empty-state').style.display = 'none';
        
        document.getElementById('status-badge').textContent = "Synced Just Now";
        document.getElementById('status-badge').className = "badge badge-good";
        
      } catch (err) {
        console.error(err);
        alert("Error parsing folder. Make sure it contains EMA JSON exports.");
        document.getElementById('status-badge').textContent = "Error";
        document.getElementById('status-badge').className = "badge badge-danger";
      }
      
      // Reset input so they can re-select the same folder if needed
      fileInput.value = "";
    });
  },

  initEmptyCharts() {
    // 1. Compliance Bar Chart
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

    // 2. Disposition Doughnut Chart
    const ctxDisp = document.getElementById('dispositionChart').getContext('2d');
    this.charts.disposition = new Chart(ctxDisp, {
      type: 'doughnut',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '75%',
        plugins: { legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, padding: 15 } } }
      }
    });

    // 3. Latency Line Chart
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
    document.getElementById('dash-study-name').textContent = studyName;
    document.getElementById('dash-subtitle').textContent = `Local File Analysis — ${data.participants.size} Active Participants`;
    
    document.getElementById('filter-cohort').innerHTML = `<option>All Participants (n=${data.participants.size})</option>`;
    
    // Progress sidebar
    const studyDays = data.studyConfig?.study?.days || Object.keys(data.metrics.complianceByDay).length;
    // Estimate current day by finding max day with data
    const currentDay = Math.max(...data.rawSessions.map(s => s.day), 1);
    const pct = Math.round((currentDay / studyDays) * 100);
    
    document.getElementById('study-progress-text').textContent = `Day ${currentDay} of ${studyDays}`;
    document.getElementById('study-progress-pct').textContent = `${pct}%`;
    document.getElementById('study-progress-bar').style.width = `${pct}%`;
    document.getElementById('study-progress-hint').textContent = "Progress based on latest uploaded participant data.";
  },

  updateKPIs(m) {
    // Math formatters
    const fmtPct = (num, den) => den === 0 ? "0%" : Math.round((num / den) * 100) + "%";
    const fmtMsToMinSec = (ms) => {
        if(ms === 0) return "--m --s";
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        return `${mins}m ${secs}s`;
    };

    // 1. Compliance
    const compliancePct = m.totalExpectedPings === 0 ? 0 : (m.totalCompleted / m.totalExpectedPings) * 100;
    document.getElementById('kpi-compliance').textContent = fmtPct(m.totalCompleted, m.totalExpectedPings);
    this.setCardStatus('card-compliance', compliancePct >= 80 ? 'good' : (compliancePct >= 60 ? 'warn' : 'danger'));

    // 2. Pings
    document.getElementById('kpi-pings').textContent = m.totalDelivered;
    
    // 3. Noise (Speeding)
    const noisePct = m.totalCompleted === 0 ? 0 : (m.totalNoise / m.totalCompleted) * 100;
    document.getElementById('kpi-noise').textContent = fmtPct(m.totalNoise, m.totalCompleted);
    this.setCardStatus('card-noise', noisePct < 5 ? 'good' : (noisePct < 15 ? 'warn' : 'danger'));

    // 4. Avg Time
    document.getElementById('kpi-time').textContent = fmtMsToMinSec(m.avgTimeMs);
  },

  setCardStatus(cardId, statusClass) {
    const el = document.getElementById(cardId);
    el.className = "kpi-card " + statusClass;
  },

  updateCharts(m) {
    const days = Object.keys(m.complianceByDay).sort((a,b)=>a-b);
    const labels = days.map(d => `Day ${d}`);
    
    // 1. Compliance Chart
    const completedData = days.map(d => m.complianceByDay[d].completed);
    const missedData = days.map(d => m.complianceByDay[d].missed);
    
    // Normalize to percentages per day for the stacked bar
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
    const valid = m.totalCompleted - m.totalNoise;
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

    // Update median badge (simplistic avg for now)
    const overallLatMin = Math.round(m.avgLatencyMs / 60000);
    document.getElementById('latency-median-badge').textContent = `Avg: ${overallLatMin}m`;
  },

  updateTable(data) {
    const tbody = document.getElementById('participant-table-body');
    tbody.innerHTML = '';

    // Calculate per-participant compliance
    const pStats = {};
    data.rawSessions.forEach(s => {
      if(!pStats[s.participantId]) pStats[s.participantId] = { completed: 0 };
      pStats[s.participantId].completed++;
    });

    // We assume expected pings = Total Expected / Num Participants
    const expectedPerP = data.metrics.totalExpectedPings / data.participants.size;

    const rows = Object.keys(pStats).map(pId => {
      const comp = pStats[pId].completed;
      const pct = Math.round((comp / expectedPerP) * 100);
      return { id: pId, pct: pct };
    });

    // Sort lowest compliance first (Watchlist)
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

// Initialize App
document.addEventListener('DOMContentLoaded', () => AppUI.init());
