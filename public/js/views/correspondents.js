'use strict';

import { api } from '../core/auth.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { esc, escAttr, colorSwatchPicker } from '../core/helpers.js';
import { State } from '../state.js';

export const CorrespondentsMixin = {

  async renderCorrespondents() {
    await this.refreshMeta();
    const content = document.getElementById('content');
    content.innerHTML = `
      <div style="max-width:640px;margin:0 auto">
        <div class="settings-card">
          <div class="section-header">
            <h3 style="flex:1">Correspondents <span style="color:var(--text-3);font-weight:400">(${State.correspondents.length})</span></h3>
            <button class="btn btn-primary btn-sm" onclick="App.showCreateCorrespondent()">+ New Correspondent</button>
          </div>
          <div id="correspondents-list">
            ${State.correspondents.length ? State.correspondents.map(c => this._corrRow(c)).join('') : '<p style="color:var(--text-3);font-size:.875rem">No correspondents yet.</p>'}
          </div>
        </div>
      </div>`;
  },

  _corrRow(c) {
    return `<div class="toggle-row" style="padding:.5rem 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:.6rem;min-width:0">
        <div class="color-dot" style="background:${c.color}"></div>
        <span style="font-weight:500">${esc(c.name)}</span>
        ${c.email ? `<span style="font-size:.78rem;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.email)}</span>` : ''}
        <span style="font-size:.78rem;color:var(--text-3);flex-shrink:0">${c.doc_count || 0} doc${(c.doc_count || 0) !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:flex;gap:.4rem;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" onclick="App.showEditCorrespondent('${c.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="App.deleteCorrespondent('${c.id}')">Delete</button>
      </div>
    </div>`;
  },

  showCreateCorrespondent() {
    openModal(`<div class="modal">
      <div class="modal-header"><h3>New Correspondent</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Name <span style="color:var(--danger)">*</span></label>
          <input type="text" id="corr-name-input" placeholder="e.g. Acme Corp, John Smith" maxlength="100" autofocus>
        </div>
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Email</label>
          <input type="email" id="corr-email-input" placeholder="contact@example.com">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker('#f59e0b')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.createCorrespondent()">Create</button>
      </div>
    </div>`);
  },

  async createCorrespondent() {
    const name  = document.getElementById('corr-name-input').value.trim();
    const email = document.getElementById('corr-email-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Name is required.', 'warn'); return; }
    try {
      await api('POST', '/correspondents', { name, email, color });
      toast('Correspondent created.', 'success');
      closeModal();
      this.renderCorrespondents();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  showEditCorrespondent(id) {
    const c = State.correspondents.find(x => String(x.id) === String(id));
    if (!c) return;
    const { name, email = '', color } = c;
    openModal(`<div class="modal">
      <div class="modal-header"><h3>Edit Correspondent</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Name</label>
          <input type="text" id="corr-name-input" value="${esc(name)}" maxlength="100">
        </div>
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Email</label>
          <input type="email" id="corr-email-input" value="${esc(email)}">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker(color)}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.updateCorrespondent('${id}')">Save</button>
      </div>
    </div>`);
  },

  async updateCorrespondent(id) {
    const name  = document.getElementById('corr-name-input').value.trim();
    const email = document.getElementById('corr-email-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Name is required.', 'warn'); return; }
    try {
      await api('PATCH', `/correspondents/${id}`, { name, email, color });
      toast('Correspondent updated.', 'success');
      closeModal();
      this.renderCorrespondents();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteCorrespondent(id) {
    const c = State.correspondents.find(x => String(x.id) === String(id));
    const name = c ? c.name : 'this correspondent';
    if (!confirm(`Delete correspondent "${name}"? Documents assigned to them will be unlinked.`)) return;
    try {
      await api('DELETE', `/correspondents/${id}`);
      toast('Correspondent deleted.', 'success');
      this.renderCorrespondents();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },
};
