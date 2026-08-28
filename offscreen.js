// ---------------------------------------------------------------------
// Advanced Audio Enhancer — offscreen audio engine
//
// Audio arrives here as a TAB CAPTURE stream rather than from a media
// element. That is the whole point of this architecture:
// createMediaElementSource() is blocked by Chrome for DRM-protected
// (Widevine) and cross-origin media, but tab capture takes the tab's
// mixed audio OUTPUT, so it works on Hotstar, Netflix, Prime, YouTube,
// Spotify and ordinary <audio>/<video> alike.
//
// Signal chain (per captured tab):
//
//   tab capture stream
//        |
//   volumeGain                    <- master volume (0.2x - 3x)
//        |
//   [ MID/SIDE STAGE ]            <- Vocal Boost: attenuates "side"
//        |                           (stereo) content so centre-panned
//        |                           vocals come forward
//   lowShelf -> presence -> vocalPeak -> highShelf -> lofiFilter
//        |
//   stereoPanner                  <- 8D Pan LFO
//        |
//        +---> dryGain ----------------------+--> destination
//        |                                   |
//        +---> convolver --> wetGain --------+
// ---------------------------------------------------------------------

const engines = new Map(); // tabId -> engine

let reverbBuffer = null;
let reverbPromise = null;

function loadReverb(ctx) {
  if (reverbBuffer) return Promise.resolve(reverbBuffer);
  if (!reverbPromise) {
    reverbPromise = fetch(chrome.runtime.getURL('reverb.wav'))
      .then((r) => r.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => { reverbBuffer = decoded; return decoded; })
      .catch(() => null);
  }
  return reverbPromise;
}

function buildGraph(ctx, sourceNode) {
  const volumeGain = ctx.createGain();

  // --- Mid/Side stage ---
  // mid = (L+R) keeps centre content (usually lead vocals)
  // side = (L-R) is stereo-only content (usually backing music)
  const splitter = ctx.createChannelSplitter(2);
  const midSum = ctx.createGain();
  const sideSum = ctx.createGain();
  const sideGain = ctx.createGain();
  const sideNeg = ctx.createGain();
  const midToL = ctx.createGain();
  const midToR = ctx.createGain();
  const sideToL = ctx.createGain();
  const sideToR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const lPos = ctx.createGain();
  const rPos = ctx.createGain();
  const lPos2 = ctx.createGain();
  const rNeg = ctx.createGain();

  lPos.gain.value = 1;
  rPos.gain.value = 1;
  lPos2.gain.value = 1;
  rNeg.gain.value = -1;
  sideNeg.gain.value = -1;
  sideGain.gain.value = 1;
  midToL.gain.value = 0.5;
  midToR.gain.value = 0.5;
  sideToL.gain.value = 0.5;
  sideToR.gain.value = 0.5;

  sourceNode.connect(volumeGain);
  volumeGain.connect(splitter);
  splitter.connect(lPos, 0);
  splitter.connect(rPos, 1);
  lPos.connect(midSum);
  rPos.connect(midSum);
  splitter.connect(lPos2, 0);
  splitter.connect(rNeg, 1);
  lPos2.connect(sideSum);
  rNeg.connect(sideSum);
  sideSum.connect(sideGain);
  sideGain.connect(sideNeg);
  midSum.connect(midToL);
  midSum.connect(midToR);
  sideGain.connect(sideToL);
  sideNeg.connect(sideToR);
  midToL.connect(merger, 0, 0);
  sideToL.connect(merger, 0, 0);
  midToR.connect(merger, 0, 1);
  sideToR.connect(merger, 0, 1);

  // --- Tone / effects stage ---
  const lowShelf = ctx.createBiquadFilter();
  const presence = ctx.createBiquadFilter();
  const vocalPeak = ctx.createBiquadFilter();
  const highShelf = ctx.createBiquadFilter();
  const lofiFilter = ctx.createBiquadFilter();
  const stereoPanner = ctx.createStereoPanner();
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const convolver = ctx.createConvolver();

  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = 150;
  lowShelf.gain.value = 0;

  presence.type = 'peaking';
  presence.frequency.value = 2800;
  presence.Q.value = 1;
  presence.gain.value = 0;

  vocalPeak.type = 'peaking';
  vocalPeak.frequency.value = 1600;
  vocalPeak.Q.value = 0.9;
  vocalPeak.gain.value = 0;

  highShelf.type = 'highshelf';
  highShelf.frequency.value = 4500;
  highShelf.gain.value = 0;

  lofiFilter.type = 'lowpass';
  lofiFilter.frequency.value = 20000;
  lofiFilter.Q.value = 0.7;

  stereoPanner.pan.value = 0;
  dryGain.gain.value = 1;
  wetGain.gain.value = 0;

  merger.connect(lowShelf);
  lowShelf.connect(presence);
  presence.connect(vocalPeak);
  vocalPeak.connect(highShelf);
  highShelf.connect(lofiFilter);
  lofiFilter.connect(stereoPanner);
  stereoPanner.connect(dryGain);
  convolver.connect(wetGain);
  dryGain.connect(ctx.destination);
  wetGain.connect(ctx.destination);
  // stereoPanner -> convolver is attached lazily by setReverbActive().

  const panLFO = ctx.createOscillator();
  const panDepth = ctx.createGain();
  panLFO.type = 'sine';
  panLFO.frequency.value = 0.125; // ~8 second rotation
  panDepth.gain.value = 0;
  panLFO.connect(panDepth);
  panDepth.connect(stereoPanner.pan);
  // Started lazily by setPanActive() — 8D Pan is off by default.

  // Taps the processed signal so the popup can animate its meters to
  // what is actually being heard.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 128;              // plenty for an RMS level read
  analyser.smoothingTimeConstant = 0.7;
  stereoPanner.connect(analyser);
  // Allocated once; the level poll reuses it instead of churning garbage.
  const levelBuffer = new Uint8Array(analyser.fftSize);

  loadReverb(ctx).then((buf) => { if (buf) convolver.buffer = buf; });

  return {
    volumeGain, lowShelf, presence, vocalPeak, highShelf, lofiFilter,
    stereoPanner, panDepth, sideGain, dryGain, wetGain, convolver, panLFO,
    analyser, levelBuffer,
    reverbActive: false,   // is stereoPanner -> convolver wired up?
    panStarted: false,     // has the LFO been started?
  };
}

