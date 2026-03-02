'use strict';

import { Auth, api } from '../core/auth.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { esc, escAttr, fmtDate, fmtSize, mimeIcon, docThumb, hexToRgba } from '../core/helpers.js';
import { State } from '../state.js';

export const DocumentsMixin = {

  async renderDocuments() {
    const content = document.getElementById('content');
    content.innerHTML = `<div style="display:flex;justify-content:center;padding:3rem"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div></div>`;

    const params = new URLSearchParams({
      page:  State.page,
      limit: State.limit,
      sort:  State.sortField,
      order: State.sortOrder,
    });
    if (State.searchQ)             params.set('q',             State.searchQ);
    if (State.filterTag)           params.set('tag',           State.filterTag);
    if (State.filterType)          params.set('type',          State.filterType);
    if (State.filterCorrespondent) params.set('correspondent', State.filterCorrespondent);

    try {
      const data = await api('GET', `/documents?${params}`);
      State.total = data.total || 0;
      document.getElementById('doc-count-badge').textContent = data.total;

      if (!data.documents.length) {
        content.innerHTML = `<div class="empty-state">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <h3>No documents found</h3>
          <p>${State.searchQ ? 'Try a different search term.' : 'Upload your first document to get started.'}</p>
          <button class="btn btn-primary" onclick="App.nav('upload')">Upload Document</button>
        </div>`;
        return;
      }

      // Mass-action toolbar (hidden when nothing selected)
      const toolbarHtml = `
        <div id="mass-toolbar" style="display:none;align-items:center;gap:.6rem;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:.55rem .9rem;margin-bottom:.75rem;flex-wrap:wrap">
          <input type="checkbox" id="select-all-cb" title="Select all" style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary)" onchange="App.toggleSelectAll(this.checked)">
          <span id="sel-count" style="font-size:.85rem;font-weight:600;color:var(--text-2)">0 selected</span>
          <span style="flex:1"></span>
          <button class="btn btn-ghost btn-sm" onclick="App.clearSelection()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Clear
          </button>
          <button class="btn btn-danger btn-sm" onclick="App.deleteSelected()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Delete
          </button>
        </div>`;

      const docsHtml = State.view === 'grid'
        ? this.buildDocGrid(data.documents)
        : this.buildDocList(data.documents);

      content.innerHTML = toolbarHtml + docsHtml;
      this.buildPagination(data.total);
      this._updateMassToolbar();
    } catch (e) {
      content.innerHTML = `<div class="empty-state"><h3>Failed to load documents</h3><p>${esc(e.message)}</p></div>`;
    }
  },

  buildDocGrid(docs) {
    return `<div class="doc-grid">
      ${docs.map(d => {
        const selected = State.selectedDocs.has(d.id);
        return `
        <div class="doc-card${selected ? ' doc-selected' : ''}" data-id="${d.id}" onclick="App._docCardClick(event,'${d.id}')">
          ${State.selectMode ? `<div class="doc-check-overlay" onclick="event.stopPropagation();App.toggleDoc('${d.id}')">
            <input type="checkbox" class="doc-cb" data-id="${d.id}" ${selected ? 'checked' : ''} onclick="event.stopPropagation()" onchange="App.toggleDoc('${d.id}')">
          </div>` : ''}
          <div class="doc-card-thumb">${docThumb(d, Auth.token())}</div>
          <div class="doc-card-body">
            <div class="doc-card-title">${esc(d.title)}</div>
            <div class="doc-card-meta">${fmtDate(d.created_at)} · ${fmtSize(d.file_size)}</div>
            <div style="margin-top:.25rem;display:flex;gap:.3rem;flex-wrap:wrap">
              ${d.type_name ? `<span class="badge" style="background:${hexToRgba(d.type_color || '#6366f1', .18)};color:${d.type_color || '#6366f1'}">${esc(d.type_name)}</span>` : ''}
              ${d.correspondent_name ? `<span class="badge" style="background:${hexToRgba(d.correspondent_color || '#f59e0b', .18)};color:${d.correspondent_color || '#f59e0b'}">👤 ${esc(d.correspondent_name)}</span>` : ''}
            </div>
            <div class="doc-card-tags">
              ${(d.tags || []).map(t => `<span class="tag-chip" style="background:${hexToRgba(t.color, .18)};color:${t.color};padding:.1rem .45rem;font-size:.7rem">${esc(t.name)}</span>`).join('')}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  },

  buildDocList(docs) {
    return `<div class="doc-table-wrap"><table class="doc-table">
      <thead><tr>
        ${State.selectMode ? `<th style="width:36px"><input type="checkbox" id="select-all-list-cb" style="accent-color:var(--primary)" onchange="App.toggleSelectAll(this.checked)"></th>` : `<th style="width:36px"></th>`}
        <th style="width:36px"></th>
        <th>Title</th>
        <th>Type</th>
        <th>From / To</th>
        <th>Tags</th>
        <th>Size</th>
        <th>Date</th>
      </tr></thead>
      <tbody>
        ${docs.map(d => {
          const selected = State.selectedDocs.has(d.id);
          return `
          <tr class="${selected ? 'doc-row-selected' : ''}" data-id="${d.id}" onclick="App._docRowClick(event,'${d.id}')">
            <td onclick="event.stopPropagation()">
              ${State.selectMode
                ? `<input type="checkbox" class="doc-cb" data-id="${d.id}" ${selected ? 'checked' : ''} onchange="App.toggleDoc('${d.id}')" style="accent-color:var(--primary)">`
                : ''}
            </td>
            <td class="doc-list-thumb">${docThumb(d, Auth.token())}</td>
            <td><span style="font-weight:500">${esc(d.title)}</span></td>
            <td>${d.type_name ? `<span class="badge" style="background:${hexToRgba(d.type_color || '#6366f1', .18)};color:${d.type_color || '#6366f1'}">${esc(d.type_name)}</span>` : '<span style="color:var(--text-3)">—</span>'}</td>
            <td>${d.correspondent_name ? `<span class="badge" style="background:${hexToRgba(d.correspondent_color || '#f59e0b', .18)};color:${d.correspondent_color || '#f59e0b'}">${esc(d.correspondent_name)}</span>` : '<span style="color:var(--text-3)">—</span>'}</td>
            <td>${(d.tags || []).map(t => `<span class="tag-chip" style="background:${hexToRgba(t.color, .18)};color:${t.color};padding:.1rem .4rem;font-size:.72rem;margin:.1rem;">${esc(t.name)}</span>`).join('') || '<span style="color:var(--text-3)">—</span>'}</td>
            <td style="white-space:nowrap;color:var(--text-3)">${fmtSize(d.file_size)}</td>
            <td style="white-space:nowrap;color:var(--text-3)">${fmtDate(d.created_at)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>`;
  },

  // ── Mass selection ─────────────────────────────────────────────────────

  toggleSelectMode() {
    State.selectMode = !State.selectMode;
    if (!State.selectMode) State.selectedDocs.clear();
    // Update topbar button label/state
    const btn = document.getElementById('topbar-select-btn');
    if (btn) {
      btn.classList.toggle('active', State.selectMode);
      btn.innerHTML = State.selectMode
        ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Done`
        : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="4" height="4" rx="1"/><line x1="10" y1="7" x2="21" y2="7"/><rect x="3" y="12" width="4" height="4" rx="1"/><line x1="10" y1="14" x2="21" y2="14"/><rect x="3" y="19" width="4" height="4" rx="1"/><line x1="10" y1="21" x2="21" y2="21"/></svg> Select`;
    }
    this.renderDocuments();
  },

  toggleDoc(id) {
    if (State.selectedDocs.has(id)) State.selectedDocs.delete(id);
    else State.selectedDocs.add(id);
    // Update checkbox UI without full re-render
    document.querySelectorAll(`.doc-cb[data-id="${id}"]`).forEach(cb => { cb.checked = State.selectedDocs.has(id); });
    const card = document.querySelector(`.doc-card[data-id="${id}"]`);
    if (card) card.classList.toggle('doc-selected', State.selectedDocs.has(id));
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('doc-row-selected', State.selectedDocs.has(id));
    this._updateMassToolbar();
  },

  toggleSelectAll(checked) {
    document.querySelectorAll('.doc-cb').forEach(cb => {
      const id = cb.dataset.id;
      if (checked) State.selectedDocs.add(id);
      else State.selectedDocs.delete(id);
      cb.checked = checked;
    });
    document.querySelectorAll('.doc-card[data-id]').forEach(el => el.classList.toggle('doc-selected', checked));
    document.querySelectorAll('tr[data-id]').forEach(el => el.classList.toggle('doc-row-selected', checked));
    // Sync the other select-all checkbox if in list view
    ['select-all-cb', 'select-all-list-cb'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = checked;
    });
    this._updateMassToolbar();
  },

  clearSelection() {
    State.selectedDocs.clear();
    document.querySelectorAll('.doc-cb').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('.doc-card.doc-selected').forEach(el => el.classList.remove('doc-selected'));
    document.querySelectorAll('tr.doc-row-selected').forEach(el => el.classList.remove('doc-row-selected'));
    this._updateMassToolbar();
  },

  _updateMassToolbar() {
    const toolbar = document.getElementById('mass-toolbar');
    if (!toolbar) return;
    const n = State.selectedDocs.size;
    toolbar.style.display = (State.selectMode && n > 0) ? 'flex' : 'none';
    const countEl = document.getElementById('sel-count');
    if (countEl) countEl.textContent = `${n} selected`;
    // Keep topbar button in sync
    const btn = document.getElementById('topbar-select-btn');
    if (btn) btn.classList.toggle('active', State.selectMode);
  },

  async deleteSelected() {
    const ids = [...State.selectedDocs];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} document${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    try {
      const res = await api('DELETE', '/documents', { ids });
      toast(res.message || `${ids.length} document(s) deleted.`, 'success');
      State.selectedDocs.clear();
      await this.renderDocuments();
      await this.refreshMeta();
    } catch (e) {
      toast('Bulk delete failed: ' + e.message, 'error');
    }
  },

  _docCardClick(event, id) {
    if (State.selectMode) { this.toggleDoc(id); return; }
    this.openDoc(id);
  },

  _docRowClick(event, id) {
    if (State.selectMode) { this.toggleDoc(id); return; }
    this.openDoc(id);
  },

  // ── Pagination ────────────────────────────────────────────────────────

  buildPagination(total) {
    const totalPages = Math.ceil(total / State.limit);
    if (totalPages <= 1) return;
    const content = document.getElementById('content');
    const pag = document.createElement('div');
    pag.className = 'pagination';

    if (State.page > 1) {
      const b = document.createElement('button');
      b.className = 'page-btn';
      b.innerHTML = '‹';
      b.onclick = () => { State.page--; this.renderDocuments(); };
      pag.appendChild(b);
    }

    const start = Math.max(1, State.page - 3);
    const end   = Math.min(totalPages, start + 6);
    for (let i = start; i <= end; i++) {
      const b = document.createElement('button');
      b.className = `page-btn${i === State.page ? ' active' : ''}`;
      b.textContent = i;
      const pg = i;
      b.onclick = () => { State.page = pg; this.renderDocuments(); };
      pag.appendChild(b);
    }

    if (State.page < totalPages) {
      const b = document.createElement('button');
      b.className = 'page-btn';
      b.innerHTML = '›';
      b.onclick = () => { State.page++; this.renderDocuments(); };
      pag.appendChild(b);
    }

    content.appendChild(pag);
  },

  async openDoc(id) {
    try {
      const doc = await api('GET', `/documents/${id}`);
      this._showDocModal(doc);
    } catch (e) {
      toast('Failed to load document: ' + e.message, 'error');
    }
  },

  _showDocModal(doc) {
    const tagOptions = State.tags.map(t =>
      `<div class="tag-chip${(doc.tags || []).some(dt => dt.id === t.id) ? ' active' : ''}"
            style="background:${hexToRgba(t.color, .18)};color:${t.color}"
            data-tag-id="${t.id}"
            onclick="this.classList.toggle('active')">${esc(t.name)}</div>`
    ).join('');

    const typeOptions = State.types.map(t =>
      `<option value="${t.id}"${doc.type_id === t.id ? ' selected' : ''}>${esc(t.name)}</option>`
    ).join('');

    const isViewable = doc.mime_type === 'application/pdf' || doc.mime_type.startsWith('image/');

    // Track blob URL so it can be revoked when the modal is closed or re-loaded
    this._viewerBlobUrl = null;

    openModal(`<div class="modal modal-xl">
      <div class="modal-header">
        <span style="display:inline-flex;align-items:center;width:24px;height:28px;flex-shrink:0">${docThumb(doc, Auth.token())}</span>
        <h3>${esc(doc.title)}</h3>
        <button class="btn btn-ghost btn-sm" data-filename="${escAttr(doc.filename)}" onclick="App.downloadDoc('${doc.id}', this.dataset.filename)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        ${isViewable ? `
        <button class="btn btn-ghost btn-sm" title="Rotate left 90°" onclick="App.rotateDoc('${doc.id}',-90)" style="padding:.35rem .4rem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6"/><path d="M2.66 15.57a10 10 0 1 0 .57-8.38"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm" title="Rotate 180°" onclick="App.rotateDoc('${doc.id}',180)" style="padding:.35rem .4rem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm" title="Rotate right 90°" onclick="App.rotateDoc('${doc.id}',90)" style="padding:.35rem .4rem">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38"/></svg>
        </button>` : ''}
        <button class="icon-btn" onclick="closeModal()" title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body" style="padding:0">
        <div class="viewer-layout">
          <div class="viewer-iframe-wrap">
            ${isViewable
              ? doc.mime_type.startsWith('image/')
                ? `<img class="viewer-img" id="doc-viewer-img" src="" alt="${esc(doc.title)}">`
                : `<div id="doc-pdf-container" class="pdf-viewer-container"><div class="pdf-loading-state"><div class="spinner" style="border-color:#888;border-top-color:#fff;margin:0 auto .5rem"></div>Loading PDF…</div></div>`
              : `<div style="height:100%;display:grid;place-items:center;flex-direction:column;gap:1rem;color:var(--text-3)">
                  <div style="width:80px;height:96px">${docThumb(doc, Auth.token())}</div>
                  <div style="text-align:center">
                    <p style="font-weight:600;color:var(--text)">${esc(doc.filename)}</p>
                    <p style="font-size:.85rem">${fmtSize(doc.file_size)}</p>
                    <button class="btn btn-primary" style="margin-top:1rem" data-filename="${escAttr(doc.filename)}" onclick="App.downloadDoc('${doc.id}', this.dataset.filename)">Download File</button>
                  </div>
                </div>`
            }
          </div>
          <div class="viewer-sidebar">
            <div>
              <label>File</label>
              <div style="font-size:.85rem;color:var(--text-2)">${esc(doc.filename)}<br><span style="color:var(--text-3)">${fmtSize(doc.file_size)} · ${doc.mime_type}</span></div>
            </div>
            <div>
              <label>Title</label>
              <input type="text" id="doc-edit-title" value="${esc(doc.title)}" style="font-size:.875rem">
            </div>
            <div>
              <label>Type</label>
              <select id="doc-edit-type" style="font-size:.875rem">
                <option value="">No type</option>
                ${typeOptions}
              </select>
            </div>
            <div>
              <label>Correspondent</label>
              <select id="doc-edit-correspondent" style="font-size:.875rem">
                <option value="">No correspondent</option>
                ${State.correspondents.map(c => `<option value="${c.id}"${doc.correspondent_id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Tags</label>
              <div class="tags-picker" id="doc-edit-tags">
                ${tagOptions || '<span style="font-size:.78rem;color:var(--text-3)">No tags available</span>'}
              </div>
            </div>
            <div>
              <label>Notes / Summary</label>
              <textarea id="doc-edit-notes" style="font-size:.82rem;min-height:80px">${esc(doc.notes || '')}</textarea>
            </div>
            <div>
              <label>Added</label>
              <div style="font-size:.82rem;color:var(--text-2)">${fmtDate(doc.created_at)}</div>
            </div>
            <div class="ai-chat" id="ai-section">
              <label>AI Assistant</label>
              <div class="ai-messages" id="ai-messages"></div>
              <div class="ai-input-row">
                <input type="text" id="ai-input" placeholder="Ask about this document…" onkeydown="if(event.key==='Enter')App.askAI('${doc.id}')">
                <button class="btn btn-primary btn-sm" onclick="App.askAI('${doc.id}')">Ask</button>
              </div>
              <div style="display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
                <button class="btn btn-ghost btn-sm" onclick="App.reSummarise('${doc.id}')">✨ Summarise</button>
                <button class="btn btn-ghost btn-sm" onclick="App.reTag('${doc.id}')">🏷 Re-tag</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger btn-sm" data-title="${escAttr(doc.title)}" onclick="App.deleteDoc('${doc.id}', this.dataset.title)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          Delete
        </button>
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="App.saveDoc('${doc.id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save
        </button>
      </div>
    </div>`, () => {
      // Revoke blob URL when modal closes to free memory
      if (this._viewerBlobUrl) { URL.revokeObjectURL(this._viewerBlobUrl); this._viewerBlobUrl = null; }
    });

    // Load viewable content via fetch (iframes can't send Authorization headers)
    if (isViewable) {
      if (doc.mime_type.startsWith('image/')) {
        fetch(`/api/documents/${doc.id}/view`, { headers: { Authorization: `Bearer ${Auth.token()}` } })
          .then(r => { if (!r.ok) throw new Error('Failed'); return r.blob(); })
          .then(blob => {
            const el = document.getElementById('doc-viewer-img');
            if (el) { this._viewerBlobUrl = URL.createObjectURL(blob); el.src = this._viewerBlobUrl; }
          })
          .catch(() => {
            const el = document.getElementById('doc-viewer-img');
            if (el) el.outerHTML = `<div style="height:100%;display:grid;place-items:center;color:var(--text-3)"><p>Preview unavailable</p></div>`;
          });
      } else {
        // PDF: use PDF.js for cross-platform rendering (blob-URL iframes fail on iOS/PWA)
        this._renderPdfCanvas(doc.id, document.getElementById('doc-pdf-container'))
          .catch(() => {
            const c = document.getElementById('doc-pdf-container');
            if (c) c.innerHTML = `<div style="height:100%;display:grid;place-items:center;color:#ccc"><p>Preview unavailable</p></div>`;
          });
      }
    }

    fetch('/api/settings/public', { headers: { Authorization: `Bearer ${Auth.token()}` } })
      .then(r => r.json())
      .then(s => {
        if (s.ai_enabled !== 'true') {
          document.getElementById('ai-section').style.opacity = '.45';
          document.getElementById('ai-section').title = 'AI is disabled. Enable it in Settings.';
          document.getElementById('ai-input').disabled = true;
        }
      }).catch(() => {});
  },

  // ── AI helpers ─────────────────────────────────────────────────────────

  async rotateDoc(id, angle) {
    // Disable all rotate buttons while the request is in flight
    const rotBtns = document.querySelectorAll('.modal-header .btn[title^="Rotate"]');
    rotBtns.forEach(b => { b.disabled = true; b.style.opacity = '.4'; });
    try {
      const res = await api('POST', `/documents/${id}/rotate`, { angle });
      // Reload viewer after rotation
      const pdfContainer = document.getElementById('doc-pdf-container');
      const imgEl = document.getElementById('doc-viewer-img');
      if (imgEl) {
        fetch(`/api/documents/${id}/view`, { headers: { Authorization: `Bearer ${Auth.token()}` } })
          .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
          .then(blob => {
            if (this._viewerBlobUrl) URL.revokeObjectURL(this._viewerBlobUrl);
            this._viewerBlobUrl = URL.createObjectURL(blob);
            imgEl.src = this._viewerBlobUrl;
          })
          .catch(() => {});
      } else if (pdfContainer) {
        this._renderPdfCanvas(id, pdfContainer).catch(() => {});
      }
      toast(res.reprocessed ? 'Rotated — re-scanning with AI…' : 'Document rotated.', 'success');
      this.renderDocuments().catch(() => {});
    } catch (e) {
      toast('Rotation failed: ' + e.message, 'error');
    } finally {
      rotBtns.forEach(b => { b.disabled = false; b.style.opacity = ''; });
    }
  },

  async saveDoc(id) {
    const title           = document.getElementById('doc-edit-title').value.trim();
    const notes           = document.getElementById('doc-edit-notes').value.trim();
    const typeId          = document.getElementById('doc-edit-type').value;
    const correspondentId = document.getElementById('doc-edit-correspondent').value;
    const tagEls          = document.querySelectorAll('#doc-edit-tags .tag-chip.active');
    const tags            = Array.from(tagEls).map(el => el.dataset.tagId).filter(Boolean);
    try {
      await api('PATCH', `/documents/${id}`, { title, notes, type_id: typeId || null, correspondent_id: correspondentId || null, tags });
      toast('Document saved successfully.', 'success');
      closeModal();
      this.renderDocuments();
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  },

  async deleteDoc(id, title) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/documents/${id}`);
      toast('Document deleted.', 'success');
      closeModal();
      this.renderDocuments();
    } catch (e) {
      toast('Delete failed: ' + e.message, 'error');
    }
  },

  downloadDoc(id, filename) {
    fetch(`/api/documents/${id}/file`, { headers: { Authorization: `Bearer ${Auth.token()}` } })
      .then(r => r.blob())
      .then(blob => {
        const url  = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href     = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      })
      .catch(() => toast('Download failed.', 'error'));
  },

  async _renderPdfCanvas(id, container) {
    if (!container) return;
    const buf = await fetch(`/api/documents/${id}/view`, { headers: { Authorization: `Bearer ${Auth.token()}` } })
      .then(r => { if (!r.ok) throw new Error('Failed'); return r.arrayBuffer(); });
    const pdfjsLib = await import('/js/pdfjs/pdf.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/pdfjs/pdf.worker.mjs';
    const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    container.innerHTML = '';
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page     = await pdfDoc.getPage(i);
      const availW   = container.clientWidth - 16;
      const base     = page.getViewport({ scale: 1 });
      const scale    = Math.max(0.5, availW / base.width); // 0.5 = minimum readable scale
      const viewport = page.getViewport({ scale });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      canvas.className = 'pdf-canvas-page';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      container.appendChild(canvas);
    }
  },
};
