const CACHE_BUSTER = 'sksk-clear-job-v2';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try {
        const url = new URL(client.url);
        if (url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html')) {
          await client.navigate(client.url);
        }
      } catch (_) {}
    }
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.mode !== 'navigate') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin || (url.pathname !== '/' && url.pathname !== '/index.html')) return;

  event.respondWith((async () => {
    const response = await fetch(req);
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/html')) return response;

    let html = await response.text();
    if (html.includes('id="btnClearJob"')) {
      return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    const injection = `
<style id="clearJobStyles">
  .clear-job-wrap{max-width:780px;margin:-6px auto 16px;display:flex;justify-content:flex-end}
  .btn-clear-job{appearance:none;border:1px solid rgba(255,82,82,.35);border-radius:12px;padding:10px 14px;background:rgba(255,82,82,.08);color:#ff8a8a;font:700 .82rem Inter,system-ui,sans-serif;cursor:pointer;transition:all .2s ease}
  .btn-clear-job:hover{background:rgba(255,82,82,.16);border-color:rgba(255,82,82,.65);transform:translateY(-1px)}
  @media(max-width:600px){.clear-job-wrap{margin-top:-4px}.btn-clear-job{width:100%;min-height:44px}}
</style>
<script id="clearJobScript">
(function(){
  function resetField(id, value='') {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    if (el.dataset) {
      el.dataset.aiTranslated = '';
      el.dataset.aiKeywords = '';
    }
  }

  function clearResult(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'result-card';
    el.innerHTML = '';
  }

  function clearCurrentJob() {
    if (!confirm('Clear the current Estimate, Diagnosis, and Invoice and start a new job?')) return;

    try { localStorage.removeItem('sksk_form'); } catch (_) {}

    [
      'customerName','customerPhone','customerEmail','vehicleYear','vehicleMake','vehicleModel','vehicleTrim',
      'vin','customerStates','mechanicNotices','obdCodes',
      'diagVin','diagMileage','diagCodes','diagSymptoms','diagNotes',
      'invoiceCustomer','invoiceNumber','invoiceNotes'
    ].forEach(id => resetField(id));

    resetField('laborRate', '65');
    resetField('partsCost', '');
    resetField('invoiceTotal', '');

    clearResult('estimateResult');
    clearResult('diagnoseResult');

    const invoiceStatus = document.getElementById('invoiceStatus');
    if (invoiceStatus) {
      invoiceStatus.className = 'status-simple';
      invoiceStatus.textContent = 'Ready to generate.';
    }

    try { lastEstimate = null; } catch (_) {}

    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
    const estimateTabButton = document.querySelector('.tab[data-tab="estimateTab"]');
    const estimatePanel = document.getElementById('estimateTab');
    if (estimateTabButton) estimateTabButton.classList.add('active');
    if (estimatePanel) estimatePanel.classList.add('active');

    const first = document.getElementById('customerName');
    if (first) first.focus();
  }

  function mountClearButton() {
    if (document.getElementById('btnClearJob')) return;
    const tabs = document.querySelector('.tabs');
    if (!tabs) return;
    const wrap = document.createElement('div');
    wrap.className = 'clear-job-wrap';
    wrap.innerHTML = '<button type="button" class="btn-clear-job" id="btnClearJob">🧹 Clear / New Job</button>';
    tabs.insertAdjacentElement('afterend', wrap);
    document.getElementById('btnClearJob').addEventListener('click', clearCurrentJob);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountClearButton);
  else mountClearButton();
})();
</script>
`;

    html = html.replace('</body>', injection + '\n</body>');
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('cache-control', 'no-store');
    headers.set('x-sksk-ui-patch', CACHE_BUSTER);

    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  })());
});