// A ConvolverNode processes every audio block whether or not anything is
// listening, so keep it out of the graph entirely while reverb is at zero.
function engineStillWants(nodes) {
  return (nodes.wantedWet || 0) > 0.001;
}

function setReverbActive(nodes, active) {
  if (active === nodes.reverbActive) return;
  nodes.reverbActive = active;
  if (active) {
    nodes.stereoPanner.connect(nodes.convolver);
  } else {
    try { nodes.stereoPanner.disconnect(nodes.convolver); } catch (err) {}
  }
}

// The pan LFO is an oscillator that would otherwise run for the whole
// session to drive a feature that is off by default.
function setPanActive(nodes, active) {
  if (active && !nodes.panStarted) {
    nodes.panStarted = true;
    try { nodes.panLFO.start(); } catch (err) {}
  }
}

function rampParam(ctx, param, target) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(target, t + 0.08);
}

function applySettings(engine, settings) {
  const { ctx, nodes } = engine;
  const {
    lowShelf, presence, vocalPeak, highShelf, lofiFilter,
    panDepth, sideGain, dryGain, wetGain, volumeGain,
  } = nodes;

  const enabled = settings.enabled !== false;

  if (!enabled) {
    setReverbActive(nodes, false);
    rampParam(ctx, lowShelf.gain, 0);
    rampParam(ctx, presence.gain, 0);
    rampParam(ctx, vocalPeak.gain, 0);
    rampParam(ctx, highShelf.gain, 0);
    rampParam(ctx, lofiFilter.frequency, 20000);
    rampParam(ctx, panDepth.gain, 0);
    rampParam(ctx, sideGain.gain, 1);
    rampParam(ctx, dryGain.gain, 1);
    rampParam(ctx, wetGain.gain, 0);
    rampParam(ctx, volumeGain.gain, 1);
    return;
  }

  const reverb = settings.reverb || 0;
  const bass = settings.bass || 0;
  const clarity = settings.clarity || 0;
  const presets = settings.presets || {};
  const { lofi, eightd, vocal } = presets;

  let low = bass * 12 + clarity * -6;
  let mid = reverb * 2 + bass * -1.5 + clarity * 9;
  let high = reverb * 5 + clarity * 8;
  let dry = 1 - reverb * 0.35;
  let wet = reverb * 0.55;
  let lofiCutoff = 20000;

  if (lofi) {
    wet += 0.5;
    dry -= 0.2;
    low += 4;
    high -= 6;
    lofiCutoff = 2600;
  }

  let side = 1;
  if (vocal) {
    side = 0.3;
    mid += 6;
    low -= 3;
  }

  const wantsReverb = wet > 0.001;
  // Connect before ramping up so the tail is there; disconnect after ramping
  // down so we never cut a decaying tail off abruptly.
  if (wantsReverb) setReverbActive(nodes, true);
  else setTimeout(() => { if (engineStillWants(nodes) === false) setReverbActive(nodes, false); }, 120);

  setPanActive(nodes, !!eightd);

  rampParam(ctx, vocalPeak.gain, vocal ? 5 : 0);
  rampParam(ctx, panDepth.gain, eightd ? 0.85 : 0);
  rampParam(ctx, lowShelf.gain, low);
  rampParam(ctx, presence.gain, mid);
  rampParam(ctx, highShelf.gain, high);
  rampParam(ctx, lofiFilter.frequency, lofiCutoff);
  rampParam(ctx, sideGain.gain, side);
  rampParam(ctx, dryGain.gain, Math.max(0.15, dry));
  rampParam(ctx, wetGain.gain, Math.min(1.1, wet));
  nodes.wantedWet = wet;
  rampParam(ctx, volumeGain.gain, typeof settings.volume === 'number' ? settings.volume : 1);
}

