'use strict';
/* ── DocumentNeo Signing — public signer experience ──────────────────────── */

const PDFJS_URL = '/js/pdfjs/pdf.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function getParam(name) { return new URLSearchParams(location.search).get(name); }

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ── Font definitions (module-level to avoid inline-onclick quoting issues) ──
const SIG_FONTS = [
  { label: 'Cursive', font: "'Brush Script MT', cursive" },
  { label: 'Script',  font: "'Dancing Script', cursive" },
  { label: 'Formal',  font: "'Times New Roman', serif" },
  { label: 'Sans',    font: 'system-ui, sans-serif' },
];

// ── State ─────────────────────────────────────────────────────────────────
const State = {
  token: getParam('token'),
  signerInfo: null,
  envelope: null,
  fields: [],              // my fields to fill
  values: {},              // { fieldId: value }
  pdfDoc: null,
  pageWraps: [],
  pdfjsLib: null,
  currentFieldId: null,
  sigMode: 'draw',         // 'draw' or 'type'
};

/* ════════════════════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════════════════════ */
async function init() {
  if (!State.token) {
    showError('Missing signing token. Please use the link from your invitation email.');
    return;
  }

  // Load PDF.js
  try {
    State.pdfjsLib = await import(PDFJS_URL);
    State.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/pdfjs/pdf.worker.mjs';
  } catch (e) {
    console.warn('PDF.js failed:', e.message);
  }

  // Fetch signer info
  let data;
  try {
    const r = await fetch(`/api/signing/public/${encodeURIComponent(State.token)}`);
    if (r.status === 404) { showError('This signing link is invalid or has expired.'); return; }
    if (r.status === 410) { showError('This signing request has been voided by the sender.'); return; }
    if (r.status === 403) { showError('This document is not yet ready for signing.'); return; }
    data = await r.json();
    if (!r.ok) { showError(data.error || 'Failed to load signing request.'); return; }
  } catch (e) {
    showError('Network error. Please check your connection and try again.');
    return;
  }

  State.signerInfo = data.signer;
  State.envelope   = data.envelope;
  State.fields     = data.fields || [];

  // Update header
  document.getElementById('sign-doc-title').textContent = data.envelope.title;

  if (data.alreadySigned) {
    showAlreadySigned();
    return;
  }

  if (data.envelope.status === 'completed') {
    showCompleted(false);
    return;
  }

  // Show steps
  document.getElementById('sign-steps').style.display = 'flex';
  setStep('review');

  // Populate panel
  document.getElementById('panel-signer-name').textContent  = data.signer.name;
  document.getElementById('panel-signer-email').textContent = data.signer.email;
  document.getElementById('sign-panel').style.display = 'flex';

  renderFieldPanel();


  // Load PDF
  await loadPdf();

  // Set to signing step immediately (no "Start Signing" gate needed)
  setStep('sign');

  // Submit handler
  document.getElementById('sign-submit-btn').onclick = submitSigning;
  const mobSubmitEl = document.getElementById('mob-submit-btn');
  if (mobSubmitEl) mobSubmitEl.onclick = submitSigning;
  checkProgress();
}

function showError(msg) {
  document.getElementById('sign-doc-title').textContent = 'Error';
  document.getElementById('sign-loading').innerHTML = `
    <div style="background:var(--danger-dim);border:1px solid var(--danger);border-radius:var(--radius);padding:1.5rem 2rem;max-width:500px;text-align:center">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-bottom:.75rem"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <p style="color:var(--text)">${esc(msg)}</p>
    </div>`;
}

function showAlreadySigned() {
  document.getElementById('sign-steps').style.display = 'none';
  document.getElementById('sign-panel').style.display = 'none';
  const body = document.getElementById('sign-body');
  body.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;padding:2rem;overflow:auto';
  body.innerHTML = `
    <div class="sign-complete-card">
      <div class="sign-complete-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h2>Already Signed</h2>
      <p>You have already completed signing this document. Thank you!</p>
    </div>`;
}

