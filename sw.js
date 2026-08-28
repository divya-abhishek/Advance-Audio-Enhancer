// ---------------------------------------------------------------------
// Panel host shim.
//
// background.js is imported byte-for-byte untouched — all audio, capture
// and settings logic still lives there and is unchanged. This file only
// adds the toolbar-click handler that toggles the in-page panel.
//
// Why a panel instead of default_popup: Chrome draws the popup's window
// frame itself (opaque, square) and extension CSS cannot round it —
// crbug.com/40852436. Injecting a transparent iframe into the page is the
// only way to get real rounded corners.
// ---------------------------------------------------------------------

importScripts('background.js');

function togglePanel(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'AAE_TOGGLE_PANEL' }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // Already-open tabs (from before install/reload) have no content script yet,
  // so a failed message is not proof of a restricted page — inject and retry.
  if (await togglePanel(tab.id)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['panel-host.js'],
    });
  } catch (err) {
    // Genuinely restricted (chrome://, Web Store, PDF viewer).
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#94a3b8' });
    chrome.action.setBadgeText({ tabId: tab.id, text: '—' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500);
    return;
  }

  await new Promise((r) => setTimeout(r, 60));
  await togglePanel(tab.id);
});
