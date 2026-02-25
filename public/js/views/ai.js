'use strict';

import { api } from '../core/auth.js';
import { toast, closeModal } from '../core/ui.js';
import { esc } from '../core/helpers.js';

export const AIMixin = {

  async askAI(docId) {
    const input = document.getElementById('ai-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    const msgs = document.getElementById('ai-messages');
    msgs.innerHTML += `<div class="ai-bubble user">${esc(q)}</div>`;
    msgs.innerHTML += `<div class="ai-bubble bot" id="ai-typing"><div class="spinner" style="width:14px;height:14px;border-width:2px"></div></div>`;
    msgs.scrollTop = msgs.scrollHeight;
    try {
      const data = await api('POST', `/ai/ask/${docId}`, { question: q });
      document.getElementById('ai-typing').outerHTML = `<div class="ai-bubble bot">${esc(data.answer)}</div>`;
    } catch (e) {
      document.getElementById('ai-typing').outerHTML = `<div class="ai-bubble bot" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
    msgs.scrollTop = msgs.scrollHeight;
  },

  async reSummarise(docId) {
    toast('Generating AI summary…');
    try {
      const data = await api('POST', `/ai/summarise/${docId}`);
      const notesEl = document.getElementById('doc-edit-notes');
      if (notesEl) notesEl.value = data.summary;
      toast('Summary updated — remember to save!', 'success');
    } catch (e) {
      toast('AI summarise failed: ' + e.message, 'error');
    }
  },

  async reTag(docId) {
    toast('AI re-tagging document…');
    try {
      await api('POST', `/ai/retag/${docId}`);
      toast('AI re-tagging complete — reloading…', 'success');
      closeModal();
      await this.refreshMeta();
      this.openDoc(docId);
    } catch (e) {
      toast('AI re-tag failed: ' + e.message, 'error');
    }
  },
};
