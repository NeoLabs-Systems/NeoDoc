'use strict';

// Redirect if already logged in
if (localStorage.getItem('dn_token')) window.location.href = '/';

// ── Tab switching ─────────────────────────────────────
document.getElementById('tab-login').addEventListener('click', function () { switchTab('login'); });
document.getElementById('tab-register').addEventListener('click', function () { switchTab('register'); });

function switchTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('login-form').style.display    = tab === 'login'    ? 'flex' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? 'flex' : 'none';
}

// ── Error helpers ─────────────────────────────────────
function showError(elId, msg) {
  var el = document.getElementById(elId);
  el.textContent = msg;
  el.style.display = 'block';
}
function hideError(elId) {
  document.getElementById(elId).style.display = 'none';
}

// ── Sign In ───────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  hideError('login-error');
  var btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    var res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        identifier: document.getElementById('login-id').value,
        password:   document.getElementById('login-pass').value,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    localStorage.setItem('dn_token',    data.token);
    localStorage.setItem('dn_username', data.username);
    localStorage.setItem('dn_role',     data.role);
    const next = new URLSearchParams(location.search).get('next');
    window.location.href = next || '/';
  } catch (ex) {
    showError('login-error', ex.message);
    btn.disabled = false; btn.textContent = 'Sign In';
  }
});

// ── Register ──────────────────────────────────────────
document.getElementById('register-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  hideError('reg-error');
  var pass  = document.getElementById('reg-pass').value;
  var pass2 = document.getElementById('reg-pass2').value;
  if (pass !== pass2) { showError('reg-error', 'Passwords do not match.'); return; }
  var btn = document.getElementById('reg-btn');
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    var res = await fetch('/api/auth/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        username: document.getElementById('reg-username').value,
        email:    document.getElementById('reg-email').value,
        password: pass,
      }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');
    localStorage.setItem('dn_token',    data.token);
    localStorage.setItem('dn_username', data.username);
    localStorage.setItem('dn_role',     data.role);
    const next = new URLSearchParams(location.search).get('next');
    window.location.href = next || '/';
  } catch (ex) {
    showError('reg-error', ex.message);
    btn.disabled = false; btn.textContent = 'Create Account';
  }
});
