// Wird als ERSTES Skript geladen (ohne defer) und ist bewusst in altem JavaScript (ES5) geschrieben:
// Selbst wenn ein anderes Skript auf einem alten iPhone an der Syntax scheitert, läuft dieses hier noch.
//
// 1. Polyfills: Funktionen, die ältere Safaris (iOS 13) noch nicht kennen.
// 2. Globaler Fehlerfänger: statt einer eingefrorenen Seite erscheint ein Hinweis mit "Neu laden".

(function () {
  'use strict';

  // ---------- 1. Polyfills ----------

  // Element.replaceChildren: erst ab Safari 14
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append.apply(this, arguments);
    };
  }

  // ---------- 2. Globaler Fehlerfänger ----------

  var shown = false;

  /** Alle Overlays entfernen, die Eingaben blockieren könnten (z. B. die Misch-Bühne) */
  function clearOverlays() {
    var stages = document.querySelectorAll('.fx-stage');
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].parentNode) stages[i].parentNode.removeChild(stages[i]);
    }
  }

  function showCrash() {
    clearOverlays();
    if (shown) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showCrash);
      return;
    }
    shown = true;
    var box = document.createElement('div');
    box.className = 'crash';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'crash-title');
    var title = document.createElement('p');
    title.id = 'crash-title';
    title.className = 'crash-title';
    title.textContent = 'Etwas ist schiefgelaufen – neu laden';
    var text = document.createElement('p');
    text.className = 'crash-text';
    text.textContent = 'Keine Sorge: Dein Platz und der Spielstand bleiben erhalten.';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-gold';
    button.textContent = 'Neu laden';
    button.addEventListener('click', function () { window.location.reload(); });
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(button);
    document.body.appendChild(box);
  }

  /** Nur Fehler aus unseren eigenen Skripten zählen – nicht von Browser-Erweiterungen o. Ä. */
  function isOurs(filename) {
    return !filename || filename.indexOf(window.location.origin) === 0;
  }

  window.addEventListener('error', function (event) {
    // Ladefehler von Bildern o. Ä. kommen nicht hierher (die blubbern nicht bis window) – gut so.
    var message = String(event.message || '');
    if (message === 'Script error.' || message.indexOf('ResizeObserver loop') === 0) return;
    if (!isOurs(event.filename)) return;
    showCrash();
  });

  window.addEventListener('unhandledrejection', function () {
    showCrash();
  });

  window.SkatCrash = { show: showCrash, clearOverlays: clearOverlays };
})();
