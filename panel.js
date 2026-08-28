// The panel talks to the service worker only. All audio processing runs
// on a tab-capture stream in the offscreen document, so this works the
// same on every site — DRM, cross-origin or otherwise.
//
// Identical to the old popup logic. The only change is how the host tab is
// resolved: this page is now an iframe inside the page rather than a popup
// window, so `currentWindow` is not a reliable anchor — `lastFocusedWindow`
// is, with `currentWindow` kept as a fallback.

let activeTabId = null;
let levelTimer = null;

// True once the extension has been reloaded/updated out from under this
// panel. The iframe survives in the page but its chrome.* bridge is dead,
// so every further call would throw "Extension context invalidated".
let contextDead = false;

function teardown() {
  if (contextDead) return;
  contextDead = true;
  clearInterval(levelTimer);
  document.body.classList.remove('playing');
  // Ask the host page to remove this orphaned panel.
  try { parent.postMessage({ __aae: 'CLOSE_PANEL' }, '*'); } catch (err) {}
}

function contextAlive() {
  try {
    return !contextDead && !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

function send(message) {
  return new Promise((resolve) => {
    if (!contextAlive()) {
      teardown();
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage({ ...message, tabId: activeTabId }, (response) => {
        void chrome.runtime.lastError; // always read; never surfaces as "unchecked"
        resolve(response || null);
      });
    } catch (err) {
      // Context died between the check above and the call.
      teardown();
      resolve(null);
    }
  });
}

let statusTimer = null;
function flashError(text) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

async function pushChange(message) {
  const res = await send(message);
  if (res && res.ok === false && res.error) {
    flashError("Couldn't capture this tab's audio. Try reloading the page.");
  }
}

// PERF: a slider drag fires input events far faster than the audio graph
// needs updating. Coalesce them onto one animation frame so we send at most
// one message per frame per control, with the last value always winning.
const pendingChanges = new Map();
let flushHandle = 0;

function flushChanges() {
  flushHandle = 0;
  const queued = Array.from(pendingChanges.values());
  pendingChanges.clear();
  queued.forEach(pushChange);
}

function queueChange(key, message) {
  pendingChanges.set(key, message);
  if (!flushHandle) flushHandle = requestAnimationFrame(flushChanges);
}

// ---- Sliders ----
function paintSlider(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.background =
    `linear-gradient(to right, var(--accent-deep) 0%, var(--accent2) ${pct}%, var(--track) ${pct}%, var(--track) 100%)`;
}

function setupEffectSlider(id) {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);

  const render = () => {
    label.textContent = `${input.value}%`;
    paintSlider(input);
  };

  input.addEventListener('input', () => {
    render();
    queueChange(id, { type: 'SET_EFFECT', effect: id, value: parseInt(input.value, 10) / 100 });
  });

  return {
    set(value01) {
      input.value = Math.round((value01 || 0) * 100);
      render();
    },
  };
}

const sliders = {
  reverb: setupEffectSlider('reverb'),
  bass: setupEffectSlider('bass'),
  clarity: setupEffectSlider('clarity'),
};

// ---- Volume (20% - 300%) ----
const volumeInput = document.getElementById('volume');
const volumeLabel = document.getElementById('volume-val');

function renderVolume() {
  volumeLabel.textContent = `${volumeInput.value}%`;
  paintSlider(volumeInput);
}

function setVolumeUI(multiplier) {
  volumeInput.value = Math.round((multiplier ?? 1) * 100);
  renderVolume();
}

volumeInput.addEventListener('input', () => {
  renderVolume();
  queueChange('volume', { type: 'SET_VOLUME', volume: parseInt(volumeInput.value, 10) / 100 });
});

// ---- Presets ----
const presetButtons = {
  lofi: document.getElementById('preset-lofi'),
  eightd: document.getElementById('preset-eightd'),
  vocal: document.getElementById('preset-vocal'),
};

const presetState = { lofi: false, eightd: false, vocal: false };

function renderPresets() {
  Object.entries(presetButtons).forEach(([key, btn]) => {
    btn.setAttribute('aria-pressed', String(!!presetState[key]));
  });
}

Object.entries(presetButtons).forEach(([key, btn]) => {
  btn.addEventListener('click', () => {
    presetState[key] = !presetState[key];
    renderPresets();
    pushChange({ type: 'SET_PRESET', preset: key, active: presetState[key] });
  });
});

// ---- Clear All ----
document.getElementById('clear-all').addEventListener('click', () => {
  sliders.reverb.set(0);
  sliders.bass.set(0);
  sliders.clarity.set(0);
  setVolumeUI(1);
  presetState.lofi = false;
  presetState.eightd = false;
  presetState.vocal = false;
  renderPresets();
  pushChange({ type: 'CLEAR_ALL' });
});

// ---- Master power ----
const powerBtn = document.getElementById('power');
const contentEl = document.getElementById('content');

function setEnabledUI(enabled) {
  powerBtn.setAttribute('aria-pressed', String(enabled));
  contentEl.classList.toggle('off', !enabled);
}

powerBtn.addEventListener('click', () => {
  const enabled = powerBtn.getAttribute('aria-pressed') !== 'true';
  setEnabledUI(enabled);
  pushChange({ type: 'SET_ENABLED', enabled });
});

// ---- Live playback detection (drives the animated wave/EQ icons) ----
async function pollPlaying() {
  if (!contextAlive()) { teardown(); return; }
  const res = await send({ type: 'GET_LEVEL' });
  if (contextDead) return;
  document.body.classList.toggle('playing', !!(res && res.playing));
}

// PERF: the level poll exists only to drive a decorative animation, so it
// runs at a modest rate and stops entirely whenever nobody can see it —
// panel hidden, tab in the background, or window minimised.
const POLL_MS = 600;

function startLevelPolling() {
  if (levelTimer) return;
  pollPlaying();
  levelTimer = setInterval(pollPlaying, POLL_MS);
}

function stopLevelPolling() {
  clearInterval(levelTimer);
  levelTimer = null;
  document.body.classList.remove('playing');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLevelPolling();
  else if (activeTabId && contextAlive()) startLevelPolling();
});

// The host page tells us when the panel is shown or hidden, so a panel that
// is merely closed (not destroyed) costs nothing.
window.addEventListener('message', (e) => {
  if (!e.data || e.data.__aaeHost !== true) return;
  if (e.data.visible === false) stopLevelPolling();
  else if (activeTabId && contextAlive()) startLevelPolling();
});

window.addEventListener('pagehide', stopLevelPolling);
window.addEventListener('unload', stopLevelPolling);

// ---- Init ----
function findHostTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      if (tabs && tabs[0] && tabs[0].id) return resolve(tabs[0]);
      chrome.tabs.query({ active: true, currentWindow: true }, (fallback) => {
        void chrome.runtime.lastError;
        resolve((fallback && fallback[0]) || null);
      });
    });
  });
}

(async () => {
  const tab = await findHostTab();
  if (!tab || !tab.id) {
    document.body.classList.add('unsupported-page');
    return;
  }
  activeTabId = tab.id;

  const state = await send({ type: 'GET_STATE' });
  if (!state) return;

  sliders.reverb.set(state.reverb);
  sliders.bass.set(state.bass);
  sliders.clarity.set(state.clarity);
  setVolumeUI(state.volume);
  const p = state.presets || {};
  presetState.lofi = !!p.lofi;
  presetState.eightd = !!p.eightd;
  presetState.vocal = !!p.vocal;
  renderPresets();
  setEnabledUI(state.enabled !== false);

  startLevelPolling();
})();
