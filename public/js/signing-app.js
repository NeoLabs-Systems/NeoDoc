'use strict';
/* ── DocumentNeo Signing — sender/manager app ─────────────────────────── */

// ── Resolve PDF.js path (served from node_modules via Express) ────────────
const PDFJS_URL = '/js/pdfjs/pdf.mjs';

// ── Auth + API helpers ────────────────────────────────────────────────────
const TOKEN_KEY = 'dn_token';
const token = () => localStorage.getItem(TOKEN_KEY);
function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` }; }

async function api(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api' + path, opts);
  if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); location.href = '/login?next=/signing'; throw new Error('Not authenticated'); }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── State ─────────────────────────────────────────────────────────────────
const State = {
  envelopes: [],
  currentEnvId: null,
  fields: [],          // field objects being edited  { id, signer_id, type, page, x, y, w, h, label, required, _new }
  selectedSigner: null,
  selectedFieldType: null,
  pdfjsLib: null,
  pdfDocs: {},         // pageCount per envId
  pdfPageCanvases: {}, // { envId: [HTMLElement, …] }
  draggingField: null,
  signers: [],         // signers for current edited envelope
};

// ── Signer colour pool ────────────────────────────────────────────────────
const SIGNER_COLOURS = ['#6366f1','#ec4899','#f59e0b','#22c55e','#06b6d4','#8b5cf6'];

// ── Field type definitions ────────────────────────────────────────────────
const FIELD_TYPES = [
  { type: 'signature', label: 'Signature',  icon: '✍️', bg: '#6366f110', border: '#6366f1' },
  { type: 'initials',  label: 'Initials',   icon: 'I',  bg: '#8b5cf610', border: '#8b5cf6' },
  { type: 'date',      label: 'Date',       icon: '📅', bg: '#f59e0b10', border: '#f59e0b' },
  { type: 'text',      label: 'Text',       icon: 'T',  bg: '#06b6d410', border: '#06b6d4' },
  { type: 'checkbox',  label: 'Checkbox',   icon: '☑',  bg: '#22c55e10', border: '#22c55e' },
];

/* ════════════════════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════════════════════ */
async function init() {
  if (!token()) { location.href = '/login?next=/signing'; return; }

  // Verify token is still valid
  try {
    await api('GET', '/auth/me');
  } catch { location.href = '/login?next=/signing'; return; }

  // Load PDF.js
  try {
    State.pdfjsLib = await import(PDFJS_URL);
    State.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/pdfjs/pdf.worker.mjs';
  } catch (e) {
    console.warn('PDF.js failed to load:', e.message);
  }

  bindSidebar();
  await loadEnvelopes();
  navTo('envelopes');
}

function bindSidebar() {
  document.getElementById('nav-envelopes').onclick = () => navTo('envelopes');
  document.getElementById('nav-new-envelope').onclick = () => navTo('new');
  document.getElementById('nav-settings').onclick = openSettings;
  document.getElementById('signout-btn').onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    location.href = '/login';
  };
}

async function loadEnvelopes() {
  try {
    State.envelopes = await api('GET', '/signing/envelopes');
    document.getElementById('envelope-count-badge').textContent = State.envelopes.length;
  } catch (e) {
    toast('Failed to load envelopes: ' + e.message, 'error');
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   NAVIGATION
   ════════════════════════════════════════════════════════════════════════════ */
function navTo(view, data) {
  document.querySelectorAll('.signing-nav-item').forEach(n => n.classList.remove('active'));
  const navMap = { envelopes: 'nav-envelopes', new: 'nav-new-envelope' };
  if (navMap[view]) document.getElementById(navMap[view])?.classList.add('active');

  const content = document.getElementById('signing-content');
  const title   = document.getElementById('signing-page-title');
  const actions = document.getElementById('signing-topbar-actions');
  actions.innerHTML = '';

  switch (view) {
    case 'envelopes':
      title.textContent = 'My Envelopes';
      actions.innerHTML = `<button class="btn btn-primary btn-sm" onclick="window.SigningApp.navTo('new')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Envelope</button>`;
      renderEnvelopeList(content);
      break;
    case 'new':
      title.textContent = 'New Envelope';
      renderNewEnvelopeForm(content);
      break;
    case 'editor':
      title.textContent = 'Field Editor';
      actions.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.autoDetectFields()" title="Auto-place fields from PDF form fields">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Auto-Detect</button>
        <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.navTo('envelopes')">&#8592; Back</button>
        <button class="btn btn-primary btn-sm" id="save-fields-btn" onclick="window.SigningApp.saveAndContinue('${esc(data.id)}')">Save &amp; Continue &#8594;</button>`;
      renderFieldEditor(content, data);
      break;
    case 'detail':
      renderDetail(content, data);
      break;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ENVELOPE LIST
   ════════════════════════════════════════════════════════════════════════════ */
