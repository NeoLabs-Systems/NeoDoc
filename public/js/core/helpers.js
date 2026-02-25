'use strict';

export function esc(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

// Safe for values embedded in single-quoted JS onclick attributes
export function escAttr(str) {
  return esc(str).replace(/'/g, '&#39;');
}

export function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function mimeIcon(mime) {
  if (!mime) return '📄';
  if (mime.includes('pdf'))   return '📕';
  if (mime.includes('image')) return '🖼️';
  if (mime.includes('text'))  return '📝';
  if (mime.includes('word') || mime.includes('document')) return '📄';
  return '📁';
}

export function docThumb(doc, token) {
  const mime = doc.mime_type || '';
  if (mime.startsWith('image/')) {
    return `<img src="/api/documents/${doc.id}/view?token=${encodeURIComponent(token)}" class="doc-thumb-img" loading="lazy" alt="">`;
  }
  if (mime.includes('pdf')) {
    return `<svg class="doc-thumb-icon" viewBox="0 0 40 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="48" rx="4" fill="#fee2e2"/><path d="M24 0v10h10z" fill="#fca5a5"/><rect x="24" y="0" width="10" height="10" rx="0" fill="#fca5a5"/><text x="20" y="33" text-anchor="middle" font-size="8.5" font-weight="700" fill="#dc2626" font-family="system-ui,sans-serif">PDF</text></svg>`;
  }
  if (mime.includes('word') || mime.includes('document') || mime.includes('officedocument')) {
    return `<svg class="doc-thumb-icon" viewBox="0 0 40 48" fill="none"><rect width="40" height="48" rx="4" fill="#dbeafe"/><path d="M24 0v10h10z" fill="#93c5fd"/><rect x="24" y="0" width="10" height="10" fill="#93c5fd"/><text x="20" y="33" text-anchor="middle" font-size="8.5" font-weight="700" fill="#2563eb" font-family="system-ui,sans-serif">DOC</text></svg>`;
  }
  if (mime.startsWith('text/')) {
    return `<svg class="doc-thumb-icon" viewBox="0 0 40 48" fill="none"><rect width="40" height="48" rx="4" fill="#f0fdf4"/><path d="M24 0v10h10z" fill="#86efac"/><rect x="24" y="0" width="10" height="10" fill="#86efac"/><text x="20" y="33" text-anchor="middle" font-size="8.5" font-weight="700" fill="#16a34a" font-family="system-ui,sans-serif">TXT</text></svg>`;
  }
  return `<svg class="doc-thumb-icon" viewBox="0 0 40 48" fill="none"><rect width="40" height="48" rx="4" fill="var(--surface3,#e5e7eb)"/><path d="M24 0v10h10z" fill="var(--border,#d1d5db)"/><rect x="24" y="0" width="10" height="10" fill="var(--border,#d1d5db)"/><line x1="8" y1="22" x2="32" y2="22" stroke="var(--text-3,#9ca3af)" stroke-width="2.5" stroke-linecap="round"/><line x1="8" y1="29" x2="32" y2="29" stroke="var(--text-3,#9ca3af)" stroke-width="2.5" stroke-linecap="round"/><line x1="8" y1="36" x2="24" y2="36" stroke="var(--text-3,#9ca3af)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}

export function hexToRgba(hex, a = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export const SWATCHES = [
  '#6366f1', '#22c55e', '#3b82f6', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#f97316',
];

export function colorSwatchPicker(current) {
  return `<div class="color-swatches" id="swatch-row">
    ${SWATCHES.map(c => `<div class="swatch${c === current ? ' selected' : ''}" style="background:${c}" title="${c}" onclick="pickSwatch(this,'${c}')"></div>`).join('')}
    <input type="color" id="color-custom" value="${current || '#6366f1'}" style="width:22px;height:22px;border:none;background:none;cursor:pointer;padding:0" title="Custom colour" onchange="pickSwatch(null,this.value)">
  </div>
  <input type="hidden" id="color-value" value="${current || '#6366f1'}">`;
}

// Register global handler used by inline onclick in colorSwatchPicker HTML
window.pickSwatch = function (el, color) {
  document.getElementById('color-value').value = color;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  if (el) el.classList.add('selected');
};
