// ---------------------------------------------------------------------
// Advanced Audio Enhancer — service worker
//
// Owns per-tab settings and the tab-capture lifecycle. The actual audio
// processing lives in the offscreen document (offscreen.js), because a
// service worker has no AudioContext.
// ---------------------------------------------------------------------

const DEFAULTS = {
  enabled: true,
  reverb: 0,
  bass: 0,
  clarity: 0,
  volume: 1,
  presets: { lofi: false, eightd: false, vocal: false },
};

const tabSettings = new Map(); // tabId -> settings
const capturing = new Set();   // tabIds with an active capture

function getSettings(tabId) {
  if (!tabSettings.has(tabId)) {
    tabSettings.set(tabId, JSON.parse(JSON.stringify(DEFAULTS)));
  }
  return tabSettings.get(tabId);
}

// Settings are "neutral" when nothing would change the audio, so there's
// no reason to hold a capture open.
function isNeutral(s) {
  if (!s.enabled) return true;
  const p = s.presets || {};
  return (
    !s.reverb && !s.bass && !s.clarity &&
    Math.abs((s.volume ?? 1) - 1) < 0.001 &&
    !p.lofi && !p.eightd && !p.vocal
  );
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Process captured tab audio for equalizer and effects.',
  });
}

async function startCapture(tabId, settings) {
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    tabId,
    streamId,
    settings,
  });
  if (res && res.ok) capturing.add(tabId);
  return res;
}

async function updateCapture(tabId, settings) {
  if (!capturing.has(tabId)) return { ok: false, notCapturing: true };
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'UPDATE_SETTINGS',
    tabId,
    settings,
  });
}

async function stopCapture(tabId) {
  if (!capturing.has(tabId)) return { ok: true };
  capturing.delete(tabId);
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'STOP_CAPTURE',
    tabId,
  });
  // Tear the offscreen document down once no tab needs it.
  if (res && res.remaining === 0) {
    try { await chrome.offscreen.closeDocument(); } catch (err) {}
  }
  return res;
}

// LoFi's pitch drop needs playbackRate on the media elements themselves,
// which tab capture can't do — so a small content script handles it.
// Purely cosmetic if injection fails (e.g. restricted page).
//
// PERF: this injects into every frame, which is far too expensive to run on
// every slider tick. It only ever matters when the LoFi flag actually flips,
// so we remember the last state per tab and no-op otherwise.
const lastLofiState = new Map(); // tabId -> boolean

async function syncPlaybackRate(tabId, settings, force) {
  const slowed = !!(settings.enabled && settings.presets && settings.presets.lofi);
  if (!force && lastLofiState.get(tabId) === slowed) return;
  lastLofiState.set(tabId, slowed);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (shouldSlow) => {
        document.querySelectorAll('audio, video').forEach((el) => {
          if (el.__aaeBaseRate === undefined) el.__aaeBaseRate = el.playbackRate || 1;
          const target = shouldSlow ? el.__aaeBaseRate * 0.87 : el.__aaeBaseRate;
          if (Math.abs(el.playbackRate - target) > 0.001) {
            try { el.playbackRate = target; } catch (e) {}
          }
        });
      },
      args: [!!slowed],
    });
  } catch (err) {
    // Restricted page or no permission — ignore.
  }
}

async function applyToTab(tabId, opts) {
  const settings = getSettings(tabId);
  const forceRate = !!(opts && opts.forceRate);

  if (isNeutral(settings)) {
    await stopCapture(tabId);
  } else if (capturing.has(tabId)) {
    const res = await updateCapture(tabId, settings);
    // `ok` is true even when the offscreen engine has gone away (its capture
    // track ended on navigation), so `active` is the field that actually
    // tells us whether the graph still exists. Without this check the
    // settings were sent into the void after every YouTube autoplay.
    if (!res || !res.ok || res.active === false) {
      capturing.delete(tabId);
      await startCapture(tabId, settings);
    }
  } else {
    await startCapture(tabId, settings);
  }

  await syncPlaybackRate(tabId, settings, forceRate);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return;

  const tabId = message.tabId;

  (async () => {
    try {
      switch (message.type) {
        case 'GET_LEVEL': {
          // When we're capturing, read the real signal level from the
          // analyser. Otherwise fall back to Chrome's own "is this tab
          // making noise" flag.
          if (capturing.has(tabId)) {
            const res = await chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'GET_LEVEL',
              tabId,
            });
            if (res && res.active) {
              sendResponse({ playing: res.level > 0.008, level: res.level });
              return;
            }
          }
          const tab = await chrome.tabs.get(tabId);
          sendResponse({ playing: !!(tab && tab.audible), level: null });
          return;
        }
        case 'GET_STATE': {
          const settings = getSettings(tabId);
          sendResponse({ ...settings, capturing: capturing.has(tabId) });
          return;
        }
        case 'SET_EFFECT': {
          const s = getSettings(tabId);
          s[message.effect] = Math.min(1, Math.max(0, message.value));
          await applyToTab(tabId);
          sendResponse({ ok: true });
          return;
        }
        case 'SET_PRESET': {
          const s = getSettings(tabId);
          s.presets[message.preset] = !!message.active;
          await applyToTab(tabId);
          sendResponse({ ok: true });
          return;
        }
        case 'SET_VOLUME': {
          const s = getSettings(tabId);
          s.volume = message.volume;
          await applyToTab(tabId);
          sendResponse({ ok: true });
          return;
        }
        case 'SET_ENABLED': {
          const s = getSettings(tabId);
          s.enabled = !!message.enabled;
          await applyToTab(tabId);
          sendResponse({ ok: true });
          return;
        }
        case 'CLEAR_ALL': {
          tabSettings.set(tabId, JSON.parse(JSON.stringify(DEFAULTS)));
          await applyToTab(tabId);
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();

  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(reapplyTimers.get(tabId));
  reapplyTimers.delete(tabId);
  lastLofiState.delete(tabId);
  tabSettings.delete(tabId);
  stopCapture(tabId);
});

// Navigation — including YouTube's autoplay, which swaps the video in the
// same tab via the History API — can invalidate the capture stream. Rather
// than dropping the capture and waiting for the user to touch a control, we
// re-apply the tab's settings so playback continues enhanced.
const reapplyTimers = new Map();

function scheduleReapply(tabId) {
  const settings = tabSettings.get(tabId);
  lastLofiState.delete(tabId); // new document, new media elements
  if (!settings || isNeutral(settings)) return;

  clearTimeout(reapplyTimers.get(tabId));
  reapplyTimers.set(
    tabId,
    setTimeout(() => {
      reapplyTimers.delete(tabId);
      // A fresh media element needs the rate stamped again even though the
      // LoFi flag itself has not changed.
      applyToTab(tabId, { forceRate: true }).catch(() => {});
    }, 350) // let the new media element attach first
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // `url` fires for SPA navigations (YouTube next video); `complete` covers
  // ordinary full page loads.
  if (changeInfo.url || changeInfo.status === 'complete') {
    scheduleReapply(tabId);
  }
});