function renderEnvelopeList(container) {
  if (!State.envelopes.length) {
    container.innerHTML = `
      <div class="signing-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><polyline points="9 15 11 17 15 13"/></svg>
        <h3>No envelopes yet</h3>
        <p>Create your first signing envelope to get started.</p>
        <button class="btn btn-primary" onclick="window.SigningApp.navTo('new')">Create Envelope</button>
      </div>`;
    return;
  }

  const statusText = { draft: 'Draft', out_for_signature: 'Out for Signature', completed: 'Completed', voided: 'Voided' };

  container.innerHTML = `<div class="envelope-grid">${State.envelopes.map(e => {
    const dots = Array.from({ length: e.signer_count }, (_, i) =>
      `<div class="signing-progress-dot${i < e.signed_count ? ' signed' : ''}"></div>`
    ).join('');
    return `
    <div class="envelope-card" onclick="window.SigningApp.openDetail('${e.id}')">
      <div class="envelope-card-header">
        <div class="envelope-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><polyline points="9 15 11 17 15 13"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div class="envelope-card-title">${esc(e.title)}</div>
          <div class="envelope-card-meta">
            <span>${esc(e.doc_title || 'No document')}</span>
            <span>${new Date(e.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
      <div class="envelope-card-footer">
        <span class="status-badge ${e.status}">${statusText[e.status] || e.status}</span>
        <div class="signing-progress">
          <div class="signing-progress-dots">${dots}</div>
          <span>${e.signed_count}/${e.signer_count} signed</span>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

async function openDetail(id) {
  try {
    const data = await api('GET', `/signing/envelopes/${id}`);
    navTo('detail', data);
  } catch (e) { toast(e.message, 'error'); }
}

/* ════════════════════════════════════════════════════════════════════════════
   NEW ENVELOPE FORM
   ════════════════════════════════════════════════════════════════════════════ */
let _docPickerItems = [];
function renderNewEnvelopeForm(container) {
  // Load documents for selector
  fetchDocumentsForSelect(container);
}

async function fetchDocumentsForSelect(container) {
  let docList = [];
  try {
    // Fetch up to 500 docs sorted by most recent; only PDFs are useful for signing
    const r = await api('GET', '/documents?limit=500&sort=updated_at&order=desc');
    const all = r.documents || r.data || (Array.isArray(r) ? r : []);
    docList = all.filter(d => d.mime_type === 'application/pdf' || !d.mime_type);
    if (!docList.length) docList = all; // fallback: show everything if no PDFs
    _docPickerItems = docList;
  } catch (_) {}

  container.innerHTML = `
  <div class="create-envelope-form">
    <div class="form-section">
      <h3>Document &amp; Details</h3>
      <div class="form-row">
        <label>Envelope Title *</label>
        <input type="text" id="env-title" placeholder="e.g. NDA Agreement — January 2026" maxlength="255" autofocus>
      </div>
      <div class="form-row">
        <label>Document to Sign</label>
        <div style="position:relative" id="doc-picker-wrap">
          <input type="text" id="doc-picker-search" autocomplete="off" placeholder="Search documents…"
            style="width:100%;box-sizing:border-box"
            oninput="window.SigningApp._docPickerFilter(this.value)"
            onfocus="window.SigningApp._docPickerOpen()"
            onblur="setTimeout(()=>window.SigningApp._docPickerClose(),180)"
            onkeydown="window.SigningApp._docPickerKey(event)">
          <input type="hidden" id="env-document" value="">
          <div id="doc-picker-dropdown" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);
               background:var(--surface);border:1px solid var(--border);border-radius:8px;
               box-shadow:0 6px 20px rgba(0,0,0,.15);z-index:9999;max-height:260px;overflow-y:auto"></div>
        </div>
      </div>
      <div class="form-row">
        <label>Message to Signers (optional)</label>
        <textarea id="env-message" placeholder="Please review and sign this agreement." maxlength="2000"></textarea>
      </div>
      <div class="form-row">
        <label>Custom Email Subject (optional)
          <span style="font-size:.74rem;font-weight:400;color:var(--text-3)">Override the default subject line of invitation emails</span>
        </label>
        <input type="text" id="env-email-subject" placeholder="e.g. Please review and sign your NDA" maxlength="500">
      </div>
      <div class="toggle-row" style="margin-top:.25rem;margin-bottom:.25rem">
        <div>
          <span>Send copy to all signers once document is fully signed</span>
          <div style="font-size:.77rem;color:var(--text-3);margin-top:.1rem">Requires SMTP to be configured in Settings</div>
        </div>
        <input type="checkbox" class="toggle" id="env-send-copy">
      </div>
    </div>

    <div class="form-section">
      <h3>Signers</h3>
      <p style="font-size:.79rem;color:var(--text-3);margin-bottom:.75rem">Add people who need to sign. Each will receive a unique, secure signing link.</p>
      <div class="signer-list" id="signer-list">
        <div class="signer-row" data-idx="0">
          <div class="signer-color-dot" style="background:${SIGNER_COLOURS[0]}"></div>
          <input type="text"  placeholder="Full name" class="signer-name">
          <input type="email" placeholder="Email address" class="signer-email">
          <button class="signer-remove-btn" onclick="removeSigner(this)" title="Remove">✕</button>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="add-signer-btn" onclick="window.SigningApp.addSignerRow()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Signer
      </button>
    </div>

    <div style="display:flex;gap:.75rem;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="window.SigningApp.navTo('envelopes')">Cancel</button>
      <button class="btn btn-primary" onclick="window.SigningApp.submitNewEnvelope()">
        Create &amp; Edit Fields →
      </button>
    </div>
  </div>`;
}

function addSignerRow() {
  const list = document.getElementById('signer-list');
  const idx  = list.children.length;
  const color = SIGNER_COLOURS[idx % SIGNER_COLOURS.length];
  const div  = document.createElement('div');
  div.className = 'signer-row';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="signer-color-dot" style="background:${color}"></div>
    <input type="text"  placeholder="Full name"  class="signer-name">
    <input type="email" placeholder="Email address" class="signer-email">
    <button class="signer-remove-btn" onclick="removeSigner(this)" title="Remove">✕</button>`;
  list.appendChild(div);
}

function removeSigner(btn) {
  const row = btn.closest('.signer-row');
  if (document.querySelectorAll('.signer-row').length <= 1) { toast('Need at least one signer.', 'warn'); return; }
  row.remove();
}

async function submitNewEnvelope() {
  const title = document.getElementById('env-title')?.value?.trim();
  if (!title) { toast('Title is required.', 'warn'); return; }

  const document_id = document.getElementById('env-document')?.value || null;
  const message      = document.getElementById('env-message')?.value?.trim() || '';
  const email_subject= document.getElementById('env-email-subject')?.value?.trim() || '';
  const send_copy    = document.getElementById('env-send-copy')?.checked || false;

  const rows = document.querySelectorAll('.signer-row');
  const signers = [];
  for (const row of rows) {
    const name  = row.querySelector('.signer-name')?.value?.trim();
    const email = row.querySelector('.signer-email')?.value?.trim();
    if (!name || !email) { toast('All signer name and email fields are required.', 'warn'); return; }
    signers.push({ name, email });
  }

  try {
    const result = await api('POST', '/signing/envelopes', {
      title, document_id: document_id || undefined, message, signers,
      email_subject: email_subject || undefined, send_copy,
    });
    toast('Envelope created.', 'success');
    await loadEnvelopes();
    // Go to field editor
    const detail = await api('GET', `/signing/envelopes/${result.id}`);
    navTo('editor', detail);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   FIELD EDITOR
   ════════════════════════════════════════════════════════════════════════════ */
function renderFieldEditor(container, env) {
  State.currentEnvId = env.id;
  State.signers      = env.signers || [];
  State.fields       = (env.fields || []).map(f => ({ ...f, _new: false }));
  State.selectedSigner = State.signers[0]?.id || null;
  State.selectedFieldType = 'signature';

  // Update save button
  const saveBtn = document.getElementById('save-fields-btn');
  if (saveBtn) saveBtn.onclick = () => saveAndContinue(env.id);

  container.innerHTML = `
  <div class="field-editor" id="field-editor">

    <!-- Left palette -->
    <div class="field-palette" id="field-palette">
      <div class="field-palette-title">Field Types</div>
      <p style="font-size:.74rem;color:var(--text-3);margin-bottom:.5rem">Select a signer, then drag a field type onto the document.</p>
      ${FIELD_TYPES.map(ft => `
        <div class="palette-field-btn" draggable="true"
          data-type="${ft.type}"
          id="palette-${ft.type}"
          title="Drag onto PDF to place">
          <div class="palette-field-icon" style="background:${ft.bg};color:${ft.border}">${ft.icon}</div>
          ${ft.label}
        </div>`).join('')}

      <div class="field-palette-title" style="margin-top:1rem">Signer</div>
      <div class="signer-legend" id="signer-legend">
        ${State.signers.map((s, i) => `
          <div class="signer-legend-item${i === 0 ? ' selected' : ''}"
            data-id="${s.id}" onclick="window.SigningApp.selectSigner('${s.id}')">
            <div class="signer-dot" style="background:${s.color}"></div>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span>
          </div>`).join('')}
      </div>

      ${!env.document_id ? `
      <div style="margin-top:1rem;padding:.6rem;background:var(--warn)15;border:1px solid var(--warn)40;border-radius:var(--radius-sm);font-size:.75rem;color:var(--warn)">
        ⚠️ No document attached. Attach a document first or the PDF viewer won't appear.
      </div>` : ''}
    </div>

    <!-- PDF canvas area -->
    <div class="pdf-canvas-area" id="pdf-canvas-area">
      ${env.document_id ? `
        <div class="signing-empty" id="pdf-loading">
          <div class="spinner" style="width:28px;height:28px;border-width:2px"></div>
          <p>Rendering PDF…</p>
        </div>` : `
        <div class="signing-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <p>No document attached to this envelope.</p>
        </div>`}
    </div>

    <!-- Right fields panel -->
    <div class="fields-panel" id="fields-panel">
      <div class="fields-panel-title">Placed Fields</div>
      <div id="placed-fields-list" style="display:flex;flex-direction:column;gap:.35rem;margin-top:.35rem"></div>
      <div style="margin-top:auto;padding-top:.75rem;border-top:1px solid var(--border);font-size:.75rem;color:var(--text-3)">
        Drop fields from the left palette onto any page.
      </div>
    </div>
  </div>`;

  // Bind palette drag events
  document.querySelectorAll('.palette-field-btn').forEach(btn => {
    btn.addEventListener('dragstart', e => {
      State.selectedFieldType = btn.dataset.type;
      e.dataTransfer.setData('text/plain', btn.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  renderPlacedFieldsList();

  if (env.document_id) {
    loadEditorPdf(env.id);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTO-DETECT FIELDS FROM PDF ANNOTATIONS
   ══════════════════════════════════════════════════════════════════════════════ */
async function autoDetectFields() {
  if (!State.selectedSigner) { toast('Select a signer first, then click Auto-Detect.', 'warn'); return; }
  if (!State.currentPdfDoc)  { toast('PDF not loaded yet. Please wait for the document to render.', 'warn'); return; }

  const numPages = State.currentPdfDoc.numPages;
  const detected = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await State.currentPdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = await page.getAnnotations();

    for (const ann of annotations) {
      if (ann.subtype !== 'Widget') continue;
      const rect = ann.rect; // [x1, y1, x2, y2] PDF coords (y from bottom)
      if (!rect || rect.length < 4) continue;

      // Convert to % of page dimensions (PDF origin is bottom-left)
      const xPct = (rect[0] / viewport.width)  * 100;
      const yPct = ((viewport.height - rect[3]) / viewport.height) * 100;
      const wPct = ((rect[2] - rect[0]) / viewport.width)  * 100;
      const hPct = ((rect[3] - rect[1]) / viewport.height) * 100;

      // Map annotation fieldType to our types
      let type = 'text';
      if (ann.fieldType === 'Sig') {
        type = 'signature';
      } else if (ann.fieldType === 'Btn') {
        type = 'checkbox';
      } else if (ann.fieldType === 'Tx') {
        // Heuristic: if field name contains 'sign' or 'initial' treat as signature
        const name = (ann.fieldName || '').toLowerCase();
        if (name.includes('sign'))    type = 'signature';
        else if (name.includes('init')) type = 'initials';
        else if (name.includes('date')) type = 'date';
        else                            type = 'text';
      }

      const signer = State.signers.find(s => s.id === State.selectedSigner);
      detected.push({
        id: 'new_' + Date.now() + '_' + detected.length,
        envelope_id: State.currentEnvId,
        signer_id: State.selectedSigner,
        type,
        page: pageNum,
        x: Math.max(0, Math.min(98 - wPct, xPct)),
        y: Math.max(0, Math.min(98 - hPct, yPct)),
        w: Math.max(2, wPct),
        h: Math.max(2, hPct),
        label: ann.fieldName || '',
        required: true,
        _new: true,
        _color: signer?.color || '#6366f1',
      });
    }
  }

  if (detected.length === 0) {
    toast('No form fields found in this PDF. Place fields manually by dragging from the palette.', 'info');
    return;
  }

  // Warn if existing fields would be replaced
  if (State.fields.length > 0) {
    if (!confirm(`Replace ${State.fields.length} existing field(s) with ${detected.length} auto-detected field(s)?`)) return;
    State.fields = [];
  }

  State.fields.push(...detected);
  refreshFieldOverlays();
  renderPlacedFieldsList();
  toast(`Auto-detected ${detected.length} field(s) from the PDF.`, 'success');
}

function selectSigner(id) {
  State.selectedSigner = id;
  document.querySelectorAll('.signer-legend-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
}

async function loadEditorPdf(envId) {
  if (!State.pdfjsLib) return;

  try {
    const pdfUrl = `/api/signing/envelopes/${envId}/document`;
    const headers = { 'Authorization': `Bearer ${token()}` };
    const response = await fetch(pdfUrl, { headers });
    if (!response.ok) throw new Error('Failed to load PDF');
    const arrayBuf = await response.arrayBuffer();

    const pdfDoc = await State.pdfjsLib.getDocument({ data: arrayBuf }).promise;
    State.currentPdfDoc = pdfDoc;  // store for auto-detect
    const container = document.getElementById('pdf-canvas-area');
    container.innerHTML = '';

    State.pdfPageCanvases[envId] = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page    = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1.4 });
      const wrap    = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.style.width  = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      const canvas  = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;

      const overlay = document.createElement('div');
      overlay.className = 'field-overlay-layer';
      overlay.style.pointerEvents = 'all';

      wrap.appendChild(canvas);
      wrap.appendChild(overlay);
      container.appendChild(wrap);

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      State.pdfPageCanvases[envId].push(wrap);

      // Drop target events
      const pageNum = i;
      wrap.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        wrap.classList.add('drop-target');
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
      wrap.addEventListener('drop', e => {
        e.preventDefault();
        wrap.classList.remove('drop-target');
        handleFieldDrop(e, pageNum, wrap);
      });
    }

    // Render existing fields after PDF loads
    refreshFieldOverlays();

  } catch (e) {
    const loading = document.getElementById('pdf-loading');
    if (loading) loading.innerHTML = `<p style="color:var(--danger)">Failed to load PDF: ${esc(e.message)}</p>`;
  }
}

function handleFieldDrop(e, pageNum, wrap) {
  if (!State.selectedSigner) { toast('Select a signer first.', 'warn'); return; }

  const rect = wrap.getBoundingClientRect();
  const relX = ((e.clientX - rect.left) / rect.width)  * 100;
  const relY = ((e.clientY - rect.top)  / rect.height) * 100;

  const ft = FIELD_TYPES.find(f => f.type === State.selectedFieldType) || FIELD_TYPES[0];

  // Default sizes per type (% of page)
  const sizeMap = {
    signature: { w: 22, h: 7 },
    initials:  { w: 12, h: 6 },
    date:      { w: 16, h: 5 },
    text:      { w: 25, h: 5 },
    checkbox:  { w:  5, h: 4.5 },
  };
  const { w, h } = sizeMap[ft.type] || { w: 18, h: 5 };

  const signer = State.signers.find(s => s.id === State.selectedSigner);
  const field = {
    id: 'new_' + Date.now(),
    envelope_id: State.currentEnvId,
    signer_id: State.selectedSigner,
    type: ft.type,
    page: pageNum,
    x: Math.max(0, Math.min(100 - w, relX - w / 2)),
    y: Math.max(0, Math.min(100 - h, relY - h / 2)),
    w, h,
    label: '',
    required: true,
    _new: true,
    _color: signer?.color || '#6366f1',
  };

  State.fields.push(field);
  refreshFieldOverlays();
  renderPlacedFieldsList();
}

function refreshFieldOverlays() {
  const envId = State.currentEnvId;
  if (!State.pdfPageCanvases[envId]) return;

  State.pdfPageCanvases[envId].forEach((wrap, i) => {
    const overlay = wrap.querySelector('.field-overlay-layer');
    if (!overlay) return;
    overlay.innerHTML = '';

    const pageNum = i + 1;
    const pageFields = State.fields.filter(f => f.page === pageNum);

    pageFields.forEach(field => {
      const signer = State.signers.find(s => s.id === field.signer_id);
      const color  = field._color || signer?.color || '#6366f1';
      const ft     = FIELD_TYPES.find(f => f.type === field.type) || FIELD_TYPES[0];

      const el = document.createElement('div');
      el.className   = 'signing-field';
      el.dataset.fid = field.id;
      el.style.cssText = `
        left:${field.x}%; top:${field.y}%; width:${field.w}%; height:${field.h}%;
        border-color:${color}; background:${color}18; color:${color};`;

      el.innerHTML = `
        <span style="font-size:11px">${ft.icon}</span>
        <span class="signing-field-label">${esc(ft.label)}</span>
        <span class="signing-field-resize" title="Resize">⤡</span>`;

      // Move drag
      makeDraggableField(el, field, wrap);
      // Resize
      el.querySelector('.signing-field-resize').addEventListener('mousedown', e => {
        e.stopPropagation();
        startResizeField(e, field, wrap);
      });
      // Right-click or double-click to delete
      el.addEventListener('dblclick', () => {
        State.fields = State.fields.filter(f => f.id !== field.id);
        refreshFieldOverlays();
        renderPlacedFieldsList();
      });

      overlay.appendChild(el);
    });
  });
}

function makeDraggableField(el, field, wrap) {
  let startX, startY, origX, origY;
  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('signing-field-resize')) return;
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    origX  = field.x;   origY  = field.y;

    const onMove = mv => {
      const dx = ((mv.clientX - startX) / rect.width)  * 100;
      const dy = ((mv.clientY - startY) / rect.height) * 100;
      field.x = Math.max(0, Math.min(100 - field.w, origX + dx));
      field.y = Math.max(0, Math.min(100 - field.h, origY + dy));
      el.style.left = field.x + '%';
      el.style.top  = field.y + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function startResizeField(e, field, wrap) {
  e.preventDefault();
  const rect  = wrap.getBoundingClientRect();
  const origW = field.w, origH = field.h;
  const startX = e.clientX, startY = e.clientY;

  const onMove = mv => {
    const dw = ((mv.clientX - startX) / rect.width)  * 100;
    const dh = ((mv.clientY - startY) / rect.height) * 100;
    field.w  = Math.max(4, origW + dw);
    field.h  = Math.max(3, origH + dh);
    refreshFieldOverlays();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function renderPlacedFieldsList() {
  const list = document.getElementById('placed-fields-list');
  if (!list) return;
  if (!State.fields.length) {
    list.innerHTML = `<p style="font-size:.75rem;color:var(--text-3)">No fields placed yet.</p>`;
    return;
  }
  list.innerHTML = State.fields.map(f => {
    const signer = State.signers.find(s => s.id === f.signer_id);
    const ft = FIELD_TYPES.find(x => x.type === f.type) || FIELD_TYPES[0];
    return `
    <div class="field-item" data-fid="${f.id}">
      <div class="field-item-dot" style="background:${signer?.color||'#6366f1'}"></div>
      <div style="flex:1;min-width:0">
        <div class="field-item-type">${ft.label}</div>
        <div style="font-size:.69rem;color:var(--text-3)">p.${f.page} · ${esc(signer?.name||'?')}</div>
      </div>
      <button class="field-item-del" title="Delete" onclick="window.SigningApp.deleteField('${f.id}')">✕</button>
    </div>`;
  }).join('');
}

function deleteField(id) {
  State.fields = State.fields.filter(f => f.id !== id);
  refreshFieldOverlays();
  renderPlacedFieldsList();
}

async function saveAndContinue(envId) {
  try {
    const fieldsPayload = State.fields.map(({ id, signer_id, type, page, x, y, w, h, label, required }) => ({
      id: id.startsWith('new_') ? undefined : id,
      signer_id, type, page, x, y, w, h, label, required
    }));
    await api('PUT', `/signing/envelopes/${envId}`, { fields: fieldsPayload });
    toast('Fields saved.', 'success');
    const detail = await api('GET', `/signing/envelopes/${envId}`);
    navTo('detail', detail);
  } catch (e) { toast('Error saving: ' + e.message, 'error'); }
}

/* ════════════════════════════════════════════════════════════════════════════
   ENVELOPE DETAIL VIEW
   ════════════════════════════════════════════════════════════════════════════ */
function renderDetail(container, env) {
  const title   = document.getElementById('signing-page-title');
  const actions = document.getElementById('signing-topbar-actions');
  title.textContent = env.title;

  const baseUrl = window.location.origin;
  const statusText = { draft: 'Draft', out_for_signature: 'Out for Signature', completed: 'Completed', voided: 'Voided' };

  // Build action buttons based on status
  let actHtml = `<button class="btn btn-ghost btn-sm" onclick="window.SigningApp.navTo('envelopes')">← Back</button>`;
  if (env.status === 'draft') {
    actHtml += `
      <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.goToEditor('${env.id}')">Edit Fields</button>
      <button class="btn btn-primary btn-sm" onclick="window.SigningApp.sendEnvelope('${env.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        Send for Signing</button>`;
  }
  if (env.status === 'out_for_signature') {
    actHtml += `
      <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.remindSigners('${env.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0"/></svg>
        Send Reminder</button>
      <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.signInPerson('${env.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Sign in Person</button>`;
  }
  if (env.status === 'completed') {
    actHtml += `
      <a class="btn btn-primary btn-sm" href="/api/signing/envelopes/${env.id}/download"
        download="${esc(env.title)}-signed.pdf"
        onclick="window.SigningApp.trackDownload(event, '${env.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Signed PDF</a>
      <button class="btn btn-ghost btn-sm" onclick="window.SigningApp.importToLibrary('${env.id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        Add to Library</a>`;
  }
  if (['draft','out_for_signature'].includes(env.status)) {
    actHtml += `<button class="btn btn-danger btn-sm" onclick="window.SigningApp.voidEnvelope('${env.id}')">Void</button>`;
  }
  if (['draft','voided','completed'].includes(env.status)) {
    actHtml += `<button class="btn btn-danger btn-sm" onclick="window.SigningApp.deleteEnvelope('${env.id}')">Delete</button>`;
  }
  actions.innerHTML = actHtml;

  const signersHtml = (env.signers || []).map(s => {
    const signingUrl = `${baseUrl}/sign?token=${s.token}`;
    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:.5rem">
          <div style="width:9px;height:9px;border-radius:50%;background:${s.color};flex-shrink:0"></div>
          <strong>${esc(s.name)}</strong>
        </div>
      </td>
      <td>${esc(s.email)}</td>
      <td><span class="status-badge ${s.status}">${s.status}</span></td>
      <td>${s.signed_at ? new Date(s.signed_at).toLocaleString() : '—'}</td>
      <td>
        ${env.status !== 'draft' ? `
        <div class="signing-url-box">
          <code title="${signingUrl}">${signingUrl}</code>
          <button class="icon-btn" title="Copy link"
            onclick="navigator.clipboard.writeText('${signingUrl}').then(()=>window.SigningApp.toast('Link copied!','success'))">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <a class="icon-btn" href="${signingUrl}" target="_blank" title="Open signing link">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </div>` : '<span style="color:var(--text-3);font-size:.75rem">Send envelope to generate links</span>'}
      </td>
    </tr>`;
  }).join('');

  const eventsHtml = (env.events || []).reverse().map(ev => `
    <div class="audit-event">
      <div class="audit-dot"></div>
      <div style="flex:1">
        <div class="audit-action">${esc(ev.action)}</div>
        ${ev.signer_id ? `<div style="font-size:.74rem;color:var(--text-2)">${esc((env.signers || []).find(s => s.id === ev.signer_id)?.name || 'Signer')}</div>` : ''}
        ${ev.ip ? `<div class="audit-time">IP: ${esc(ev.ip)}</div>` : ''}
      </div>
      <div class="audit-time">${new Date(ev.created_at).toLocaleString()}</div>
    </div>`).join('');

  const fieldCount = (env.fields || []).length;

  container.innerHTML = `
  <div class="envelope-detail">
    <div class="detail-header">
      <span class="status-badge ${env.status}" style="font-size:.75rem">${statusText[env.status]||env.status}</span>
      <h2>${esc(env.title)}</h2>
    </div>

    ${env.message ? `<p style="color:var(--text-2);font-size:.85rem;margin-bottom:1.25rem;font-style:italic">"${esc(env.message)}"</p>` : ''}

    <div class="form-section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
        <h3 style="margin:0">Signers</h3>
        <div style="font-size:.75rem;color:var(--text-3)">${fieldCount} field${fieldCount !== 1 ? 's' : ''} placed</div>
      </div>
      <div style="overflow-x:auto">
        <table class="signers-table">
          <thead><tr>
            <th>Name</th><th>Email</th><th>Status</th><th>Signed At</th><th>Signing Link</th>
          </tr></thead>
          <tbody>${signersHtml}</tbody>
        </table>
      </div>
    </div>

    ${env.events?.length ? `
    <div class="form-section">
      <h3>Audit Trail</h3>
      <div>${eventsHtml}</div>
    </div>` : ''}
  </div>`;
}

async function goToEditor(id) {
  const detail = await api('GET', `/signing/envelopes/${id}`);
  navTo('editor', detail);
}

async function sendEnvelope(id) {
  const fieldCount = (await api('GET', `/signing/envelopes/${id}`).catch(() => ({ fields: [] }))).fields?.length;
  if (!fieldCount) { toast('Add at least one signing field before sending.', 'warn'); return; }

  if (!confirm('Send this envelope for signing? Signers will receive their unique signing links.')) return;
  try {
    const r = await api('POST', `/signing/envelopes/${id}/send`);
    toast('Envelope sent! ' + (r.signers?.length || 0) + ' signer(s) notified.', 'success');
    await loadEnvelopes();
    const detail = await api('GET', `/signing/envelopes/${id}`);
    navTo('detail', detail);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function remindSigners(id) {
  try {
    const r = await api('POST', `/signing/envelopes/${id}/remind`);
    const sent = r.results?.filter(x => x.sent).length || 0;
    const skip = r.results?.filter(x => x.skipped).length || 0;
    if (sent) toast(`Reminder sent to ${sent} signer(s).`, 'success');
    else if (skip) toast(`Reminders skipped (SMTP not configured). Copy links manually from the table.`, 'warn');
    else toast('No pending signers to remind.', 'info');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function voidEnvelope(id) {
  if (!confirm('Void this envelope? Signers will no longer be able to sign.')) return;
  try {
    await api('POST', `/signing/envelopes/${id}/void`);
    toast('Envelope voided.', 'success');
    await loadEnvelopes();
    const detail = await api('GET', `/signing/envelopes/${id}`);
    navTo('detail', detail);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function deleteEnvelope(id) {
  if (!confirm('Permanently delete this envelope?')) return;
  try {
    await api('DELETE', `/signing/envelopes/${id}`);
    toast('Envelope deleted.', 'success');
    await loadEnvelopes();
    navTo('envelopes');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function signInPerson(id) {
  try {
    const env = await api('GET', `/signing/envelopes/${id}`);
    const pending = (env.signers || []).filter(s => s.status !== 'signed');
    if (pending.length === 0) { toast('All signers have already signed.', 'info'); return; }
    if (pending.length === 1) {
      window.open(`/sign?token=${pending[0].token}`, '_blank');
      return;
    }
    // Multiple pending signers — show picker
    const items = pending.map(s =>
      `<button class="btn btn-ghost" style="width:100%;justify-content:flex-start;gap:.75rem;margin-bottom:.35rem"
        onclick="window.open('/sign?token=${esc(s.token)}','_blank');document.getElementById('sip-overlay').remove()">
        <div style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></div>
        <div style="text-align:left"><div style="font-weight:600">${esc(s.name)}</div><div style="font-size:.77rem;color:var(--text-3)">${esc(s.email)}</div></div>
      </button>`
    ).join('');
    const overlay = document.createElement('div');
    overlay.id = 'sip-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:var(--radius);padding:1.5rem;max-width:400px;width:90%;box-shadow:var(--shadow-lg)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
          <h3 style="margin:0">Select Signer</h3>
          <button class="icon-btn" onclick="document.getElementById('sip-overlay').remove()">&#10005;</button>
        </div>
        <p style="font-size:.82rem;color:var(--text-3);margin-bottom:1rem">Which person is signing in person right now?</p>
        ${items}
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function importToLibrary(id) {
  try {
    const r = await api('POST', `/signing/envelopes/${id}/import`);
    toast(`"${r.title}" added to your document library.`, 'success');
  } catch (e) { toast('Import failed: ' + e.message, 'error'); }
}

function trackDownload(e, id) {
  // Add auth token to download link since it's a direct <a> tag
  e.preventDefault();
  fetch(`/api/signing/envelopes/${id}/download`, { headers: { 'Authorization': `Bearer ${token()}` } })
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'signed.pdf';
      a.click(); URL.revokeObjectURL(url);
    });
}

/* ════════════════════════════════════════════════════════════════════════════
   SETTINGS (AI + MCP + Security + Email/SMTP)
   ════════════════════════════════════════════════════════════════════════════ */
function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  overlay.style.display = 'flex';
  document.getElementById('settings-close').onclick = () => overlay.style.display = 'none';
  overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };

  // Add SMTP tab if not present
  const tabList = document.getElementById('settings-tab-list');
  if (!tabList.querySelector('[data-stab="smtp"]')) {
    const btn = document.createElement('button');
    btn.className = 'stab'; btn.dataset.stab = 'smtp'; btn.textContent = 'Email / SMTP';
    tabList.appendChild(btn);
  }

  tabList.querySelectorAll('.stab').forEach(btn => {
    btn.onclick = () => switchSettingsTab(btn.dataset.stab);
  });

  switchSettingsTab('smtp');
}

async function switchSettingsTab(tab) {
  document.querySelectorAll('#settings-tab-list .stab').forEach(b => b.classList.toggle('active', b.dataset.stab === tab));
  const content = document.getElementById('settings-content');
  content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:13px">Loading…</div>';

  if (tab === 'smtp') {
    content.innerHTML = await renderSmtpTab();
  } else {
    content.innerHTML = `<div style="padding:1.5rem;text-align:center;color:var(--text-3);font-size:.85rem">
      <p style="margin-bottom:1rem">Other settings are available in the main app.</p>
      <a href="/" class="btn btn-ghost btn-sm">Go to DocumentNeo →</a>
    </div>`;
  }
}

async function renderSmtpTab() {
  let smtp = {};
  try { smtp = await api('GET', '/signing/smtp'); } catch (_) {}

  return `
  <div class="settings-panel">
    <h3>Email &amp; SMTP</h3>
    <p class="helper">Configure outgoing email to send signing invitations and reminders. The password is stored securely on the server and never returned to the client.</p>

    <div class="toggle-row" style="margin-bottom:1rem">
      <span>Enable email sending</span>
      <input type="checkbox" class="toggle" id="smtp-enabled" ${smtp.smtp_enabled === 'true' ? 'checked' : ''}>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:.75rem">
      <div class="form-group">
        <label>SMTP Host</label>
        <input type="text" id="smtp-host" value="${esc(smtp.smtp_host||'')}" placeholder="smtp.example.com">
      </div>
      <div class="form-group">
        <label>Port</label>
        <input type="number" id="smtp-port" value="${smtp.smtp_port||587}" placeholder="587" style="max-width:100px">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:.75rem">
      <div class="form-group">
        <label>Username / Email</label>
        <input type="text" id="smtp-user" value="${esc(smtp.smtp_user||'')}" placeholder="you@example.com">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="smtp-pass" placeholder="Leave blank to keep current">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:1rem">
      <div class="form-group">
        <label>From Address (optional)</label>
        <input type="text" id="smtp-from" value="${esc(smtp.smtp_from||'')}" placeholder="DocumentNeo Signing &lt;no-reply@…&gt;">
      </div>
      <div class="form-group">
        <label>Security</label>
        <select id="smtp-secure">
          <option value="tls"  ${smtp.smtp_secure==='tls'||!smtp.smtp_secure ?'selected':''}>STARTTLS (port 587)</option>
          <option value="ssl"  ${smtp.smtp_secure==='ssl' ?'selected':''}>SSL/TLS (port 465)</option>
          <option value="none" ${smtp.smtp_secure==='none'?'selected':''}>None (port 25)</option>
        </select>
      </div>
    </div>

    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" id="smtp-test-btn" onclick="window.SigningApp.testSmtp()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/></svg>
        Test Connection
      </button>
      <button class="btn btn-primary btn-sm" onclick="window.SigningApp.saveSmtp()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        Save Settings
      </button>
    </div>
    <div id="smtp-status" style="margin-top:.5rem;font-size:.78rem"></div>
  </div>`;
}

async function saveSmtp() {
  const payload = {
    smtp_enabled: document.getElementById('smtp-enabled')?.checked,
    smtp_host:    document.getElementById('smtp-host')?.value?.trim(),
    smtp_port:    parseInt(document.getElementById('smtp-port')?.value) || 587,
    smtp_user:    document.getElementById('smtp-user')?.value?.trim(),
    smtp_pass:    document.getElementById('smtp-pass')?.value || '',
    smtp_from:    document.getElementById('smtp-from')?.value?.trim(),
    smtp_secure:  document.getElementById('smtp-secure')?.value,
  };
  try {
    await api('PUT', '/signing/smtp', payload);
    toast('SMTP settings saved.', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function testSmtp() {
  const btn = document.getElementById('smtp-test-btn');
  const status = document.getElementById('smtp-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  try {
    await saveSmtp();
    await api('POST', '/signing/smtp/test');
    if (status) status.innerHTML = '<span style="color:var(--success)">✓ Connection successful!</span>';
    toast('SMTP connection successful!', 'success');
  } catch (e) {
    if (status) status.innerHTML = `<span style="color:var(--danger)">✗ ${esc(e.message)}</span>`;
    toast('SMTP test failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
  }
}

/* Export for inline onclick handlers */
window.SigningApp = {
  navTo, openDetail, addSignerRow, submitNewEnvelope, selectSigner,
  deleteField, saveAndContinue, goToEditor, sendEnvelope, remindSigners,
  voidEnvelope, deleteEnvelope, importToLibrary, signInPerson, autoDetectFields,
  trackDownload, openSettings, saveSmtp, testSmtp, toast,
  removeSigner,

  /* ── Doc picker helpers ── */
  _docPickerRender(items) {
    const dd = document.getElementById('doc-picker-dropdown');
    if (!dd) return;
    const noneItem = `<div data-id="" class="doc-picker-item"
      onmousedown="window.SigningApp._docPickerSelect('','')"
      style="padding:.5rem .85rem;cursor:pointer;font-size:.875rem;color:var(--text-3);font-style:italic">
      — No document attached —
    </div>`;
    if (!items.length) {
      dd.innerHTML = `<div style="padding:.5rem .85rem;color:var(--text-3);font-size:.875rem">No matching documents</div>`;
      return;
    }
    dd.innerHTML = noneItem + items.map(d => {
      const safeId    = esc(String(d.id));
      const safeTitle = esc(d.title || 'Untitled');
      const attrTitle = safeTitle.replace(/'/g, '&#39;');
      return `<div class="doc-picker-item" data-id="${safeId}"
        onmousedown="window.SigningApp._docPickerSelect('${safeId}','${attrTitle}')"
        style="padding:.5rem .85rem;cursor:pointer;font-size:.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        ${safeTitle}
      </div>`;
    }).join('');
  },

  _docPickerFilter(query) {
    const q = (query || '').toLowerCase();
    const items = q
      ? _docPickerItems.filter(d => (d.title || '').toLowerCase().includes(q))
      : _docPickerItems;
    this._docPickerRender(items);
    const dd = document.getElementById('doc-picker-dropdown');
    if (dd) dd.style.display = 'block';
    if (!query) {
      const h = document.getElementById('env-document');
      if (h) h.value = '';
    }
  },

  _docPickerOpen() {
    this._docPickerRender(_docPickerItems);
    const dd = document.getElementById('doc-picker-dropdown');
    if (dd) dd.style.display = 'block';
  },

  _docPickerClose() {
    const dd = document.getElementById('doc-picker-dropdown');
    if (dd) dd.style.display = 'none';
  },

  _docPickerKey(e) {
    const dd = document.getElementById('doc-picker-dropdown');
    if (!dd || dd.style.display === 'none') return;
    const items = Array.from(dd.querySelectorAll('.doc-picker-item'));
    const activeEl = dd.querySelector('.doc-picker-item.dp-active');
    const idx = items.indexOf(activeEl);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (activeEl) activeEl.classList.remove('dp-active');
      const next = items[Math.min(idx + 1, items.length - 1)];
      if (next) { next.classList.add('dp-active'); next.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeEl) activeEl.classList.remove('dp-active');
      const prev = items[Math.max(idx - 1, 0)];
      if (prev) { prev.classList.add('dp-active'); prev.scrollIntoView({ block: 'nearest' }); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeEl) activeEl.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      this._docPickerClose();
    }
  },

  _docPickerSelect(id, title) {
    const s = document.getElementById('doc-picker-search');
    const h = document.getElementById('env-document');
    if (s) s.value = id ? title : '';
    if (h) h.value = id || '';
    this._docPickerClose();
  },
};

// Make removeSigner accessible for inline onclick
window.removeSigner = removeSigner;

// Boot
init();
