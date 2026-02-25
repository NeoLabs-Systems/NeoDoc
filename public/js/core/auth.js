'use strict';

export const Auth = (() => {
  function token()    { return localStorage.getItem('dn_token'); }
  function username() { return localStorage.getItem('dn_username') || 'User'; }
  function role()     { return localStorage.getItem('dn_role') || 'user'; }
  function isAdmin()  { return role() === 'admin'; }

  function logout() {
    localStorage.removeItem('dn_token');
    localStorage.removeItem('dn_username');
    localStorage.removeItem('dn_role');
    window.location.href = '/login';
  }

  if (!token()) window.location.href = '/login';

  return { token, username, role, isAdmin, logout };
})();

export async function api(method, path, body, isFormData = false) {
  const headers = { 'Authorization': `Bearer ${Auth.token()}` };
  if (body && !isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch('/api' + path, {
    method,
    headers,
    body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401) { Auth.logout(); return; }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
