// ---------------------------------------------------------------------
// Panel host (content script).
//
// Injects panel.html as a transparent iframe so the UI can have genuinely
// rounded corners, which a Chrome popup window can never have. The iframe
// lives inside a closed Shadow DOM so page CSS cannot leak in or out.
//
// This touches no audio logic — the panel still talks to background.js
// exactly as the popup did.
// ---------------------------------------------------------------------

(function () {
  'use strict';

  if (window.__aaePanelHost) return;
  window.__aaePanelHost = true;

  var host = null;
  var wrap = null;
  var frame = null;
  var isOpen = false;

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = '__aae_panel_host';
    var shadow = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = [
      '.wrap {',
      '  position: fixed;',
      '  top: -16px; right: -16px;',   /* offsets the 30px shadow padding */
      '  width: 478px; height: 700px;',
      '  max-height: calc(100vh - 20px);',
      '  z-index: 2147483647;',
      '  border: 0; margin: 0; padding: 0;',
      '  pointer-events: none;',
      '  opacity: 0;',
      '  transform: translateY(-10px) scale(.975);',
      '  transition: opacity .24s cubic-bezier(.34,1.4,.64,1),',
      '              transform .24s cubic-bezier(.34,1.4,.64,1);',
      '}',
      '.wrap.open { opacity: 1; transform: none; pointer-events: auto; }',
      'iframe {',
      '  display: block; width: 100%; height: 100%;',
      '  border: 0; outline: 0; margin: 0; padding: 0;',
      '  background: transparent !important;',
      '  background-color: transparent !important;',
      '  color-scheme: normal;',
      '}'
    ].join('');

    wrap = document.createElement('div');
    wrap.className = 'wrap';

    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('panel.html');
    frame.setAttribute('allowtransparency', 'true');
    frame.setAttribute('scrolling', 'no');

    wrap.appendChild(frame);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
  }

  function toggle(force) {
    build();
    isOpen = typeof force === 'boolean' ? force : !isOpen;
    wrap.classList.toggle('open', isOpen);
    // Let the panel stop its level polling while it is hidden.
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage({ __aaeHost: true, visible: isOpen }, '*');
      } catch (err) {}
    }
  }

  // Remove an orphaned panel entirely. After an extension reload the old
  // iframe cannot talk to chrome.* any more, so keeping it around would
  // just show a dead UI.
  function destroy() {
    isOpen = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; wrap = null; frame = null;
    window.__aaePanelHost = false;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) toggle(false);
  }, true);

  // Click anywhere on the page to dismiss, the way most extensions behave.
  // Clicks inside the panel never reach here: they land in the iframe's own
  // document, which does not bubble into the parent. So any event we see on
  // this document is by definition outside the panel.
  function dismissOnOutsideClick(e) {
    if (!isOpen) return;
    if (host && e.composedPath && e.composedPath().indexOf(host) !== -1) return;
    toggle(false);
  }

  document.addEventListener('pointerdown', dismissOnOutsideClick, true);

  // Clicking a cross-origin iframe (an embedded player, an ad) does not fire
  // pointerdown here, but it does move focus into that frame.
  window.addEventListener('blur', function () {
    if (!isOpen) return;
    // Ignore focus moving into our own panel.
    setTimeout(function () {
      if (document.activeElement && document.activeElement === frame) return;
      toggle(false);
    }, 0);
  });

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.__aae !== 'CLOSE_PANEL') return;
    // If our own bridge is dead too, tear the panel out rather than hide it.
    var alive = false;
    try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (err) {}
    if (alive) toggle(false); else destroy();
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (msg && msg.type === 'AAE_TOGGLE_PANEL') {
      toggle();
      respond({ ok: true });
    }
    return true;
  });
})();
