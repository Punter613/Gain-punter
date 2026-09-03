'use strict';

(() => {
  const unverifiedButton = document.getElementById('unverifiedDiagnosis');
  const saveButton = document.getElementById('saveTests');
  if (!unverifiedButton || !saveButton) return;

  const stableId = element => {
    if (element.dataset.evidenceId) return element.dataset.evidenceId;
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `ev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    element.dataset.evidenceId = id;
    return id;
  };

  async function atomicPost(path, body) {
    const response = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: text }; }
    if (!response.ok) {
      const error = new Error(data.error || data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function collectPendingEvidence(requireAny = false) {
    const results = [...document.querySelectorAll('.testResult')];
    const passes = [...document.querySelectorAll('.testPass')];
    const roles = [...document.querySelectorAll('.testEvidenceRole')];
    const faults = [...document.querySelectorAll('.testConfirmedFault')];
    const evidence = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i].value.trim();
      if (!result) continue;
      if (!meaningfulResult(result)) {
        throw new Error(`Enter an actual observation or measurement for test ${i + 1}; placeholders do not count.`);
      }
      const evidenceRole = roles[i]?.value || 'NEUTRAL';
      const confirmedFault = faults[i]?.value.trim() || '';
      if (evidenceRole === 'CONFIRMS' && !confirmedFault) {
        throw new Error(`Test ${i + 1} is marked CONFIRMS. Name the exact fault this physical result confirms.`);
      }
      const passValue = passes[i]?.value || '';
      evidence.push({
        id: stableId(results[i]),
        name: results[i].dataset.name,
        result,
        passed: passValue === '' ? null : passValue === 'true',
        evidenceRole,
        confirmedFault
      });
    }

    const extra = document.getElementById('extra');
    const extraResult = extra.value.trim();
    if (extraResult) {
      if (!meaningfulResult(extraResult)) {
        throw new Error('Additional mechanic finding must be an actual observation or measurement.');
      }
      evidence.push({
        id: stableId(extra),
        name: 'Additional mechanic finding',
        result: extraResult,
        passed: null,
        evidenceRole: 'NEUTRAL',
        confirmedFault: ''
      });
    }

    if (requireAny && !evidence.length) throw new Error('Enter at least one actual test result');
    return evidence;
  }

  function mergeSavedEvidence(items = []) {
    const byId = new Map((savedTests || []).map(item => [String(item?.id || ''), item]));
    for (const item of items || []) {
      if (item?.id) byId.set(String(item.id), item);
    }
    savedTests = [...byId.values()];
    testCount = savedTests.length;
    renderVerifyEvidence();
  }

  function clearPersistedInputs(items = []) {
    const ids = new Set((items || []).map(item => String(item?.id || '')).filter(Boolean));
    if (!ids.size) return;
    const results = [...document.querySelectorAll('.testResult')];
    const passes = [...document.querySelectorAll('.testPass')];
    const roles = [...document.querySelectorAll('.testEvidenceRole')];
    const faults = [...document.querySelectorAll('.testConfirmedFault')];

    results.forEach((element, index) => {
      if (!ids.has(element.dataset.evidenceId || '')) return;
      element.value = '';
      delete element.dataset.evidenceId;
      if (passes[index]) passes[index].value = '';
      if (roles[index]) roles[index].value = 'NEUTRAL';
      if (faults[index]) faults[index].value = '';
    });

    const extra = document.getElementById('extra');
    if (ids.has(extra.dataset.evidenceId || '')) {
      extra.value = '';
      delete extra.dataset.evidenceId;
    }
  }

  function renderUnverified(data) {
    const out = document.getElementById('unverifiedOut');
    const u = data.unverifiedDiagnosis || {};
    currentDiagnosisRevision = Math.max(1, Number(data.diagnosisRevision) || currentDiagnosisRevision);
    document.getElementById('candidate').textContent = `Revision ${currentDiagnosisRevision} · ${u.mostLikelyCause || 'No bounded diagnostic candidate'}`;
    document.getElementById('candidate').dataset.stale = '0';

    const confidence = [
      u.confidence?.rating,
      u.confidence?.percentage != null ? `${u.confidence.percentage}%` : null
    ].filter(Boolean).join(' · ');
    const why = (u.whySkskThinksThis || []).map(x => `<li>${esc(x)}</li>`).join('');
    const remaining = (u.whatRemainsUnverified || []).map(x => `<li>${esc(x)}</li>`).join('');
    const alternatives = (u.alternatives || []).length
      ? `<p class="muted"><b>Other candidates:</b> ${u.alternatives.map(esc).join(' · ')}</p>`
      : '';
    const savedLine = Number(data.evidenceSavedCount || 0) > 0
      ? `<div class="status ok">Saved ${Number(data.evidenceSavedCount)} new evidence item${Number(data.evidenceSavedCount) === 1 ? '' : 's'} before reassessment.</div>`
      : '';

    out.innerHTML = `<div class="result"><h3>🧠 Unverified Diagnosis · Revision ${currentDiagnosisRevision}</h3>${savedLine}<p><b>Most likely cause:</b> ${esc(u.mostLikelyCause || 'No bounded diagnostic candidate')}</p><p class="muted"><b>Confidence:</b> ${esc(confidence || 'LOW')}</p>${alternatives}<p class="muted"><b>Why SKSK thinks this:</b></p>${why ? `<ul class="muted">${why}</ul>` : '<p class="muted">Based on the persisted diagnostic case and available evidence.</p>'}<p class="muted"><b>What remains unverified:</b></p>${remaining ? `<ul class="muted">${remaining}</ul>` : '<p class="muted">Physical confirmation evidence is still required.</p>'}<div class="status warn">${esc(u.warning || 'This diagnosis has not been physically verified. It does not authorize a repair and does not unlock Estimate.')}</div></div>`;
  }

  const note = document.createElement('div');
  note.className = 'muted';
  note.style.marginTop = '8px';
  note.innerHTML = '<b>Atomic reassessment:</b> unsaved test findings are persisted first in the same action. If reassessment fails, the evidence stays saved and the prior diagnosis remains visibly stale.';
  unverifiedButton.closest('.actions')?.insertAdjacentElement('afterend', note);
  unverifiedButton.textContent = '🧠 Save Evidence + Get Unverified Diagnosis';

  saveButton.onclick = async () => {
    const out = document.getElementById('testOut');
    const original = saveButton.textContent;
    try {
      if (!jobId) throw new Error('Run diagnosis first');
      const evidence = collectPendingEvidence(true);
      saveButton.disabled = true;
      saveButton.textContent = '⏳ Saving evidence...';
      const data = await atomicPost(`/api/jobs/${encodeURIComponent(jobId)}/tests/batch`, { evidence });
      const persisted = [...(data.tests || []), ...(data.reusedTests || [])];
      mergeSavedEvidence(persisted);
      clearPersistedInputs(persisted);

      document.getElementById('candidate').textContent = 'New evidence recorded — diagnosis reassessment pending';
      document.getElementById('candidate').dataset.stale = '1';
      document.getElementById('unverifiedOut').innerHTML = '<div class="status warn">New evidence is persisted. The prior diagnosis is stale until reassessment succeeds.</div>';

      const eligible = verificationEligibleTests();
      out.innerHTML = `<div class="status ok">Saved ${Number(data.evidenceSavedCount || 0)} new test result${Number(data.evidenceSavedCount || 0) === 1 ? '' : 's'}${Number(data.evidenceReusedCount || 0) ? `; ${Number(data.evidenceReusedCount)} retry item${Number(data.evidenceReusedCount) === 1 ? '' : 's'} already existed and was not duplicated` : ''}. ${eligible.length ? `${eligible.length} confirmation-grade test${eligible.length === 1 ? ' is' : 's are'} eligible for explicit VERIFY.` : 'Reassess before relying on the previous AI candidate.'}</div>`;
      document.getElementById('verifyCard').hidden = !eligible.length;
      if (eligible.length) {
        setStatus('verifyStatus', 'Confirmation-grade evidence recorded. The AI candidate is stale until reassessment, but the physical CONFIRMS evidence remains available for explicit verification.', 'ok');
        stage('Verify');
      } else {
        stage('Test');
      }
    } catch (error) {
      out.innerHTML = `<div class="status bad">${esc(error.message)}</div>`;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = original;
    }
  };

  unverifiedButton.onclick = async () => {
    const out = document.getElementById('unverifiedOut');
    const original = unverifiedButton.textContent;
    let submitted = [];
    try {
      if (!jobId) throw new Error('Run diagnosis first');
      submitted = collectPendingEvidence(false);
      document.getElementById('estimateCard').hidden = true;
      document.getElementById('invoiceCard').hidden = true;
      unverifiedButton.disabled = true;
      unverifiedButton.textContent = '⏳ Saving + reassessing...';
      out.innerHTML = `<div class="status">${submitted.length ? 'Saving new mechanic evidence, invalidating the prior candidate, and reassessing from the persisted case...' : 'Reassessing from the persisted case evidence...'}</div>`;

      const data = await atomicPost(`/api/jobs/${encodeURIComponent(jobId)}/unverified-diagnosis`, { evidence: submitted });
      if (data.diagnosisState !== 'UNVERIFIED_DIAGNOSIS') {
        throw new Error('Backend did not return an UNVERIFIED_DIAGNOSIS');
      }

      const persisted = [...(data.savedEvidence || []), ...(data.reusedEvidence || [])];
      mergeSavedEvidence(persisted);
      clearPersistedInputs(persisted);
      renderUnverified(data);
      document.getElementById('testOut').innerHTML = Number(data.evidenceSavedCount || 0)
        ? `<div class="status ok">Evidence save + diagnosis reassessment completed as one serialized action. Revision ${Number(data.diagnosisRevision || 1)} is current.</div>`
        : document.getElementById('testOut').innerHTML;
      const eligible = verificationEligibleTests();
      document.getElementById('verifyCard').hidden = !eligible.length;
      stage(eligible.length ? 'Verify' : 'Test');
    } catch (error) {
      const data = error.data || {};
      const persisted = [...(data.savedEvidence || []), ...(data.reusedEvidence || [])];
      if (persisted.length) {
        mergeSavedEvidence(persisted);
        clearPersistedInputs(persisted);
      }
      if (data.diagnosisStale === true) {
        document.getElementById('candidate').textContent = 'Evidence saved — prior diagnosis STALE; reassessment failed';
        document.getElementById('candidate').dataset.stale = '1';
        out.innerHTML = `<div class="status bad"><b>Reassessment failed closed.</b><br>${esc(error.message)}<br><br>The mechanic evidence is preserved. Do not rely on the previous AI candidate as current. Retry this action to reassess the persisted evidence.</div>`;
        document.getElementById('testOut').innerHTML = `<div class="status ok">${Number(data.evidenceSavedCount || 0) ? `${Number(data.evidenceSavedCount)} new evidence item${Number(data.evidenceSavedCount) === 1 ? ' was' : 's were'} saved.` : 'Previously persisted evidence remains saved.'} No stale diagnosis was re-issued.</div>`;
      } else {
        out.innerHTML = `<div class="status bad">${esc(error.message)}</div>`;
      }
    } finally {
      unverifiedButton.disabled = false;
      unverifiedButton.textContent = '🧠 Save Evidence + Get Unverified Diagnosis';
    }
  };
})();
