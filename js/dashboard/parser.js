/**
 * EMA Forge - Data Parser Engine
 * Handles ingesting a local folder of JSON files, separating the config
 * from the participant payloads, and calculating metadata KPIs.
 */

const DataParser = {
    state: {
      studyConfig: null,
      allSessions: [],       // Source of truth for all imported data
      filteredSessions: [],  // The data currently being viewed/analyzed
      participants: new Set(),
      metrics: {
        totalExpectedPings: 0,
        totalDelivered: 0,
        totalCompleted: 0,
        totalMissed: 0,
        totalNoise: 0, 
        avgTimeMs: 0,
        avgLatencyMs: 0,
        complianceByDay: {}, 
        latencyByDay: {}
      }
    },
  
    async ingestFiles(fileList) {
  this.resetState();
  
  // 1. Load config from browser storage if it exists (The "Just Once" feature)
  const cachedConfig = localStorage.getItem('ema_forge_config');
  if (cachedConfig) {
    try { this.state.studyConfig = JSON.parse(cachedConfig); } catch (e) {}
  }

  const files = Array.from(fileList).filter(f => f.name.endsWith('.json') || f.name.endsWith('.csv'));
  if (files.length === 0) throw new Error("No JSON or CSV files found.");

  const readPromises = files.map(file => {
    return new Promise((resolve) => {
      
      // --- JSON HANDLING (Existing behavior + Config Caching) ---
      if (file.name.endsWith('.json')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const json = JSON.parse(e.target.result);
            if (json.schema_version && json.ema && json.ema.scheduling) {
              this.state.studyConfig = json;
              localStorage.setItem('ema_forge_config', e.target.result); // Cache for future visits
            } else if (json.participantId || json.sessionId) {
              this.state.allSessions.push(this.normalizeSession(json));
            }
          } catch (err) {
            console.warn(`Could not parse ${file.name}`);
          }
          resolve();
        };
        reader.readAsText(file);
      } 
      
      // --- CSV HANDLING (New Webhook/Google Sheets behavior) ---
      else if (file.name.endsWith('.csv')) {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            results.data.forEach(row => {
              const rawJsonStr = row['Raw JSON']; // Targets your specific CSV column
              if (rawJsonStr) {
                try {
                  const json = JSON.parse(rawJsonStr);
                  
                  if (json.schema_version && json.ema && json.ema.scheduling) {
                    this.state.studyConfig = json;
                    localStorage.setItem('ema_forge_config', rawJsonStr);
                  } else if (json.participantId || json.sessionId) {
                    this.state.allSessions.push(this.normalizeSession(json));
                  }
                } catch (err) {
                  console.warn("Invalid JSON found in CSV row", row);
                }
              }
            });
            resolve();
          },
          error: (err) => {
            console.error("CSV Parse Error:", err);
            resolve();
          }
        });
      }
    });
  });

  await Promise.all(readPromises);
  
  if (!this.state.studyConfig && this.state.allSessions.length > 0) {
      console.warn("No config loaded. Study layout might be incomplete.");
  }

  // Calculate initial metrics
  this.state.allSessions.forEach(s => this.state.participants.add(s.participantId));
  this.calculateMetrics({ excludeNoise: true, excludeMissed: false, day: 'all', participant: 'all' });
  return this.state;
},
  
    resetState() {
      this.state.studyConfig = null;
      this.state.allSessions = [];
      this.state.filteredSessions = [];
      this.state.participants.clear();
      this.state.metrics = {
        totalExpectedPings: 0, totalDelivered: 0, totalCompleted: 0,
        totalMissed: 0, totalNoise: 0, avgTimeMs: 0, avgLatencyMs: 0,
        complianceByDay: {}, latencyByDay: {}
      };
    },
  
    normalizeSession(json) {
      const start = new Date(json.startedAt || Date.now()).getTime();
      const end = new Date(json.completedAt || Date.now()).getTime();
  
      const durationMs = end - start;
      
      // Note: Latency (time from SMS delivery to app open) requires backend logs.
      // For pure client-side data, we leave it at 0 until external notification data is merged.
      const latencyMs = 0; 
  
      return {
      participantId: json.participantId || 'Unknown',
      sessionId:     json.sessionId     || '',
      startedAt:     json.startedAt     || null,
      completedAt:   json.completedAt   || null,
      day: parseInt(json.day || 1, 10),
      sessionType: json.type || 'unknown',
      durationMs: durationMs > 0 ? durationMs : 0,
      latencyMs: latencyMs,
      isCompleted: json.status === "complete",
      isNoise: durationMs < 30000,
      data: json.data || []
    };
    },
  
    /**
     * Recalculates all math based on ALL active UI filters
     */
    calculateMetrics(filters = { excludeNoise: false, excludeMissed: false, day: 'all', participant: 'all' }) {
      let sessions = this.state.allSessions;
      
      // 1. Apply Scope Filters (Date & Participant)
      if (filters.day !== 'all') {
        sessions = sessions.filter(s => s.day === parseInt(filters.day, 10));
      }
      if (filters.participant !== 'all') {
        sessions = sessions.filter(s => s.participantId === filters.participant);
      }

      // Calculate Total Noise strictly based on Date/Participant scope 
      this.state.metrics.totalNoise = sessions.filter(s => s.isNoise).length;

      // 2. Apply Quality Filters
      if (filters.excludeNoise) {
        sessions = sessions.filter(s => !s.isNoise);
      }
      this.state.filteredSessions = sessions;
  
      // 3. Base Expected Math
      let pCount = filters.participant !== 'all' ? 1 : (this.state.participants.size || 1);
      let expectedPerDay = this.state.studyConfig?.ema?.scheduling?.windows?.length || 3; 
      
      // Calculate based on the CURRENT day, not the total future length of the study
      let currentDay = Math.max(...this.state.allSessions.map(s => s.day), 1);
      
      if (filters.day !== 'all') {
        this.state.metrics.totalExpectedPings = pCount * expectedPerDay;
      } else {
        this.state.metrics.totalExpectedPings = pCount * currentDay * expectedPerDay;
      }

      this.state.metrics.totalCompleted = sessions.length;
      
      // Handle the "Exclude Missed" toggle logic
      if (filters.excludeMissed) {
          this.state.metrics.totalExpectedPings = this.state.metrics.totalCompleted;
          this.state.metrics.totalMissed = 0;
      } else {
          this.state.metrics.totalMissed = Math.max(0, this.state.metrics.totalExpectedPings - this.state.metrics.totalCompleted);
      }

      this.state.metrics.totalDelivered = this.state.metrics.totalExpectedPings; 
  
      let totalDuration = 0;
      let totalLatency = 0;
      this.state.metrics.complianceByDay = {};
      this.state.metrics.latencyByDay = {};
  
      // Setup day buckets based on filter (ONLY track up to currentDay)
      const daysToTrack = filters.day !== 'all' ? [parseInt(filters.day, 10)] : Array.from({length: currentDay}, (_, i) => i + 1);
      daysToTrack.forEach(d => {
        this.state.metrics.complianceByDay[d] = { 
            completed: 0, 
            missed: filters.excludeMissed ? 0 : pCount * expectedPerDay, 
            latencies: [] 
        };
      });
  
      // 4. Crunch the final filtered sessions
      sessions.forEach(s => {
        totalDuration += s.durationMs;
        totalLatency += s.latencyMs;
  
        if (this.state.metrics.complianceByDay[s.day]) {
           this.state.metrics.complianceByDay[s.day].completed++;
           
           if (!filters.excludeMissed) {
             this.state.metrics.complianceByDay[s.day].missed = Math.max(0, this.state.metrics.complianceByDay[s.day].missed - 1);
           }
           this.state.metrics.complianceByDay[s.day].latencies.push(s.latencyMs);
        }
      });
  
      if (sessions.length > 0) {
        this.state.metrics.avgTimeMs = totalDuration / sessions.length;
        this.state.metrics.avgLatencyMs = totalLatency / sessions.length;
      } else {
        this.state.metrics.avgTimeMs = 0;
        this.state.metrics.avgLatencyMs = 0;
      }
  
      // Calculate Average Latency per day
      Object.keys(this.state.metrics.complianceByDay).forEach(day => {
        const lats = this.state.metrics.complianceByDay[day].latencies;
        this.state.metrics.latencyByDay[day] = lats.length > 0 ? (lats.reduce((a,b)=>a+b,0) / lats.length) : 0;
      });
    }
  };