function showCompleted(triggered) {
  document.getElementById('sign-panel').style.display = 'none';
  const body = document.getElementById('sign-body');
  body.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;padding:2rem;overflow:auto';
  body.innerHTML = `
    <div class="sign-complete-card">
      <div class="sign-complete-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <h2>${triggered ? 'All Done! 🎉' : 'Signing Complete'}</h2>
      <p>
        ${triggered
          ? `Thank you for signing <strong>${esc(State.envelope?.title || 'this document')}</strong>. All parties have now signed and the document is complete.`
          : `This document has already been fully signed.`}
      </p>
      <p style="margin-top:.75rem;font-size:.78rem;color:var(--text-3)">You can close this window.</p>
    </div>`;
  if (triggered) {
    document.getElementById('sign-steps').style.display = 'flex';
    setStep('done');
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   PDF LOADING & RENDERING
   ════════════════════════════════════════════════════════════════════════════ */
async function loadPdf() {
  if (!State.pdfjsLib) {
    document.getElementById('sign-loading').innerHTML =
      `<p style="color:var(--warn)">PDF viewer unavailable. Your fields are listed in the panel on the right.</p>`;
    return;
  }

  try {
    const response = await fetch(`/api/signing/public/${encodeURIComponent(State.token)}/document`);
    if (!response.ok) throw new Error('Failed to fetch document');
    const buf = await response.arrayBuffer();
    State.pdfDoc = await State.pdfjsLib.getDocument({ data: buf }).promise;

    const area = document.getElementById('sign-pdf-area');
    area.innerHTML = '';
    State.pageWraps = [];

    // Compute a responsive scale so the PDF never overflows on mobile
    const pdfAreaEl = document.getElementById('sign-pdf-area');
    function getScale(nativeWidth) {
      const availW = pdfAreaEl.clientWidth - 24; // 12px padding each side
      const ideal  = Math.min(1.4, availW / nativeWidth);
      return Math.max(0.5, ideal);
    }
    // Re-render on resize (only on first call to avoid duplicating observers)
    if (!State._resizeObserver) {
      State._resizeObserver = new ResizeObserver(() => { if (State.pdfDoc) rerenderPdf(); });
      State._resizeObserver.observe(pdfAreaEl);
    }

    for (let i = 1; i <= State.pdfDoc.numPages; i++) {
      const page         = await State.pdfDoc.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale        = getScale(baseViewport.width);
      const viewport     = page.getViewport({ scale });

      const wrap   = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.style.width  = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      const overlay = document.createElement('div');
      overlay.className = 'field-overlay-layer';
      overlay.style.pointerEvents = 'all';

      wrap.appendChild(canvas);
      wrap.appendChild(overlay);
      area.appendChild(wrap);
      State.pageWraps.push(wrap);
    }

    renderFieldOverlays();

  } catch (e) {
    document.getElementById('sign-loading').innerHTML =
      `<p style="color:var(--danger)">Error loading PDF: ${esc(e.message)}</p>`;
  }
}

/* Re-render PDF after viewport resize (keeps field overlays aligned) */
async function rerenderPdf() {
  const area = document.getElementById('sign-pdf-area');
  const availW = area.clientWidth - 24;
  State.pageWraps = [];
  area.innerHTML = '';
  for (let i = 1; i <= State.pdfDoc.numPages; i++) {
    const page         = await State.pdfDoc.getPage(i);
    const base         = page.getViewport({ scale: 1 });
    const scale        = Math.max(0.5, Math.min(1.4, availW / base.width));
    const viewport     = page.getViewport({ scale });
    const wrap         = document.createElement('div');
    wrap.className     = 'pdf-page-wrap';
    wrap.style.width   = viewport.width  + 'px';
    wrap.style.height  = viewport.height + 'px';
    const canvas       = document.createElement('canvas');
    canvas.width       = viewport.width;
    canvas.height      = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const overlay       = document.createElement('div');
    overlay.className   = 'field-overlay-layer';
    overlay.style.pointerEvents = 'all';
    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    area.appendChild(wrap);
    State.pageWraps.push(wrap);
  }
  renderFieldOverlays();
}

function renderFieldOverlays() {
  State.pageWraps.forEach((wrap, i) => {
    const overlay = wrap.querySelector('.field-overlay-layer');
    if (!overlay) return;
    overlay.innerHTML = '';
    const pageNum    = i + 1;
    const pageFields = State.fields.filter(f => f.page === pageNum);

    pageFields.forEach(field => {
      const color  = State.signerInfo?.color || '#6366f1';
      const isDone = !!State.values[field.id];
      const isCurrent = State.currentFieldId === field.id;

      const el = document.createElement('div');
      el.className  = `sign-field-overlay${isDone ? ' done' : ''}${isCurrent ? ' current' : ''}`;
      el.dataset.fid = field.id;
      el.style.cssText = `
        left:${field.x}%; top:${field.y}%; width:${field.w}%; height:${field.h}%;
        border-color:${color}; color:${color};
        background:${isDone ? color+'14' : color+'08'};`;

      if (field.type === 'signature' || field.type === 'initials') {
        const val = State.values[field.id];
        if (val) {
          const img = document.createElement('img');
          img.className = 'sign-field-img';
          img.src = typeof val === 'string' && val.startsWith('data:') ? val :
            (typeof val === 'object' ? val.dataUrl : val);
          img.style.objectFit = 'contain';
          el.appendChild(img);
        } else {
          el.innerHTML = `<div class="sign-field-placeholder">${field.type === 'initials' ? 'Initials' : 'Click to Sign'}</div>`;
        }
      } else if (field.type === 'checkbox') {
        const checked = State.values[field.id] === 'true';
        el.innerHTML = checked
          ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="9 12 11 14 15 10"/></svg>`
          : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.45"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>`;
      } else if (field.type === 'date' || field.type === 'text') {
        const val = State.values[field.id];
        if (val) {
          el.innerHTML = `<div class="sign-field-text-val">${esc(val)}</div>`;
        } else {
          const typeLabel = field.type === 'date' ? '📅 Date' : 'T Text';
          el.innerHTML = `<div class="sign-field-placeholder">${typeLabel}</div>`;
        }
      }

      el.addEventListener('click', () => activateField(field));
      overlay.appendChild(el);
    });
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   FIELD INTERACTION
   ════════════════════════════════════════════════════════════════════════════ */
function activateField(field) {
  State.currentFieldId = field.id;
  // Highlight panel item
  document.querySelectorAll('.sign-field-item').forEach(el => {
    el.classList.toggle('current', el.dataset.fid === field.id);
  });
  renderFieldOverlays();

  switch (field.type) {
    case 'signature':
    case 'initials':
      openSigModal(field);
      break;
    case 'text':
      openTextModal(field);
      break;
    case 'date':
      openTextModal(field);
      break;
    case 'checkbox':
      State.values[field.id] = State.values[field.id] === 'true' ? 'false' : 'true';
      markFieldDone(field.id);
      break;
  }
}

function markFieldDone(fieldId) {
  renderFieldOverlays();
  renderFieldPanel();
  checkProgress();
  scrollToNextField();
}

function scrollToNextField() {
  const next = State.fields.find(f => f.required && !State.values[f.id]);
  if (next) {
    // Scroll the matching overlay into view
    const el = document.querySelector(`[data-fid="${next.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderFieldPanel() {
  const list = document.getElementById('sign-fields-list');
  if (!list) return;
  list.innerHTML = State.fields.map(f => {
    const done    = !!State.values[f.id];
    const current = f.id === State.currentFieldId;
    const typeInfo = { signature: '✍️ Signature', initials: 'I Initials', text: 'T Text', date: '📅 Date', checkbox: '☑ Checkbox' };
    return `
    <div class="sign-field-item${done ? ' completed' : ''}${current ? ' current' : ''}"
      data-fid="${f.id}" onclick="window._signApp.activateField_byId('${f.id}')">
      <span style="font-size:1rem">${typeInfo[f.type]?.split(' ')[0] || '?'}</span>
      <div style="flex:1">
        <div class="sign-field-type">${typeInfo[f.type]?.split(' ').slice(1).join(' ') || f.type}</div>
        <div class="sign-field-page">Page ${f.page}${f.required ? ' · Required' : ''}</div>
      </div>
      ${done ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
    </div>`;
  }).join('');
}

function checkProgress() {
  const required = State.fields.filter(f => f.required);
  const done     = required.filter(f => State.values[f.id]);
  const all      = required.length;
  const submitBtn = document.getElementById('sign-submit-btn');
  const mobSubmit = document.getElementById('mob-submit-btn');
  const progress  = document.getElementById('panel-progress-text');
  const mobProg   = document.getElementById('mob-progress-text');

  const allDone = done.length >= all;
  if (submitBtn) submitBtn.disabled = !allDone;
  if (mobSubmit) mobSubmit.disabled = !allDone;

  let progressText, progressColor;
  if (all === 0) {
    progressText = 'No required fields.'; progressColor = '';
  } else if (!allDone) {
    progressText = `${done.length} / ${all} fields done`; progressColor = '';
  } else {
    progressText = 'All done ✓'; progressColor = 'var(--success)';
  }
  if (progress) { progress.textContent = progressText; if (progressColor) progress.style.color = progressColor; }
  if (mobProg)  { mobProg.textContent = progressText;  if (progressColor) mobProg.style.color = progressColor; }
}

function startSigning() {
  setStep('sign');
  document.getElementById('sign-header-actions').innerHTML = '';
  // Jump to first unfilled field
  const first = State.fields.find(f => !State.values[f.id] && f.required) || State.fields[0];
  if (first) {
    activateField(first);
    setTimeout(scrollToNextField, 100);
  }
}

function setStep(step) {
  const map = { review: 'step-review', sign: 'step-sign', done: 'step-done' };
  const order = ['review', 'sign', 'done'];
  const idx = order.indexOf(step);
  order.forEach((s, i) => {
    const el = document.getElementById(map[s]);
    if (!el) return;
    el.classList.remove('active', 'done');
    if (i < idx)  el.classList.add('done');
    if (i === idx) el.classList.add('active');
  });
  const numEl = document.getElementById(map[step])?.querySelector('.sign-step-num');
  if (numEl && step === 'done') numEl.textContent = '✓';
}

/* ════════════════════════════════════════════════════════════════════════════
   SIGNATURE MODAL
   ════════════════════════════════════════════════════════════════════════════ */
let _sigCanvas, _sigCtx, _sigDrawing = false, _sigHasContent = false;
let _currentSigField = null;

function openSigModal(field) {
  _currentSigField = field;
  const overlay   = document.getElementById('sig-modal-overlay');
  const titleEl   = document.getElementById('sig-modal-title');
  titleEl.textContent = field.type === 'initials' ? 'Your Initials' : 'Your Signature';
  overlay.style.display = 'flex';

  // Init canvas
  _sigCanvas  = document.getElementById('sig-canvas');
  _sigCtx     = _sigCanvas.getContext('2d');
  _sigHasContent = false;
  _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
  document.getElementById('sig-canvas-placeholder').style.opacity = '1';

  // Style
  _sigCtx.strokeStyle = '#1a1a2e';
  _sigCtx.lineWidth   = 2.5;
  _sigCtx.lineCap     = 'round';
  _sigCtx.lineJoin    = 'round';

  bindCanvasEvents();

  // Font picker for type tab (use data-idx + listener to avoid single-quote issues in onclick)
  document.getElementById('sig-font-picker').innerHTML = SIG_FONTS.map((f, i) =>
    `<button class="btn btn-ghost btn-sm font-choice${i===0?' active':''}" data-font-idx="${i}"
      style="font-family:${f.font};font-size:.9rem">${esc(State.signerInfo?.name||'John Doe')}</button>`
  ).join('');
  document.querySelectorAll('.font-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = SIG_FONTS[parseInt(btn.dataset.fontIdx)];
      if (f) setFont(f.font, btn);
    });
  });

  // Tab switching
  document.querySelectorAll('.sig-modal-tab').forEach(t => {
    t.onclick = () => {
      State.sigMode = t.dataset.tab;
      document.querySelectorAll('.sig-modal-tab').forEach(x => x.classList.toggle('active', x===t));
      document.getElementById('sig-tab-draw').style.display = t.dataset.tab === 'draw' ? 'block' : 'none';
      document.getElementById('sig-tab-type').style.display = t.dataset.tab === 'type' ? 'block' : 'none';
    };
  });

  document.getElementById('sig-tab-draw').style.display = 'block';
  document.getElementById('sig-tab-type').style.display = 'none';

  document.getElementById('sig-clear-btn').onclick = () => {
    _sigCtx.clearRect(0, 0, _sigCanvas.width, _sigCanvas.height);
    _sigHasContent = false;
    document.getElementById('sig-canvas-placeholder').style.opacity = '1';
  };
  document.getElementById('sig-apply-btn').onclick = applySig;
  document.getElementById('sig-cancel-btn').onclick = closeSigModal;
  document.getElementById('sig-modal-close').onclick = closeSigModal;
}

let _selectedFont = "'Brush Script MT', cursive";
function setFont(font, btn) {
  _selectedFont = font;
  document.querySelectorAll('#sig-font-picker button').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
}

function bindCanvasEvents() {
  const getPos = (e) => {
    const rect = _sigCanvas.getBoundingClientRect();
    const scaleX = _sigCanvas.width  / rect.width;
    const scaleY = _sigCanvas.height / rect.height;
    if (e.touches) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top)  * scaleY,
      };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const start = e => {
    e.preventDefault();
    _sigDrawing = true;
    _sigHasContent = true;
    document.getElementById('sig-canvas-placeholder').style.opacity = '0';
    const p = getPos(e);
    _sigCtx.beginPath();
    _sigCtx.moveTo(p.x, p.y);
  };
  const move = e => {
    if (!_sigDrawing) return;
    e.preventDefault();
    const p = getPos(e);
    _sigCtx.lineTo(p.x, p.y);
    _sigCtx.stroke();
  };
  const end = () => { _sigDrawing = false; };

  _sigCanvas.removeEventListener('mousedown', _sigCanvas._start);
  _sigCanvas.removeEventListener('mousemove', _sigCanvas._move);
  _sigCanvas.removeEventListener('mouseup',   _sigCanvas._end);
  _sigCanvas.removeEventListener('touchstart', _sigCanvas._start);
  _sigCanvas.removeEventListener('touchmove',  _sigCanvas._move);
  _sigCanvas.removeEventListener('touchend',   _sigCanvas._end);

  _sigCanvas._start = start; _sigCanvas._move = move; _sigCanvas._end = end;
  _sigCanvas.addEventListener('mousedown',  start);
  _sigCanvas.addEventListener('mousemove',  move);
  _sigCanvas.addEventListener('mouseup',    end);
  _sigCanvas.addEventListener('touchstart', start, { passive: false });
  _sigCanvas.addEventListener('touchmove',  move,  { passive: false });
  _sigCanvas.addEventListener('touchend',   end);
}

function applySig() {
  if (!_currentSigField) return;

  let dataUrl;
  if (State.sigMode === 'draw') {
    if (!_sigHasContent) { toast('Please draw your signature.', 'warn'); return; }
    dataUrl = _sigCanvas.toDataURL('image/png');
  } else {
    // Type mode — render to canvas
    const text = document.getElementById('sig-type-input')?.value?.trim();
    if (!text) { toast('Please type your name.', 'warn'); return; }
    const tmp = document.createElement('canvas');
    tmp.width = 400; tmp.height = 120;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 120);
    ctx.font       = `64px ${_selectedFont}`;
    ctx.fillStyle  = '#1a1a2e';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 20, 60, 360);
    dataUrl = tmp.toDataURL('image/png');
  }

  State.values[_currentSigField.id] = dataUrl;
  closeSigModal();
  markFieldDone(_currentSigField.id);
}

function closeSigModal() {
  document.getElementById('sig-modal-overlay').style.display = 'none';
}

/* ════════════════════════════════════════════════════════════════════════════
   TEXT/DATE MODAL
   ════════════════════════════════════════════════════════════════════════════ */
let _currentTextField = null;

function openTextModal(field) {
  _currentTextField = field;
  const overlay = document.getElementById('text-modal-overlay');
  document.getElementById('text-modal-title').textContent =
    field.type === 'date' ? 'Enter Date' : (field.label || 'Enter Text');
  const input = document.getElementById('text-modal-input');
  input.type  = field.type === 'date' ? 'date' : 'text';
  input.value = State.values[field.id] || (field.type === 'date' ? new Date().toISOString().slice(0,10) : '');
  input.placeholder = field.type === 'date' ? 'YYYY-MM-DD' : (field.label || 'Enter text…');
  overlay.style.display = 'flex';
  setTimeout(() => input.focus(), 50);

  document.getElementById('text-modal-apply').onclick = applyText;
  document.getElementById('text-modal-cancel').onclick = closeTextModal;
  document.getElementById('text-modal-close').onclick  = closeTextModal;
  input.onkeydown = e => { if (e.key === 'Enter') applyText(); };
}

function applyText() {
  if (!_currentTextField) return;
  let val = document.getElementById('text-modal-input')?.value?.trim();
  if (!val && _currentTextField.required) { toast('This field is required.', 'warn'); return; }
  // Format date values to a readable string
  if (_currentTextField.type === 'date' && val) {
    const d = new Date(val + 'T00:00:00');
    val = d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  State.values[_currentTextField.id] = val;
  closeTextModal();
  markFieldDone(_currentTextField.id);
}

function closeTextModal() {
  document.getElementById('text-modal-overlay').style.display = 'none';
}

/* ════════════════════════════════════════════════════════════════════════════
   SUBMIT
   ════════════════════════════════════════════════════════════════════════════ */
async function submitSigning() {
  // Validate all required fields
  for (const f of State.fields) {
    if (f.required && !State.values[f.id]) {
      toast(`Field "${f.type}" on page ${f.page} is required.`, 'warn');
      activateField(f);
      scrollToField(f);
      return;
    }
  }

  const btn = document.getElementById('sign-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="border-width:1.5px"></div> Submitting…';

  const fieldValues = {};
  for (const [k, v] of Object.entries(State.values)) {
    fieldValues[k] = v;
  }

  try {
    const r = await fetch(`/api/signing/public/${encodeURIComponent(State.token)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldValues }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);

    // Success!
    showCompleted(true);
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '✍️ Complete Signing';
    toast('Submission failed: ' + e.message, 'error');
  }
}

function scrollToField(field) {
  const el = document.querySelector(`[data-fid="${field.id}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function activateFieldById(id) {
  const field = State.fields.find(f => f.id === id);
  if (field) activateField(field);
}

/* ── Mobile panel toggle ─────────────────────────────────────────────────── */
function toggleMobilePanel() {
  const panel   = document.getElementById('sign-panel');
  const chevron = document.getElementById('mob-chevron');
  if (!panel) return;
  const expanded = panel.classList.toggle('mob-expanded');
  if (chevron) chevron.style.transform = expanded ? 'rotate(180deg)' : '';
}

/* ════════════════════════════════════════════════════════════════════════════
   EXPOSE for inline onclicks
   ════════════════════════════════════════════════════════════════════════════ */
window._signApp = {
  startSigning,
  activateField_byId: activateFieldById,
  setFont,
  toggleMobilePanel,
};

init();
