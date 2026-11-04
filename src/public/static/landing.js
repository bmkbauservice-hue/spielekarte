'use strict';
// Startseite: Karten-Code eingeben → zum Spielraum.
(() => {
  const BASE = document.querySelector('meta[name="base-path"]').content;
  const form = document.getElementById('code-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = form.code.value.trim().toUpperCase();
    if (/^[A-Z0-9]{3,16}$/.test(code)) location.href = `${BASE}/k/${code}`;
  });
})();
