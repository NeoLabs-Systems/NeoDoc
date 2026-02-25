'use strict';

export function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

export function openModal(html, onClose) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = html;
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeModal();
  });
  root.appendChild(backdrop);
  if (onClose) backdrop._onClose = onClose;
  const inp = backdrop.querySelector('input');
  if (inp) setTimeout(() => inp.focus(), 50);
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  const backdrop = root.firstChild;
  if (backdrop && backdrop._onClose) backdrop._onClose();
  root.innerHTML = '';
}
