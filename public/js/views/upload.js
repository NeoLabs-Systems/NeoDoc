'use strict';

import { api } from '../core/auth.js';
import { toast } from '../core/ui.js';
import { esc, mimeIcon, fmtSize } from '../core/helpers.js';

export const UploadMixin = {

  renderUpload() {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div style="max-width:560px;margin:0 auto">
        <div class="settings-card">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
            Upload
          </h3>
          <div id="upload-zone" onclick="document.getElementById('file-input').click()"
               ondragover="event.preventDefault();this.classList.add('drag-over')"
               ondragleave="this.classList.remove('drag-over')"
               ondrop="event.preventDefault();this.classList.remove('drag-over');App.handleDrop(event.dataTransfer.files)">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
            <p style="font-size:1rem;font-weight:600;margin-top:.4rem">Drop files here or click to browse</p>
            <p style="font-size:.82rem;margin-top:.25rem">PDF, images, text files &bull; Max 50 MB &bull; Multiple files OK</p>
          </div>
          <input type="file" id="file-input" style="display:none" multiple accept="application/pdf,image/*,text/plain" onchange="App.handleFiles(this.files)">
          <div id="upload-queue" style="margin-top:.7rem"></div>
        </div>
      </div>`;
  },

  handleDrop(files) { this.handleFiles(files); },

  handleFiles(files) {
    const arr = Array.from(files);
    if (!arr.length) return;
    const queue = document.getElementById('upload-queue');
    if (!queue) return;
    this._doUploads(arr, queue);
  },

  async _doUploads(files, queue) {
    const zone = document.getElementById('upload-zone');
    if (zone) { zone.style.pointerEvents = 'none'; zone.style.opacity = '.5'; }

    const items = files.map((f, idx) => {
      const id  = 'uq' + idx + '_' + Date.now();
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;background:var(--surface2);border-radius:var(--radius);margin-bottom:.35rem';
      row.innerHTML =
        `<span style="font-size:1.1rem">${mimeIcon(f.type)}</span>` +
        `<span style="flex:1;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span>` +
        `<span style="font-size:.78rem;color:var(--text-3)">${fmtSize(f.size)}</span>` +
        `<span id="${id}" style="font-size:.78rem;min-width:72px;text-align:right;color:var(--text-3)">Queued</span>`;
      queue.appendChild(row);
      return { f, id };
    });

    let ok = 0, fail = 0;
    for (const { f, id } of items) {
      const st = document.getElementById(id);
      if (st) { st.textContent = 'Uploading…'; st.style.color = 'var(--primary)'; }
      const fd = new FormData();
      fd.append('file', f);
      fd.append('title', f.name.replace(/\.[^.]+$/, ''));
      try {
        await api('POST', '/documents', fd, true);
        ok++;
        if (st) { st.textContent = '✓ Done'; st.style.color = 'var(--success)'; }
      } catch (e) {
        fail++;
        if (st) { st.textContent = '✗ Failed'; st.style.color = 'var(--danger)'; }
        console.error('Upload error:', e);
      }
    }

    if (ok)   toast(`${ok} file${ok > 1 ? 's' : ''} uploaded.`, 'success');
    if (fail) toast(`${fail} upload${fail > 1 ? 's' : ''} failed.`, 'error');
    await this.refreshMeta();
    setTimeout(() => this.nav('documents'), ok ? 1200 : 0);
  },
};
