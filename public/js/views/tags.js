'use strict';

import { api } from '../core/auth.js';
import { toast, openModal, closeModal } from '../core/ui.js';
import { esc, escAttr, colorSwatchPicker } from '../core/helpers.js';
import { State } from '../state.js';

export const TagsMixin = {

  async renderTags() {
    await this.refreshMeta();
    const content = document.getElementById('content');
    content.innerHTML = `
      <div style="max-width:640px;margin:0 auto">
        <div class="settings-card">
          <div class="section-header">
            <h3 style="flex:1">Tags <span style="color:var(--text-3);font-weight:400">(${State.tags.length})</span></h3>
            <button class="btn btn-primary btn-sm" onclick="App.showCreateTag()">+ New Tag</button>
          </div>
          <div id="tags-list">
            ${State.tags.length ? State.tags.map(t => this._tagRow(t)).join('') : '<p style="color:var(--text-3);font-size:.875rem">No tags yet.</p>'}
          </div>
        </div>
      </div>`;
  },

  _tagRow(t) {
    return `<div class="toggle-row" style="padding:.5rem 0;border-bottom:1px solid var(--border)" id="tag-row-${t.id}">
      <div style="display:flex;align-items:center;gap:.6rem">
        <div class="color-dot" style="background:${t.color}"></div>
        <span style="font-weight:500">${esc(t.name)}</span>
        <span style="font-size:.78rem;color:var(--text-3)">${t.document_count || 0} doc${(t.document_count || 0) !== 1 ? 's' : ''}</span>
      </div>
      <div style="display:flex;gap:.4rem">
        <button class="btn btn-ghost btn-sm" onclick="App.showEditTag('${t.id}','${escAttr(t.name)}','${t.color}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="App.deleteTag('${t.id}','${escAttr(t.name)}')">Delete</button>
      </div>
    </div>`;
  },

  showCreateTag() {
    openModal(`<div class="modal">
      <div class="modal-header"><h3>Create Tag</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Tag Name</label>
          <input type="text" id="tag-name-input" placeholder="e.g. invoice" maxlength="60">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker('#22c55e')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.createTag()">Create</button>
      </div>
    </div>`);
  },

  async createTag() {
    const name  = document.getElementById('tag-name-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Tag name is required.', 'warn'); return; }
    try {
      await api('POST', '/tags', { name, color });
      toast('Tag created.', 'success');
      closeModal();
      this.renderTags();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  showEditTag(id, name, color) {
    openModal(`<div class="modal">
      <div class="modal-header"><h3>Edit Tag</h3><button class="icon-btn" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:.8rem">
          <label>Tag Name</label>
          <input type="text" id="tag-name-input" value="${esc(name)}" maxlength="60">
        </div>
        <div class="form-group">
          <label>Color</label>
          ${colorSwatchPicker(color)}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.updateTag('${id}')">Save</button>
      </div>
    </div>`);
  },

  async updateTag(id) {
    const name  = document.getElementById('tag-name-input').value.trim();
    const color = document.getElementById('color-value').value;
    if (!name) { toast('Tag name required.', 'warn'); return; }
    try {
      await api('PATCH', `/tags/${id}`, { name, color });
      toast('Tag updated.', 'success');
      closeModal();
      this.renderTags();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },

  async deleteTag(id, name) {
    if (!confirm(`Delete tag "${name}"?`)) return;
    try {
      await api('DELETE', `/tags/${id}`);
      toast('Tag deleted.', 'success');
      this.renderTags();
      this.refreshMeta();
    } catch (e) { toast(e.message, 'error'); }
  },
};
