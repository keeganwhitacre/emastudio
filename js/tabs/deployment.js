/**
 * EMA Studio - Deployment & Routing Tab
 * Generates a comprehensive CSV of unique participant links, 
 * factoring in the number of days, sessions, and onboarding needs.
 */

function bindDeploymentTab() {
  const generateBtn = document.getElementById('generate-csv-btn');
  
  if (!generateBtn) return;
  
  generateBtn.addEventListener('click', () => {
    // 1. Get user inputs
    const baseUrlInput = document.getElementById('deploy-base-url').value.trim();
    const baseUrl = baseUrlInput ? baseUrlInput : 'https://example.com/study/';
    const startId = parseInt(document.getElementById('deploy-start-id').value) || 1;
    const endId = parseInt(document.getElementById('deploy-end-id').value) || 20;
    
    // 2. Fetch schedule data from global state
    const windows = state.ema.scheduling.windows || [];
    const studyDays = state.ema.scheduling.study_days || 1;
    
    if (windows.length === 0 && !state.onboarding.enabled) {
      alert("No schedule windows or onboarding found. Please configure your study before generating links.");
      return;
    }
    
    // 3. Build the CSV content
    // We add 'Day' to the columns since studies span multiple days
    let csvContent = "Participant_ID,Day,Session,URL\n";
    
    // Ensure base URL ends with a slash or points directly to the HTML
    const cleanBase = baseUrl.endsWith('/') || baseUrl.endsWith('.html') ? baseUrl : baseUrl + '/';
    
    for (let p = startId; p <= endId; p++) {
      
      // A. Generate Onboarding Link (Day 0)
      if (state.onboarding.enabled) {
        const url = `${cleanBase}?id=${p}&session=onboarding`;
        csvContent += `${p},0,Setup,${url}\n`;
      }
      
      // B. Generate Daily Prompts (Days 1 -> N)
      for (let day = 1; day <= studyDays; day++) {
        windows.forEach(w => {
          // Use the exact URL parameters expected by study-base.js
          const cleanLabel = w.label.replace(/,/g, ''); // prevent CSV breaks
          const url = `${cleanBase}?id=${p}&day=${day}&session=${w.id}`;
          csvContent += `${p},${day},${cleanLabel},${url}\n`;
        });
      }
    }
    
    // 4. Trigger the browser download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    
    const safeName = (state.study.name || 'study').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    link.setAttribute("href", url);
    link.setAttribute("download", `${safeName}_deployment_links.csv`);
    link.style.display = 'none';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
}