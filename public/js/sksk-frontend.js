// ===============================
// CLEAR / RESET SESSION
// ===============================
document.getElementById('btn-reset-session').addEventListener('click', () => {
  console.log('[UI] Purging local state and estimate cache.');

  // 1. Clear text inputs explicitly
  const cs = document.getElementById('customerStates'); if (cs) cs.value = '';
  const obd = document.getElementById('obdCodes'); if (obd) obd.value = '';
  const mn = document.getElementById('mechanicNotices'); if (mn) mn.value = '';

  // 2. Clear hidden arrays/session memory
  window.sessionStorage.removeItem('currentEstimate');
  window.sessionStorage.removeItem('activeSymptomTranslation');
  window.currentMechanicNotices = [];
  window.currentObdCodes = [];

  // 3. Reset UI display panes to neutral
  const readyBanner = document.getElementById('estimate-ready-banner');
  if (readyBanner) readyBanner.style.display = 'none';

  const diagOutput = document.getElementById('diagnosis-output');
  if (diagOutput) diagOutput.innerText = 'Awaiting fresh vehicle input...';

  // 4. Reset probability breakdown and repair steps view
  const probBreakdown = document.getElementById('probability-breakdown');
  if (probBreakdown) probBreakdown.innerHTML = '';

  const repairSteps = document.getElementById('repair-steps-list');
  if (repairSteps) repairSteps.innerHTML = '';

  // 5. Reset translation preview
  const previewBox = document.getElementById('translatePreview');
  if (previewBox) previewBox.innerText = 'Translation preview will appear here...';

  alert('Session cleared. Form is ready for continuous, uninterrupted vehicle diagnosis.');
});


// ===============================
// ESTIMATE BUTTON GUARD
// ===============================
document.getElementById('btn-generate-estimate').addEventListener('click', (e) => {
  const isEstimateReady = document.getElementById('estimate-ready-banner')?.style.display === 'block';
  const customerStatesInput = (document.getElementById('customerStates')?.value || '').trim();

  if (isEstimateReady && customerStatesInput === '') {
    e.preventDefault();
    alert('Previous diagnosis active. Please hit "New Vehicle / Clear Session" before continuous diagnosis continues.');
    return;
  }

  executeEstimatePipeline();
});


// ===============================
// TRANSLATE PREVIEW (READ-ONLY)
// ===============================
document.getElementById('translateBtn')?.addEventListener('click', async () => {
  const raw = document.getElementById('customerStates')?.value.trim();
  const previewBox = document.getElementById('translatePreview');

  if (!raw) {
    if (previewBox) previewBox.innerText = '[No customer states entered]';
    return;
  }

  try {
    if (previewBox) previewBox.innerText = 'Translating...';

    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw })
    });

    const data = await res.json();

    // Show preview ONLY — do NOT mutate input
    if (previewBox) previewBox.innerText = data.translated || '[No translation returned]';

    console.log('[Translator Preview] Displayed read-only translation.');

  } catch (err) {
    if (previewBox) previewBox.innerText = '[Translation failed]';
    console.error('[Translator Preview Error]', err);
  }
});

// Reset preview when user edits text
if (document.getElementById('customerStates')) {
  document.getElementById('customerStates').addEventListener('input', () => {
    const previewBox = document.getElementById('translatePreview');
    if (previewBox) previewBox.innerText = 'Translation preview will appear here...';
  });
}


// ===============================
// RUN ESTIMATE (RAW ONLY)
// ===============================
// Backend handles translation internally.
// No pre-translation here to avoid double-pass.

function getCommonPayload() {
  const motorTypeSelect = document.getElementById('motorType');
  const motorType = motorTypeSelect ? motorTypeSelect.value : null;

  const repairKeywordInput = document.getElementById('repairKeyword');
  const repairKeyword = repairKeywordInput ? repairKeywordInput.value.trim() : '';

  const laborRateInput = document.getElementById('laborRate');
  const laborRate = laborRateInput ? Number(laborRateInput.value) || 85 : 85;

  const vinInput = document.getElementById('vin');
  const vin = vinInput ? vinInput.value.trim() : '';

  const yearMakeModel = document.getElementById('yearMakeModel')?.value?.trim() || '';

  const manualUrlInput = document.getElementById('manualUrl');
  const manualUrl = manualUrlInput ? manualUrlInput.value.trim() : '';

  const url = manualUrl || 'https://lemon-manuals.la/Hyundai/2005/Tucson%20V6-2.7L/Repair%20and%20Diagnosis/';

  return {
    url,
    repairKeyword,
    laborRate,
    vin,
    yearMakeModel,
    motorType
  };
}

async function runEstimate() {
  const raw = (document.getElementById('customerStates')?.value || '').trim();

  const common = typeof getCommonPayload === 'function' ? getCommonPayload() : {};

  const payload = {
    vin: common.vin || window.currentVIN || null,
    customerStates: raw ? [raw] : [],
    mechanicNotices: window.currentMechanicNotices || [],
    obdCodes: window.currentObdCodes || [],
    laborRate: common.laborRate || window.currentLaborRate || 65,
    partsCost: window.currentPartsCost || 0,
    partType: window.currentPartType || '',
    mileage: window.currentMileage || 0,
    customer: window.currentCustomer || {},
    history: window.currentHistory || [],
    manualUrl: common.url || ''
  };

  const estimate = await fetch('/api/full-estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json());

  renderEstimate(estimate);
}

