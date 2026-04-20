/**
 * EMA Studio - Data Parser Engine
 * Handles ingesting a local folder of JSON files, separating the config
 * from the participant payloads, and calculating metadata KPIs.
 */

const DataParser = {
    state: {
      studyConfig: null,
      rawSessions: [],
      participants: new Set(),
      metrics: {
        totalExpectedPings: 0,
        totalDelivered: 0,
        totalCompleted: 0,
        totalMissed: 0,
        totalNoise: 0, // Speeding (<30s)
        avgTimeMs: 0,
        avgLatencyMs: 0,
        complianceByDay: {}, // { day1: { completed: X, missed: Y }, ... }
        latencyByDay: {}
      }
    },
  
    /**
     * Reads the FileList provided by the <input webkitdirectory>
     */
    async ingestFiles(fileList) {
      this.resetState();
      
      const files = Array.from(fileList).filter(f => f.name.endsWith('.json'));
      if (files.length === 0) throw new Error("No JSON files found in directory.");
  
      const readPromises = files.map(file => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              const json = JSON.parse(e.target.result);
              // Simple heuristic to differentiate config from participant payload
              if (json.schedule && json.study) {
                this.state.studyConfig = json;
              } else if (json.metadata || json.participantId) {
                this.state.rawSessions.push(this.normalizeSession(json));
              }
            } catch (err) {
              console.warn(`Could not parse ${file.name}`);
            }
            resolve();
          };
          reader.readAsText(file);
        });
      });
  
      await Promise.all(readPromises);
      this.calculateMetrics();
      return this.state;
    },
  
    /**
     * Resets the internal state before a new import
     */
    resetState() {
      this.state.studyConfig = null;
      this.state.rawSessions = [];
      this.state.participants.clear();
      this.state.metrics = {
        totalExpectedPings: 0, totalDelivered: 0, totalCompleted: 0,
        totalMissed: 0, totalNoise: 0, avgTimeMs: 0, avgLatencyMs: 0,
        complianceByDay: {}, latencyByDay: {}
      };
    },
  
    /**
     * Ensures every payload has a predictable "Metadata Envelope"
     * even if older/newer versions of the builder output slightly different keys.
     */
    normalizeSession(json) {
      const meta = json.metadata || json; // Fallback if no nested metadata
      
      // Calculate derived timestamps
      const start = new Date(meta.startedAt || meta.startTime || Date.now()).getTime();
      const end = new Date(meta.completedAt || meta.endTime || Date.now()).getTime();
      const delivered = new Date(meta.promptDeliveredAt || meta.scheduledTime || start).getTime();
  
      const durationMs = end - start;
      const latencyMs = start - delivered;
  
      return {
        participantId: meta.participantId || meta.id || 'Unknown',
        day: parseInt(meta.dayNumber || meta.day || 1, 10),
        sessionType: meta.sessionType || meta.session || 'unknown',
        durationMs: durationMs > 0 ? durationMs : 0,
        latencyMs: latencyMs > 0 ? latencyMs : 0,
        isCompleted: true, // If we have a JSON, they submitted it
        isNoise: durationMs < 30000 // Flag as noise if completed in under 30s
      };
    },
  
    /**
     * Crunches the raw array into the KPIs needed for the dashboard charts
     */
    calculateMetrics() {
      const sessions = this.state.rawSessions;
      
      // Identify unique participants
      sessions.forEach(s => this.state.participants.add(s.participantId));
      const pCount = this.state.participants.size || 1;
  
      // Calculate Expected Totals based on Config (or make a best guess)
      let expectedPerDay = 3; 
      let studyDays = 14;
      
      if (this.state.studyConfig) {
        studyDays = parseInt(this.state.studyConfig.study?.days || 14, 10);
        expectedPerDay = this.state.studyConfig.schedule?.windows?.length || 3;
      } else {
        // Best guess based on data if config is missing
        const maxDayFound = Math.max(...sessions.map(s => s.day), 1);
        studyDays = maxDayFound;
      }
  
      this.state.metrics.totalExpectedPings = pCount * studyDays * expectedPerDay;
      this.state.metrics.totalCompleted = sessions.length;
      
      // If we only have exported JSONs of *completed* sessions, 
      // Missed = Expected - Completed.
      this.state.metrics.totalMissed = Math.max(0, this.state.metrics.totalExpectedPings - this.state.metrics.totalCompleted);
      this.state.metrics.totalDelivered = this.state.metrics.totalExpectedPings; // Assuming perfect delivery for now
  
      let totalDuration = 0;
      let totalLatency = 0;
  
      // Aggregate by Day
      for (let i = 1; i <= studyDays; i++) {
        this.state.metrics.complianceByDay[i] = { completed: 0, missed: pCount * expectedPerDay, latencies: [] };
      }
  
      sessions.forEach(s => {
        totalDuration += s.durationMs;
        totalLatency += s.latencyMs;
        if (s.isNoise) this.state.metrics.totalNoise++;
  
        if (this.state.metrics.complianceByDay[s.day]) {
           this.state.metrics.complianceByDay[s.day].completed++;
           // Deduct from assumed missed pool
           this.state.metrics.complianceByDay[s.day].missed = Math.max(0, this.state.metrics.complianceByDay[s.day].missed - 1);
           this.state.metrics.complianceByDay[s.day].latencies.push(s.latencyMs);
        }
      });
  
      if (sessions.length > 0) {
        this.state.metrics.avgTimeMs = totalDuration / sessions.length;
        this.state.metrics.avgLatencyMs = totalLatency / sessions.length;
      }
  
      // Calculate Average Latency per day for the line chart
      Object.keys(this.state.metrics.complianceByDay).forEach(day => {
        const lats = this.state.metrics.complianceByDay[day].latencies;
        const avgLat = lats.length > 0 ? (lats.reduce((a,b)=>a+b,0) / lats.length) : 0;
        this.state.metrics.latencyByDay[day] = avgLat;
      });
    }
  };