async function startCapture(tabId, streamId, settings) {
  if (engines.has(tabId)) {
    applySettings(engines.get(tabId), settings);
    return { ok: true, alreadyRunning: true };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // 'playback' asks for the largest buffer the platform allows, which cuts
  // process-callback wakeups dramatically. We are enhancing playback, not
  // doing live monitoring, so the extra latency is irrelevant.
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const source = ctx.createMediaStreamSource(stream);
  const nodes = buildGraph(ctx, source);
  const engine = { ctx, nodes, stream };
  engines.set(tabId, engine);

  applySettings(engine, settings);

  // If the tab stops producing audio (navigation, close), clean up.
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => stopCapture(tabId));
  });

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  return { ok: true };
}

function stopCapture(tabId) {
  const engine = engines.get(tabId);
  if (!engine) return { ok: true };
  try { engine.stream.getTracks().forEach((t) => t.stop()); } catch (err) {}
  if (engine.nodes.panStarted) { try { engine.nodes.panLFO.stop(); } catch (err) {} }
  try { engine.ctx.close(); } catch (err) {}
  engines.delete(tabId);
  return { ok: true, remaining: engines.size };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  if (message.type === 'START_CAPTURE') {
    startCapture(message.tabId, message.streamId, message.settings)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    const engine = engines.get(message.tabId);
    if (engine) applySettings(engine, message.settings);
    sendResponse({ ok: true, active: !!engine });
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    sendResponse(stopCapture(message.tabId));
    return true;
  }

  if (message.type === 'GET_LEVEL') {
    const engine = engines.get(message.tabId);
    if (!engine || !engine.nodes.analyser) {
      sendResponse({ level: 0, active: false });
      return true;
    }
    const analyser = engine.nodes.analyser;
    const data = engine.nodes.levelBuffer; // preallocated; no per-poll garbage
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    sendResponse({ level: Math.sqrt(sum / data.length), active: true });
    return true;
  }

  if (message.type === 'IS_ACTIVE') {
    sendResponse({ active: engines.has(message.tabId) });
    return true;
  }

  return false;
});
