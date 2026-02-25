'use strict';

import { api } from '../core/auth.js';
import { toast } from '../core/ui.js';
import { esc } from '../core/helpers.js';
import { State } from '../state.js';

export const ChatMixin = {

  renderChat() {
    const content = document.getElementById('content');
    content.innerHTML = `
    <div id="chat-shell">

      <!-- Messages feed -->
      <div id="chat-messages" role="log" aria-live="polite">
        ${this._buildChatHistory()}
        ${State.chatMessages.length === 0 ? this._chatWelcome() : ''}
      </div>

      <!-- Input bar -->
      <div id="chat-input-bar">
        <div id="chat-input-wrap">
          <textarea
            id="chat-input"
            placeholder="Ask anything about your documents…"
            rows="1"
            maxlength="600"
            onkeydown="App._chatKeydown(event)"
            oninput="App._chatAutoResize(this)"
            autofocus
          ></textarea>
          <button id="chat-send-btn" class="btn btn-primary btn-sm" onclick="App.sendChat()" title="Send (Enter)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
        <p id="chat-hint" style="font-size:.72rem;color:var(--text-3);margin-top:.4rem;text-align:center">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:2px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Answers are drawn from documents in your vault. Requires OpenAI.
        </p>
      </div>
    </div>`;

    this._chatScrollToBottom(false);
  },

  _chatWelcome() {
    const suggestions = [
      'What invoices do I have from last year?',
      'Summarise my contracts',
      'Find documents about taxes',
      'What are the key dates in my documents?',
    ];
    return `
    <div id="chat-welcome">
      <div class="chat-welcome-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <h2>Ask your documents</h2>
      <p>I'll search your vault and answer based on what's in your files.</p>
      <div id="chat-suggestions">
        ${suggestions.map(s => `<button class="chat-suggestion" onclick="App._useSuggestion('${esc(s)}')">${esc(s)}</button>`).join('')}
      </div>
    </div>`;
  },

  _buildChatHistory() {
    return State.chatMessages.map(m => this._buildChatBubble(m)).join('');
  },

  _buildChatBubble(m) {
    if (m.role === 'user') {
      return `<div class="chat-row chat-row-user">
        <div class="chat-bubble chat-bubble-user">${esc(m.content)}</div>
      </div>`;
    }
    const sourcesHtml = m.sources?.length
      ? `<div class="chat-sources">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Sources:
          ${m.sources.map(s => `<button class="chat-source-chip" onclick="App.openDoc('${esc(s.id)}')">${esc(s.title)}</button>`).join('')}
        </div>`
      : '';
    return `<div class="chat-row chat-row-bot">
      <div class="chat-avatar-bot">AI</div>
      <div>
        <div class="chat-bubble chat-bubble-bot">${this._renderMarkdown(m.content)}</div>
        ${sourcesHtml}
      </div>
    </div>`;
  },

  // Very lightweight markdown rendering (bold, inline code, line breaks)
  _renderMarkdown(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  },

  async sendChat() {
    const el = document.getElementById('chat-input');
    if (!el) return;
    const question = el.value.trim();
    if (!question || State.chatLoading) return;

    el.value = '';
    this._chatAutoResize(el);

    // Append user bubble
    const userMsg = { role: 'user', content: question };
    State.chatMessages.push(userMsg);
    this._appendChatBubble(userMsg);

    // Hide welcome screen if still showing
    const welcome = document.getElementById('chat-welcome');
    if (welcome) welcome.remove();

    // Show typing indicator
    State.chatLoading = true;
    this._setTyping(true);

    try {
      const historyPayload = State.chatMessages.slice(-14)
        .filter(m => m.role !== 'typing')
        .map(m => ({ role: m.role, content: m.content }));

      const res = await api('POST', '/ai/chat', {
        question,
        history: historyPayload.slice(0, -1), // exclude just-added user msg, server re-adds it
      });

      this._setTyping(false);
      const botMsg = { role: 'assistant', content: res.answer, sources: res.sources || [] };
      State.chatMessages.push(botMsg);
      this._appendChatBubble(botMsg);
    } catch (e) {
      this._setTyping(false);
      const errMsg = { role: 'assistant', content: `Sorry, something went wrong: ${e.message}`, sources: [] };
      State.chatMessages.push(errMsg);
      this._appendChatBubble(errMsg);
      toast('AI error: ' + e.message, 'error');
    } finally {
      State.chatLoading = false;
      document.getElementById('chat-send-btn')?.removeAttribute('disabled');
    }
  },

  _appendChatBubble(m) {
    const feed = document.getElementById('chat-messages');
    if (!feed) return;
    const div = document.createElement('div');
    div.innerHTML = this._buildChatBubble(m);
    while (div.firstChild) feed.appendChild(div.firstChild);
    this._chatScrollToBottom(true);
  },

  _setTyping(on) {
    const feed = document.getElementById('chat-messages');
    if (!feed) return;
    const existing = document.getElementById('chat-typing');
    if (on && !existing) {
      feed.insertAdjacentHTML('beforeend', `
        <div class="chat-row chat-row-bot" id="chat-typing">
          <div class="chat-avatar-bot">AI</div>
          <div class="chat-bubble chat-bubble-bot chat-typing-bubble">
            <span></span><span></span><span></span>
          </div>
        </div>`);
      this._chatScrollToBottom(true);
    } else if (!on && existing) {
      existing.remove();
    }
    const sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) { if (on) sendBtn.setAttribute('disabled', ''); else sendBtn.removeAttribute('disabled'); }
  },

  _chatScrollToBottom(smooth) {
    const feed = document.getElementById('chat-messages');
    if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  },

  _chatKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendChat();
    }
  },

  _chatAutoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  },

  _useSuggestion(text) {
    const el = document.getElementById('chat-input');
    if (el) {
      el.value = text;
      el.focus();
      this._chatAutoResize(el);
    }
  },

  clearChat() {
    State.chatMessages = [];
    this.renderChat();
  },
};
