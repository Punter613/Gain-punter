'use strict';

(() => {
  const ACTIVE_JOB_KEY = 'sksk_active_diag_job';
  const VERIFIED_JOB_KEY = 'sksk_verified_diag_job';

  function byId(id) {
    return document.getElementById(id);
  }

  function setSession(key, value) {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch (_) {}
  }

  function getSession(key) {
    try { return sessionStorage.getItem(key) || ''; }
    catch (_) { return ''; }
  }

  function showCardError(cardId, message) {
    const card = byId(cardId);
    if (!card) return;
    card.className = 'result-card visible error';
    card.innerHTML = `<div class="result-header"><div class="result-header-left">❌ Action Required</div></div><div class="result-body"><div class="result-text">${message}</div></div>`;
  }

  async function postJson(url, payload) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await readBody(res);
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function activateTab(tabId) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
    const button = document.querySelector(`.tab[data-tab="${tabId}"]`);
    const panel = byId(tabId);
    if (button) button.classList.add('active');
    if (panel) panel.classList.add('active');
  }

  function syncEstimateFormFromDiagnosis(confirmedCause) {
    const diagVin = (byId('diagVin')?.value || '').trim();
    if (diagVin && byId('vin')) byId('vin').value = diagVin;
    if (byId('customerStates')) byId('customerStates').value = byId('diagSymptoms')?.value || '';

    const notes = (byId('diagNotes')?.value || '').trim();
    if (byId('mechanicNotices')) {
      byId('mechanicNotices').value = [notes, confirmedCause ? `Verified fault: ${confirmedCause}` : ''].filter(Boolean).join('\n');
    }
    if (byId('obdCodes')) byId('obdCodes').value = byId('diagCodes')?.value || '';

    try {
      const active = activeVehicleForVin(diagVin);
      if (active && Object.keys(active).length) {
        if (byId('vehicleYear')) byId('vehicleYear').value = active.year || byId('vehicleYear').value;
        if (byId('vehicleMake')) byId('vehicleMake').value = active.make || byId('vehicleMake').value;
        if (byId('vehicleModel')) byId('vehicleModel').value = active.model || byId('vehicleModel').value;
        if (byId('vehicleTrim')) byId('vehicleTrim').value = [active.trim, active.engine].filter(Boolean).join(' ') || byId('vehicleTrim').value;
      }
    } catch (_) {}

    if (typeof saveForm === 'function') saveForm();
  }

  function appendVerificationPanel(result, jobId) {
    const card = byId('diagnoseResult');
    const body = card?.querySelector('.result-body');
    if (!body) return;

    const old = byId('skskVerificationPanel');
    if (old) old.remove();

    const suggestedTest = Array.isArray(result?.recommendedTests) && result.recommendedTests.length
      ? result.recommendedTests[0]
      : '';

    const panel = document.createElement('div');
    panel.id = 'skskVerificationPanel';
    panel.className = 'result-section';
    panel.innerHTML = `
      <div class="result-section-title"><span class="icon">🧪</span> Test → Verify Gate</div>
      <div class="result-muted">Job ${jobId}. Record what you actually tested. Estimate stays locked until you explicitly verify a bounded fault.</div>
      <div class="grid-1" style="margin-top:8px">
        <div class="field">
          <label>Test performed</label>
          <input id="skskTestName" type="text" value="${suggestedTest.replace(/"/g, '&quot;')}" placeholder="Example: compare all four wheel-speed PIDs">
        </div>
        <div class="field">
          <label>Observed test result</label>
          <textarea id="skskTestResult" placeholder="What did the test physically/measurably show?"></textarea>
        </div>
        <button type="button" class="btn" id="skskRecordTest">Record Test Result</button>
        <div class="field">
          <label>Confirmed fault — mechanic enters this after the test</label>
          <input id="skskConfirmedCause" type="text" placeholder="Do not copy the AI guess unless your test actually confirmed it">
        </div>
        <button type="button" class="btn primary" id="skskVerifyFault" disabled>✅ Verify Fault & Unlock Estimate</button>
        <div class="status-simple" id="skskVerifyStatus">Waiting for a recorded test.</div>
      </div>`;
    body.appendChild(panel);

    byId('skskRecordTest')?.addEventListener('click', async () => {
      const name = (byId('skskTestName')?.value || '').trim();
      const testResult = (byId('skskTestResult')?.value || '').trim();
      const status = byId('skskVerifyStatus');
      if (!name || !testResult) {
        if (status) {
          status.className = 'status-simple error';
          status.textContent = 'Enter both the test performed and the observed result.';
        }
        return;
      }

      try {
        await postJson(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/tests`, {
          name,
          result: testResult,
          notes: 'Recorded from ProTech diagnosis verification gate'
        });
        if (status) {
          status.className = 'status-simple success';
          status.textContent = 'Test recorded. Enter the specific fault this evidence confirmed.';
        }
        if (byId('skskVerifyFault')) byId('skskVerifyFault').disabled = false;
      } catch (err) {
        if (status) {
          status.className = 'status-simple error';
          status.textContent = err.message;
        }
      }
    });

    byId('skskVerifyFault')?.addEventListener('click', async () => {
      const confirmedCause = (byId('skskConfirmedCause')?.value || '').trim();
      const conclusion = (byId('skskTestResult')?.value || '').trim();
      const status = byId('skskVerifyStatus');
      if (!confirmedCause) {
        if (status) {
          status.className = 'status-simple error';
          status.textContent = 'Name the fault your test confirmed before verifying.';
        }
        return;
      }

      try {
        const data = await postJson(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/verify`, {
          confirmed: true,
          confirmedCause,
          conclusion,
          notes: 'Explicit mechanic verification from ProTech UI'
        });
        if (data.status !== 'VERIFIED') throw new Error('Job did not enter VERIFIED state.');

        setSession(VERIFIED_JOB_KEY, jobId);
        syncEstimateFormFromDiagnosis(confirmedCause);
        if (status) {
          status.className = 'status-simple success';
          status.textContent = '✅ Fault verified. Estimate is unlocked for this job.';
        }
        activateTab('estimateTab');
      } catch (err) {
        if (status) {
          status.className = 'status-simple error';
          status.textContent = err.message;
        }
      }
    });
  }

  async function runProtectedDiagnosis(button) {
    setLoading(button, true);
    const card = byId('diagnoseResult');
    if (card) card.className = 'result-card';

    try {
      const dsField = byId('diagSymptoms');
      if (dsField && dsField.value.trim() && dsField.dataset.aiTranslated !== '1') {
        await translateCustomerSpeak('diagSymptoms', byId('btnTranslateDiag'), { silent: true });
      }

      let keywords = [];
      try { keywords = JSON.parse(dsField?.dataset.aiKeywords || '[]'); }
      catch (_) { keywords = []; }

      const diagVin = (byId('diagVin')?.value || '').trim();
      const payload = {
        vin: diagVin,
        vehicle: activeVehicleForVin(diagVin),
        mileage: Number(byId('diagMileage')?.value || 0),
        symptoms: splitLines(byId('diagSymptoms')?.value || ''),
        codes: splitList(byId('diagCodes')?.value || ''),
        notes: splitLines(byId('diagNotes')?.value || ''),
        keywords
      };

      const data = await postJson(`${API_BASE}/api/diagnose`, payload);
      if (!data.jobId) throw new Error('Diagnosis returned without a job ID; verification cannot continue safely.');

      setSession(ACTIVE_JOB_KEY, data.jobId);
      setSession(VERIFIED_JOB_KEY, '');
      renderDiagnose(data.result || {});
      appendVerificationPanel(data.result || {}, data.jobId);
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showCardError('diagnoseResult', err.message || 'Diagnosis failed');
    } finally {
      setLoading(button, false);
    }
  }

  async function runProtectedEstimate(button) {
    const jobId = getSession(VERIFIED_JOB_KEY);
    if (!jobId) {
      showCardError('estimateResult', 'Run Diagnose, record the confirmation test, and explicitly verify the fault before generating an estimate.');
      activateTab('diagnoseTab');
      return;
    }

    setLoading(button, true);
    const card = byId('estimateResult');
    if (card) card.className = 'result-card';

    try {
      const csField = byId('customerStates');
      if (csField && csField.value.trim() && csField.dataset.aiTranslated !== '1') {
        await translateCustomerSpeak('customerStates', byId('btnTranslate'), { silent: true });
      }

      let keywords = [];
      try { keywords = JSON.parse(csField?.dataset.aiKeywords || '[]'); }
      catch (_) { keywords = []; }

      const vin = (byId('vin')?.value || '').trim();
      const active = activeVehicleForVin(vin);
      const payload = {
        jobId,
        customer: {
          name: (byId('customerName')?.value || '').trim(),
          phone: (byId('customerPhone')?.value || '').trim(),
          email: (byId('customerEmail')?.value || '').trim()
        },
        vehicle: {
          ...active,
          year: parseInt((byId('vehicleYear')?.value || '').trim(), 10) || active.year || '',
          make: (byId('vehicleMake')?.value || '').trim() || active.make || '',
          model: (byId('vehicleModel')?.value || '').trim() || active.model || '',
          trim: (byId('vehicleTrim')?.value || '').trim() || active.trim || ''
        },
        obdCodes: splitList(byId('obdCodes')?.value || ''),
        customerStates: splitLines(byId('customerStates')?.value || ''),
        mechanicNotices: splitLines(byId('mechanicNotices')?.value || ''),
        keywords,
        laborRate: Number(byId('laborRate')?.value || 0),
        partsCost: Number(byId('partsCost')?.value || 0),
        vin
      };

      const data = await postJson(`${API_BASE}/api/estimateHeuristic`, payload);
      renderEstimate(data.estimate || {});
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showCardError('estimateResult', err.message || 'Estimate failed');
    } finally {
      setLoading(button, false);
    }
  }

  // Capture phase prevents the legacy inline handlers from firing in parallel.
  document.addEventListener('click', event => {
    const diagnoseButton = event.target.closest?.('#btnDiagnose');
    if (diagnoseButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      runProtectedDiagnosis(diagnoseButton);
      return;
    }

    const estimateButton = event.target.closest?.('#btnEstimate');
    if (estimateButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      runProtectedEstimate(estimateButton);
      return;
    }

    const clearButton = event.target.closest?.('#btnClearJob');
    if (clearButton) {
      setSession(ACTIVE_JOB_KEY, '');
      setSession(VERIFIED_JOB_KEY, '');
    }
  }, true);
})();
