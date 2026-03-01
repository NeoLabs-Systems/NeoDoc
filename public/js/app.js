'use strict';

import { Auth, api } from './core/auth.js';
import { toast, openModal, closeModal } from './core/ui.js';
import { esc, hexToRgba } from './core/helpers.js';
import { State } from './state.js';

import { DocumentsMixin }     from './views/documents.js';
import { AIMixin }            from './views/ai.js';
import { UploadMixin }        from './views/upload.js';
import { TagsMixin }          from './views/tags.js';
import { TypesMixin }         from './views/types.js';
import { CorrespondentsMixin } from './views/correspondents.js';
import { SettingsMixin }      from './views/settings.js';
import { ChatMixin }          from './views/chat.js';

/* ── App core ───────────────────────────────────────────
   Navigation, sidebar, meta-refresh, and init logic.
   View methods are mixed in from ./views/*.js          */
const App = {

  async init() {
    document.getElementById('nav-settings').style.display = 'flex';

    // Theme is set by the inline IIFE in index.html — always follows OS preference
    // Listen for live OS theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    });

    await this.refreshMeta();
    this._initPWA();
    this.nav('documents');

    try {
      const pub = await api('GET', '/settings/public');
      if (pub && pub.app_name) {
        document.getElementById('app-name-label').textContent = pub.app_name;
        document.title = pub.app_name;
      }
    } catch (_) {}

    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('sidebar-upload-btn',  () => this.nav('upload'));
    bind('nav-documents',       () => this.nav('documents'));
    bind('nav-chat',            () => this.nav('chat'));
    bind('nav-tags',            () => this.nav('tags'));
    bind('nav-types',           () => this.nav('types'));
    bind('nav-correspondents',  () => this.nav('correspondents'));
    bind('nav-settings',        () => this.openSettingsModal());
    bind('signout-btn',         () => Auth.logout());
    bind('topbar-upload-btn',   () => this.nav('upload'));
    bind('mobile-menu-btn',     () => this._toggleSidebar());
    bind('mobile-overlay',      () => this._closeSidebar());

    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.addEventListener('input', e => this.onSearch(e.target.value));
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) sortSelect.addEventListener('change', e => this.onSortChange(e.target.value));
    bind('view-grid-btn', () => this.setView('grid'));
    bind('view-list-btn', () => this.setView('list'));
    bind('topbar-select-btn', () => this.toggleSelectMode());
  },

  async refreshMeta() {
    try {
      const [tags, types, correspondents, me] = await Promise.all([
        api('GET', '/tags'),
        api('GET', '/types'),
        api('GET', '/correspondents'),
        api('GET', '/auth/me'),
      ]);
      State.tags           = tags           || [];
      State.types          = types          || [];
      State.correspondents = correspondents || [];
      if (me) {
        State.userPrefs = {
          pref_ai_auto_tag:            me.pref_ai_auto_tag            ?? 'true',
          pref_ai_auto_type:           me.pref_ai_auto_type           ?? 'true',
          pref_ai_auto_summary:        me.pref_ai_auto_summary        ?? 'true',
          pref_ai_auto_correspondent:  me.pref_ai_auto_correspondent  ?? 'true',
          pref_ai_auto_create:         me.pref_ai_auto_create         ?? 'true',
          pref_ai_auto_title:          me.pref_ai_auto_title          ?? 'true',
          pref_ai_custom_instructions: me.pref_ai_custom_instructions ?? '',
          totp_enabled:                !!me.totp_enabled,
        };
      }
      this.renderSidebarTags();
      this.renderSidebarCorrespondents();
    } catch (_) {}
  },

  nav(view) {
    State.currentNav          = view;
    State.filterTag           = null;
    State.filterType          = null;
    State.filterCorrespondent = null;
    State.page                = 1;
    State.searchQ             = '';
    const si = document.getElementById('search-input');
    if (si) si.value = '';

    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });

    const searchBox = document.getElementById('search-box');
    const sortSel   = document.getElementById('sort-select');
    const viewBtns  = document.querySelectorAll('#view-grid-btn, #view-list-btn');
    const showSearch = view === 'documents';
    // Close mobile sidebar when navigating
    this._closeSidebar();
    searchBox.style.display  = showSearch ? 'flex' : 'none';
    sortSel.style.display    = showSearch ? ''     : 'none';
    viewBtns.forEach(b => b.style.display = showSearch ? '' : 'none');
    const selBtn = document.getElementById('topbar-select-btn');
    if (selBtn) selBtn.style.display = showSearch ? '' : 'none';
    // Exit select mode when leaving the documents view
    if (!showSearch && State.selectMode) {
      State.selectMode = false;
      State.selectedDocs.clear();
    }

    const titles = {
      documents:     'All Documents',
      upload:        'Upload Document',
      tags:          'Manage Tags',
      types:         'Document Types',
      correspondents: 'Correspondents',
      settings:      'Settings',
      chat:          'Ask AI',
    };
    document.getElementById('page-title').textContent = titles[view] || 'NeoDoc';

    switch (view) {
      case 'documents':      this.renderDocuments(); break;
      case 'upload':         this.renderUpload(); break;
      case 'tags':           this.renderTags(); break;
      case 'types':          this.renderTypes(); break;
      case 'correspondents': this.renderCorrespondents(); break;
      case 'settings':       this.openSettingsModal(); break;
      case 'chat':           this.renderChat(); break;
    }
  },

  setView(v) {
    State.view = v;
    document.getElementById('view-grid-btn').classList.toggle('active', v === 'grid');
    document.getElementById('view-list-btn').classList.toggle('active', v === 'list');
    this.renderDocuments();
  },

  onSearch(val) {
    clearTimeout(State.searchTimer);
    State.searchTimer = setTimeout(() => {
      State.searchQ = val.trim();
      State.page = 1;
      this.renderDocuments();
    }, 380);
  },

  onSortChange(val) {
    const [field, order] = val.split(':');
    State.sortField = field;
    State.sortOrder = order;
    State.page = 1;
    this.renderDocuments();
  },

  renderSidebarTags() {
    const container = document.getElementById('sidebar-tags-list');
    if (!State.tags.length) {
      container.innerHTML = `<span style="font-size:.78rem;color:var(--text-3);padding:.25rem 1rem;display:block">No tags yet</span>`;
      return;
    }
    container.innerHTML = State.tags.map(t => `
      <div class="nav-item${State.filterTag === t.id ? ' active' : ''}" onclick="App.filterByTag('${t.id}')">
        <div style="width:9px;height:9px;border-radius:50%;background:${t.color};flex-shrink:0"></div>
        ${esc(t.name)}
        <span class="nav-count">${t.document_count || 0}</span>
      </div>
    `).join('');
  },

  filterByTag(tagId) {
    State.filterTag           = State.filterTag === tagId ? null : tagId;
    State.filterCorrespondent = null;
    State.page = 1;
    this.renderSidebarTags();
    this.renderSidebarCorrespondents();
    if (State.currentNav !== 'documents') this.nav('documents');
    else this.renderDocuments();
  },

  filterByCorrespondent(corrId) {
    State.filterCorrespondent = State.filterCorrespondent === corrId ? null : corrId;
    State.filterTag           = null;
    State.page = 1;
    this.renderSidebarCorrespondents();
    this.renderSidebarTags();
    if (State.currentNav !== 'documents') this.nav('documents');
    else this.renderDocuments();
  },

  renderSidebarCorrespondents() {
    const container = document.getElementById('sidebar-correspondents-list');
    if (!container) return;
    if (!State.correspondents.length) {
      container.innerHTML = `<span style="font-size:.78rem;color:var(--text-3);padding:.25rem 1rem;display:block">No correspondents yet</span>`;
      return;
    }
    container.innerHTML = State.correspondents.map(c => `
      <div class="nav-item${State.filterCorrespondent === c.id ? ' active' : ''}" onclick="App.filterByCorrespondent('${c.id}')">
        <div style="width:9px;height:9px;border-radius:50%;background:${c.color};flex-shrink:0"></div>
        ${esc(c.name)}
        <span class="nav-count">${c.doc_count || 0}</span>
      </div>
    `).join('');
  },

  // ── Mobile sidebar ─────────────────────────────────────────────────────
  _toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const ov = document.getElementById('mobile-overlay');
    const open = sb.classList.toggle('open');
    if (ov) ov.classList.toggle('show', open);
  },

  _closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('mobile-overlay')?.classList.remove('show');
  },

  // ── PWA install ─────────────────────────────────────────────────────
  _deferredPrompt: null,
  _initPWA() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._deferredPrompt = e;
    });
  },
  async installPWA() {
    if (!this._deferredPrompt) {
      toast('App is already installed or install is not supported.', 'info');
      return;
    }
    this._deferredPrompt.prompt();
    const { outcome } = await this._deferredPrompt.userChoice;
    this._deferredPrompt = null;
    if (outcome === 'accepted') toast('Installing app…', 'success');
  },
};

// Mix all view modules into App
Object.assign(App,
  DocumentsMixin,
  AIMixin,
  UploadMixin,
  TagsMixin,
  TypesMixin,
  CorrespondentsMixin,
  SettingsMixin,
  ChatMixin,
);

// Expose globals for inline onclick handlers in HTML strings
window.App        = App;
window.Auth       = Auth;
window.toast      = toast;
window.closeModal = closeModal;
window.switchSettingsTab = (tab) => App.switchSettingsTab(tab);

document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // Mobile sidebar toggle (moved from inline onclick in HTML)
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('open');
    });
  }
});

