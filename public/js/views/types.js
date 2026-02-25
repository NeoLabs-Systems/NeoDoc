'use strict';

import { api } from '../core/auth.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { esc, escAttr, colorSwatchPicker } from '../core/helpers.js';
import { State } from '../state.js';

export const TypesMixin = {

  async renderTypes() {
    await this.refreshMeta();
    const content = document.getElementById('content');
    content.innerHTML = `
      <div style="max-width:640px;margin:0 auto">
        <div class="settings-card">
          <div class="section-header">
            <h3 style="flex:1">Document Types <span style="color:var(--text-3);font-weight:400">(${State.types.length})</span></h3>
            <button class="btn btn-primary btn-sm" onclick="App.showCreateType()">+ New Type</button>
          </div>
          <div id="types-list">
            ${State.types.length ? State.types.map(t => this._typeRow(t)).join('') : '<p style="color:var(--text-3);font-size:.875rem">No types yet.</p>'}
          </div>
        </div>
      </div>`;
  },

  _typeRow(t) {
    return `<div class="toggle-row" style="padding:.5rem 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:.6rem">
        <div class="color-dot" style="background:${t.color}"></div>
        <span style="font-weight:500">${esc(t.name)}</span>
        <span style="font-size:.78rem;color:var(--text-3)">${t.document_count || 0} doc${(t.document_count || 0) !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:flex;gap:.4rem">
        <button class="btn btn-ghost btn-sm" onclick="App.showEditType('${t.id}','${escAttr(t.name)}','${t.color}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="App.deleteType('${t.id}','${escAttr(t.name)}')">Delete</button>
      </div>
    </div>`;
  },

  showCreateType() {
    openModal(`<div class="modal">
      <div class="modal-header"><h3>Create Document Type</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Type Name</label>
          <input type="text" id="type-name-input" placeholder="e.g. Contract" maxlength="60">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker('#6366f1')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.createType()">Create</button>
      </div>
    </div>`);
  },

  async createType() {
    const name  = document.getElementById('type-name-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Type name required.', 'warn'); return; }
    try {
      await api('POST', '/types', { name, color });
      toast('Type created.', 'success');
      closeModal();
      this.renderTypes();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  showEditType(id, name, color) {
    openModal(`<div class="modal">
      <div class="modal-header"><h3>Edit Type</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Type Name</label>
          <input type="text" id="type-name-input" value="${esc(name)}" maxlength="60">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker(color)}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.updateType('${id}')">Save</button>
      </div>
    </div>`);
  },

  async updateType(id) {
    const name  = document.getElementById('type-name-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Type name required.', 'warn'); return; }
    try {
      await api('PATCH', `/types/${id}`, { name, color });
      toast('Type updated.', 'success');
      closeModal();
      this.renderTypes();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteType(id, name) {
    if (!confirm(`Delete type "${name}"?`)) return;
    try {
      await api('DELETE', `/types/${id}`);
      toast('Type deleted.', 'success');
      this.renderTypes();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },
};
