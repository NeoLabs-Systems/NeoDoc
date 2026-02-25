'use strict';

import { Auth, api } from '../core/auth.js';
import { toast, openModal } from '../core/ui.js';
import { esc } from '../core/helpers.js';
import { State } from '../state.js';

export const SettingsMixin = {

  // ── Modal open / close ───────────────────────────────────────────────────
  openSettingsModal() {
    const overlay = document.getElementById('settings-overlay');
    overlay.style.display = 'flex';

    // Bind close button
    document.getElementById('settings-close').onclick = () => this.closeSettingsModal();

    // Close on backdrop click
    overlay.onclick = (e) => { if (e.target === overlay) this.closeSettingsModal(); };

    // Bind tab buttons
    document.querySelectorAll('#settings-tab-list .stab').forEach(btn => {
      btn.onclick = () => this.switchSettingsTab(btn.dataset.stab);
    });

    // Render default tab
    this.switchSettingsTab('ai');
  },

  closeSettingsModal() {
    document.getElementById('settings-overlay').style.display = 'none';
  },

  async switchSettingsTab(tab) {
    // Update active tab highlight
    document.querySelectorAll('#settings-tab-list .stab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.stab === tab);
    });

    const content = document.getElementById('settings-content');
    content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:13px">Loading…</div>';

    switch (tab) {
      case 'ai':       content.innerHTML = this._renderAiTab(); break;
      case 'mcp':      content.innerHTML = await this._renderMcpTabAsync(); break;
      case 'security': content.innerHTML = this._renderSecurityTab(); break;
      case 'smtp':     content.innerHTML = await this._renderSmtpTabAsync(); break;
    }
  },

  // ── Tab panels ──────────────────────────────────────────────────────────
  _renderAiTab() {
    const prefs = State.userPrefs;
    return `
    <div class="settings-panel">
      <h3>AI Preferences</h3>
      <p class="helper">Applied to your uploads. Requires <code>OPENAI_API_KEY</code> to be set in <code>.env</code>.</p>
      <div class="toggle-row" style="margin-bottom:.75rem">
        <span>Auto-tag on upload</span>
        <input type="checkbox" class="toggle" id="s-pref-tag" ${prefs.pref_ai_auto_tag !== 'false' ? 'checked' : ''}>
      </div>
      <div class="toggle-row" style="margin-bottom:.75rem">
        <span>Auto-detect document type</span>
        <input type="checkbox" class="toggle" id="s-pref-type" ${prefs.pref_ai_auto_type !== 'false' ? 'checked' : ''}>
      </div>
      <div class="toggle-row" style="margin-bottom:.75rem">
        <span>Auto-summarise content</span>
        <input type="checkbox" class="toggle" id="s-pref-summary" ${prefs.pref_ai_auto_summary !== 'false' ? 'checked' : ''}>
      </div>
      <div class="toggle-row" style="margin-bottom:.75rem">
        <span>Auto-detect correspondent</span>
        <input type="checkbox" class="toggle" id="s-pref-correspondent" ${prefs.pref_ai_auto_correspondent !== 'false' ? 'checked' : ''}>
      </div>
      <div class="toggle-row" style="margin-bottom:.75rem">
        <div>
          <span>Create new tags / types / correspondents if none match</span>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:.15rem">When off, AI only assigns from your existing ones</div>
        </div>
        <input type="checkbox" class="toggle" id="s-pref-create" ${prefs.pref_ai_auto_create !== 'false' ? 'checked' : ''}>
      </div>
      <div class="toggle-row">
        <span>Auto-set document title from content</span>
        <input type="checkbox" class="toggle" id="s-pref-title" ${prefs.pref_ai_auto_title !== 'false' ? 'checked' : ''}>
      </div>
      <div class="section-sep"></div>
      <div class="form-group">
        <label style="font-size:.82rem;font-weight:600">Custom AI Instructions</label>
        <div style="font-size:.77rem;color:var(--text-3);margin-bottom:.4rem">Appended to the system prompt for all AI interactions (chat, document Q&amp;A). Max 2000 characters.</div>
        <textarea id="s-pref-custom-instructions" rows="4" maxlength="2000" style="font-size:.82rem;resize:vertical" placeholder="e.g. Always respond in German. Refer to the user as 'you'.">${esc(prefs.pref_ai_custom_instructions || '')}</textarea>
      </div>
      <div class="section-sep"></div>
      <div style="display:flex;justify-content:flex-end">
        <button class="btn btn-primary btn-sm" onclick="App.saveSettings()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Preferences
        </button>
      </div>
    </div>`;
  },

  async _renderMcpTabAsync() {
    let mcpEnabled = false;
    let mcpKeys    = [];
    let mcpTokens  = [];
    try {
      const [mcpCfg, keys, tokens] = await Promise.all([
        api('GET', '/settings/mcp').catch(() => ({ mcp_enabled: false })),
        api('GET', '/mcp/keys').catch(() => []),
        api('GET', '/mcp/oauth/tokens').catch(() => []),
      ]);
      mcpEnabled = mcpCfg.mcp_enabled;
      mcpKeys    = keys;
      mcpTokens  = tokens;
    } catch (_) {}

    const mcpServerUrl = window.location.origin + '/api/mcp';

    return `
    <div class="settings-panel">
      <h3>MCP Server</h3>
      <p class="helper">
        Connect AI clients like Claude Desktop or Cursor to your vault via the
        <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">Model Context Protocol</a>.
      </p>

      <div class="toggle-row" style="margin-bottom:1.25rem">
        <div>
          <span>Enable MCP Server</span>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:.15rem">Allows AI clients to access your vault via API keys or OAuth</div>
        </div>
        <input type="checkbox" class="toggle" id="mcp-enabled-toggle" ${mcpEnabled ? 'checked' : ''} onchange="App.toggleMcp(this.checked)">
      </div>

      <div id="mcp-body" style="display:${mcpEnabled ? 'block' : 'none'}">

        <div style="margin-bottom:1.25rem">
          <label style="font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:.4rem">MCP Server URL</label>
          <div style="display:flex;gap:.5rem;align-items:center">
            <code id="mcp-url" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.45rem .75rem;font-size:.82rem;color:var(--text);word-break:break-all">${esc(mcpServerUrl)}</code>
            <button class="icon-btn" title="Copy URL" onclick="App.copyMcpUrl()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
        </div>

        <div style="margin-bottom:1.5rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
            <label style="font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin:0">API Keys</label>
            <button class="btn btn-ghost btn-sm" onclick="App.showCreateMcpKey()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Key
            </button>
          </div>
          <div id="mcp-keys-list">${this._renderMcpKeysList(mcpKeys)}</div>
        </div>

        <div style="margin-bottom:1.5rem">
          <label style="font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:.6rem">Authorized OAuth Clients</label>
          <div id="mcp-tokens-list">${this._renderMcpTokensList(mcpTokens)}</div>
        </div>

        <details>
          <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text-2);list-style:none;display:flex;align-items:center;gap:.5rem;padding:.5rem 0;border-top:1px solid var(--border)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            How to connect Claude Desktop
          </summary>
          <div style="margin-top:.75rem;font-size:12px;color:var(--text-3);line-height:1.6">
            <p style="margin-bottom:.5rem">Add this to your <code>claude_desktop_config.json</code>:</p>
            <pre id="mcp-claude-config" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.75rem;font-size:.75rem;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify({ mcpServers: { DocumentNeo: { url: mcpServerUrl, headers: { Authorization: 'Bearer YOUR_API_KEY_HERE' } } } }, null, 2))}</pre>
            <button class="btn btn-ghost btn-sm" style="margin-top:.4rem" onclick="App.copyClaudeConfig()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy config
            </button>
            <p style="margin-top:.75rem;padding:.65rem;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:11.5px">
              <strong>OAuth flow:</strong> Well-known endpoint at
              <code>${esc(window.location.origin + '/.well-known/oauth-authorization-server')}</code>
            </p>
          </div>
        </details>

      </div>
    </div>`;
  },

  _renderSecurityTab() {
    return `
    <div class="settings-panel">
      <h3>Change Password</h3>
      <p class="helper">After changing your password you will be signed out and need to log in again.</p>
      <div class="form-group" style="margin-bottom:.9rem">
        <label>Current Password</label>
        <input type="password" id="s-cur-pass" autocomplete="current-password">
      </div>
      <div class="form-group" style="margin-bottom:1rem">
        <label>New Password</label>
        <input type="password" id="s-new-pass" autocomplete="new-password" minlength="8">
      </div>
      <button class="btn btn-ghost btn-sm" onclick="App.changePassword()">Update Password</button>

      <div class="section-sep"></div>

      <h3>Session</h3>
      <p class="helper">Sign out of your account on this device.</p>
      <button class="btn btn-ghost btn-sm" onclick="Auth.logout()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </button>
    </div>`;
  },

  // ── Kept for backward-compat (e.g. showUserMenu calls nav('settings')) ──
  renderSettings() {
    this.openSettingsModal();
  },

  // ── MCP helpers ─────────────────────────────────────────────────────────
  _renderMcpKeysList(keys) {
    if (!keys.length) {
      return `<p style="font-size:12.5px;color:var(--text-3);padding:.4rem 0">No API keys yet. Create one to connect an AI client.</p>`;
    }
    const scopeBadge = (s) => {
      const map = { read: ['#22c55e','Read'], write: ['#f59e0b','Write'], readwrite: ['#3b82f6','R+W'] };
      const [color, label] = map[s] || ['#94a3b8', s];
      return `<span style="font-size:.7rem;font-weight:700;color:${color};background:${color}18;padding:.15rem .4rem;border-radius:4px">${label}</span>`;
    };
    return keys.map(k => `
      <div class="mcp-key-row" style="display:flex;align-items:center;gap:.625rem;padding:.55rem .75rem;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:.4rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;color:var(--text)">${esc(k.name)}</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:.1rem">
            <code>${esc(k.key_prefix)}…</code>
            · ${k.last_used ? 'Last used ' + new Date(k.last_used).toLocaleDateString() : 'Never used'}
            · ${new Date(k.created_at).toLocaleDateString()}
          </div>
        </div>
        ${scopeBadge(k.scope)}
        <button class="icon-btn" style="color:var(--danger);border:none;background:none" title="Delete key" onclick="App.deleteMcpKey('${esc(k.id)}', '${esc(k.name)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    `).join('');
  },

  _renderMcpTokensList(tokens) {
    if (!tokens.length) {
      return `<p style="font-size:12.5px;color:var(--text-3);padding:.4rem 0">No OAuth clients authorized yet.</p>`;
    }
    return tokens.map(t => `
      <div style="display:flex;align-items:center;gap:.625rem;padding:.55rem .75rem;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:.4rem">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;color:var(--text)">${esc(t.client_name || t.client_id)}</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:.1rem">Scope: ${esc(t.scope)} · Authorized ${new Date(t.created_at).toLocaleDateString()}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:var(--danger-dim)" onclick="App.revokeMcpToken('${esc(t.id)}', '${esc(t.client_name || t.client_id)}')">Revoke</button>
      </div>
    `).join('');
  },

  async toggleMcp(enabled) {
    try {
      await api('PATCH', '/settings/mcp', { enabled });
      document.getElementById('mcp-body').style.display = enabled ? 'block' : 'none';
      toast(enabled ? 'MCP server enabled.' : 'MCP server disabled.', 'success');
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
      document.getElementById('mcp-enabled-toggle').checked = !enabled;
    }
  },

  copyMcpUrl() {
    const url = document.getElementById('mcp-url')?.textContent || '';
    navigator.clipboard?.writeText(url).then(() => toast('URL copied.', 'success'));
  },

  copyClaudeConfig() {
    const cfg = document.getElementById('mcp-claude-config')?.textContent || '';
    navigator.clipboard?.writeText(cfg).then(() => toast('Config copied.', 'success'));
  },

  showCreateMcpKey() {
    openModal(`
      <div class="modal" style="max-width:380px">
        <div class="modal-header">
          <h3 style="font-size:1rem">New API Key</h3>
          <button class="icon-btn" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group" style="margin-bottom:.875rem">
            <label>Key Name</label>
            <input type="text" id="mk-name" placeholder="e.g. Claude Desktop" autofocus maxlength="100">
          </div>
          <div class="form-group" style="margin-bottom:1.25rem">
            <label>Permission Scope</label>
            <select id="mk-scope">
              <option value="read">Read-only — view and search documents</option>
              <option value="readwrite" selected>Read &amp; Write — full access</option>
              <option value="write">Write-only — create/edit/delete documents</option>
            </select>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:.5rem">
            <button class="btn btn-ghost btn-sm" onclick="closeModal()">Cancel</button>
            <button class="btn btn-primary btn-sm" onclick="App.createMcpKey()">Create Key</button>
          </div>
        </div>
      </div>
    `);
  },

  async createMcpKey() {
    const name  = document.getElementById('mk-name')?.value?.trim();
    const scope = document.getElementById('mk-scope')?.value;
    if (!name) { toast('Key name is required.', 'warn'); return; }
    try {
      const key = await api('POST', '/mcp/keys', { name, scope });
      closeModal();
      openModal(`
        <div class="modal" style="max-width:440px">
          <div class="modal-header">
            <h3 style="font-size:1rem;color:var(--success)">✓ API Key Created</h3>
            <button class="icon-btn" onclick="closeModal();App.switchSettingsTab('mcp')">✕</button>
          </div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-2);margin-bottom:1rem">
              <strong>Copy this key now.</strong> It will not be shown again.
            </p>
            <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:1.25rem">
              <code id="new-api-key" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.55rem .75rem;font-size:.82rem;word-break:break-all;color:var(--text)">${esc(key.api_key)}</code>
              <button class="icon-btn" title="Copy" onclick="navigator.clipboard.writeText(document.getElementById('new-api-key').textContent).then(()=>toast('Copied!','success'))">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
            <button class="btn btn-primary" style="width:100%" onclick="navigator.clipboard.writeText('${esc(key.api_key)}').then(()=>toast('Copied!','success'));closeModal();App.switchSettingsTab('mcp')">
              Copy &amp; Close
            </button>
          </div>
        </div>
      `);
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  },

  async deleteMcpKey(id, name) {
    if (!confirm(`Delete API key "${name}"? Any clients using it will lose access immediately.`)) return;
    try {
      await api('DELETE', `/mcp/keys/${id}`);
      toast('Key deleted.', 'success');
      const keys = await api('GET', '/mcp/keys').catch(() => []);
      document.getElementById('mcp-keys-list').innerHTML = this._renderMcpKeysList(keys);
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  },

  async revokeMcpToken(id, name) {
    if (!confirm(`Revoke access for "${name}"?`)) return;
    try {
      await api('DELETE', `/mcp/oauth/tokens/${id}`);
      toast('Access revoked.', 'success');
      const tokens = await api('GET', '/mcp/oauth/tokens').catch(() => []);
      document.getElementById('mcp-tokens-list').innerHTML = this._renderMcpTokensList(tokens);
    } catch (e) {
      toast('Failed: ' + e.message, 'error');
    }
  },

  // ── AI / password settings ───────────────────────────────────────────────

  async saveSettings() {
    const prefPayload = {
      pref_ai_auto_tag:           document.getElementById('s-pref-tag')?.checked           ? 'true' : 'false',
      pref_ai_auto_type:          document.getElementById('s-pref-type')?.checked          ? 'true' : 'false',
      pref_ai_auto_summary:       document.getElementById('s-pref-summary')?.checked       ? 'true' : 'false',
      pref_ai_auto_correspondent: document.getElementById('s-pref-correspondent')?.checked ? 'true' : 'false',
      pref_ai_auto_create:        document.getElementById('s-pref-create')?.checked        ? 'true' : 'false',
      pref_ai_auto_title:         document.getElementById('s-pref-title')?.checked         ? 'true' : 'false',
      pref_ai_custom_instructions: document.getElementById('s-pref-custom-instructions')?.value ?? '',
    };
    try {
      await api('PATCH', '/auth/me/preferences', prefPayload);
      Object.assign(State.userPrefs, prefPayload);
      toast('Saved.', 'success');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  },

  async changePassword() {
    const cur = document.getElementById('s-cur-pass').value;
    const nw  = document.getElementById('s-new-pass').value;
    if (!cur || !nw) { toast('Both fields required.', 'warn'); return; }
    if (nw.length < 8) { toast('New password must be at least 8 characters.', 'warn'); return; }
    try {
      await api('POST', '/auth/change-password', { current: cur, password: nw });
      toast('Password changed. Please sign in again.', 'success');
      setTimeout(() => Auth.logout(), 2000);
    } catch (e) {
      toast('Password change failed: ' + e.message, 'error');
    }
  },

  // ── Email / SMTP tab ─────────────────────────────────────────────────────
  async _renderSmtpTabAsync() {
    let cfg = {};
    try { cfg = await api('GET', '/signing/smtp'); } catch (_) {}
    return `
    <div class="settings-panel">
      <h3>Email / SMTP</h3>
      <p class="helper">Configure outgoing email for document-signing invitations, reminders, and completion notices. Credentials are stored per-user and never shared.</p>
      <div class="toggle-row" style="margin-bottom:1rem">
        <div>
          <span>Enable email notifications</span>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:.15rem">Sends invite / reminder / completion emails via your SMTP server</div>
        </div>
        <input type="checkbox" class="toggle" id="smtp-enabled" ${cfg.smtp_enabled === 'true' ? 'checked' : ''}>
      </div>
      <div class="form-grid2" style="display:grid;grid-template-columns:1fr 90px;gap:.6rem .75rem;margin-bottom:.6rem">
        <div class="form-group" style="margin:0">
          <label style="font-size:.8rem;font-weight:600">SMTP Host</label>
          <input id="smtp-host" class="form-input" value="${esc(cfg.smtp_host || '')}" placeholder="smtp.example.com">
        </div>
        <div class="form-group" style="margin:0">
          <label style="font-size:.8rem;font-weight:600">Port</label>
          <input id="smtp-port" type="number" class="form-input" value="${cfg.smtp_port || 587}" min="1" max="65535">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:.6rem">
        <label style="font-size:.8rem;font-weight:600">Username</label>
        <input id="smtp-user" class="form-input" value="${esc(cfg.smtp_user || '')}" placeholder="user@example.com" autocomplete="username">
      </div>
      <div class="form-group" style="margin-bottom:.6rem">
        <label style="font-size:.8rem;font-weight:600">Password</label>
        <input id="smtp-pass" type="password" class="form-input" value="" placeholder="Leave blank to keep current" autocomplete="current-password">
      </div>
      <div class="form-group" style="margin-bottom:.6rem">
        <label style="font-size:.8rem;font-weight:600">From Address</label>
        <input id="smtp-from" class="form-input" value="${esc(cfg.smtp_from || '')}" placeholder="YourName <you@example.com>">
      </div>
      <div class="form-group" style="margin-bottom:1rem">
        <label style="font-size:.8rem;font-weight:600">Security</label>
        <select id="smtp-secure" class="form-input">
          <option value="tls"  ${(cfg.smtp_secure || 'tls') === 'tls'  ? 'selected' : ''}>STARTTLS (port 587)</option>
          <option value="ssl"  ${cfg.smtp_secure === 'ssl'  ? 'selected' : ''}>SSL / TLS (port 465)</option>
          <option value="none" ${cfg.smtp_secure === 'none' ? 'selected' : ''}>None (port 25)</option>
        </select>
      </div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="App.testSmtp()">Test Connection</button>
        <button class="btn btn-primary btn-sm" onclick="App.saveSmtp()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save
        </button>
      </div>
    </div>`;
  },

  async saveSmtp() {
    const body = {
      smtp_enabled: document.getElementById('smtp-enabled').checked ? 'true' : 'false',
      smtp_host:    document.getElementById('smtp-host').value.trim(),
      smtp_port:    parseInt(document.getElementById('smtp-port').value, 10) || 587,
      smtp_user:    document.getElementById('smtp-user').value.trim(),
      smtp_from:    document.getElementById('smtp-from').value.trim(),
      smtp_secure:  document.getElementById('smtp-secure').value,
    };
    const pass = document.getElementById('smtp-pass').value;
    if (pass) body.smtp_pass = pass;
    try {
      await api('PUT', '/signing/smtp', body);
      toast('SMTP settings saved.', 'success');
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    }
  },

  async testSmtp() {
    const btn = document.querySelector('#settings-content .btn-ghost');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
    try {
      const r = await api('POST', '/signing/smtp/test', {});
      toast(r.message || 'Connection OK.', 'success');
    } catch (e) {
      toast('Test failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  },

  showUserMenu() {
    openModal(`<div class="modal" style="max-width:280px">
      <div class="modal-header">
        <div class="user-avatar" style="width:36px;height:36px">${Auth.username().slice(0, 2).toUpperCase()}</div>
        <div>
          <div style="font-weight:600">${esc(Auth.username())}</div>
          <div style="font-size:.75rem;color:var(--text-3)">${Auth.role()}</div>
        </div>
        <button class="icon-btn" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:.5rem">
        <button class="btn btn-ghost" onclick="closeModal();App.openSettingsModal()">⚙️ Settings</button>
        <button class="btn btn-danger" onclick="Auth.logout()">Sign Out</button>
      </div>
    </div>`);
  },
};

