<div align="center">

<img src="./icons/icon128.png" width="96" height="96" alt="Advance Audio Enhancer logo" />

# Advance Audio Enhancer

**Real-time reverb, bass, clarity and volume boost — for any audio or video on the web.**

Works on DRM-protected streams (YouTube, Spotify Web Player, Netflix, Prime Video) that block most other audio extensions, and keeps working through autoplay.

[Features](#features) · [Screenshots](#screenshots) · [Install](#installation) · [How it works](#how-it-works) · [Permissions](#permissions--privacy) · [Development](#development)

**[Get it on the Microsoft Edge Add-ons store →](https://microsoftedge.microsoft.com/addons/detail/advance-audio-enhancer/mngojgokofkpnoimgpnkhkdbiaimbpdn)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

---

## Features

- **Three independent controls** — Reverb, Bass, and Clarity, each on its own slider, blended exactly to your taste
- **Volume boost up to 300%** — push past a site's native volume ceiling
- **Quick presets** — LoFi Feeling, 8D Pan, and Vocal Boost, applied on top of your manual settings without ever overwriting them
- **Works everywhere, including DRM content** — built on tab audio capture rather than the page's media elements, so it works uniformly across Widevine-protected streaming sites where `createMediaElementSource()` is blocked
- **Survives autoplay** — when a site swaps videos in the same tab (e.g. YouTube's autoplay), your settings automatically reapply instead of silently dropping
- **A real floating panel, not a popup** — opens instantly with genuine rounded corners and a soft drop shadow, dismisses when you click elsewhere on the page, and never takes over the tab
- **Fast and quiet on resources** — the reverb convolver and the 8D pan oscillator are only wired into the audio graph while they're actually in use; the panel stops polling entirely the moment it's closed or the tab is backgrounded
- **Private by design** — all audio processing happens locally via the Web Audio API. Nothing is ever collected or transmitted

## Screenshots

![Advance Audio Enhancer panel open over a video site](https://i.postimg.cc/kXFkPJhW/01-youtube-context.png)

### Optimized to stay light

All three sliders raised, a preset active, at once — Task Manager shows CPU sitting in normal single-digit-to-twenties range for the system overall, no sustained spike attributable to the extension:

![Task Manager CPU graph with every slider and a preset active at once](https://i.postimg.cc/XqvyN7kp/Screenshot-2026-08-28-043321.png)

This isn't incidental — see [the performance-sensitive design decisions below](#the-audio-graph) for what specifically keeps it light: the reverb convolver and the 8D pan oscillator are only wired into the audio graph while actually in use, slider drags are coalesced instead of sent per-event, and the panel's animation poll stops entirely once it's closed or the tab is backgrounded.

## Installation

**Microsoft Edge:** install it directly from the [Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/advance-audio-enhancer/mngojgokofkpnoimgpnkhkdbiaimbpdn) — no setup required.

**Chrome, or building from source:**

1. Download or clone this repository
2. Open `chrome://extensions` (or `edge://extensions` on Edge)
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Click the extension icon on any page with audio or video to open the panel

If you reload the extension while a tab is already open, refresh that tab once — a freshly loaded extension can't reach tabs that were open before it existed.

## How it works

### Architecture

```
┌──────────────┐     click icon      ┌────────────────┐
│   sw.js      │ ───────────────────▶│  panel-host.js │  (content script,
│ (service     │                      │                │   injected on every
│  worker)     │                      └────────┬───────┘   page)
└──────┬───────┘                               │
       │ manages capture                       │ injects a transparent,
       │ per tab                               │ rounded <iframe>
       ▼                                        ▼
┌──────────────┐   tabCapture stream   ┌────────────────┐
│ background.js│ ─────────────────────▶│ offscreen.js   │
│ (capture +   │                       │ (Web Audio      │
│  settings)   │◀───────────────────── │  processing     │
└──────────────┘   settings updates    │  graph)         │
                                        └────────────────┘
                                                ▲
                                                │ renders inside the iframe
                                        ┌────────────────┐
                                        │  panel.html /   │
                                        │  panel.js       │
                                        │  (the UI)       │
                                        └────────────────┘
```

**Why an injected panel instead of a browser-action popup?** Chrome draws a popup's window frame itself — it's opaque and square, and extension CSS cannot round it ([crbug.com/40852436](https://issues.chromium.org/issues/40852436)). Panel.html is instead injected into the page as a transparent iframe inside a closed Shadow DOM, so it can have real rounded corners, a real drop shadow, and sit above page content without being clipped to a rectangle. It dismisses when you click elsewhere on the page, and Escape always closes it.

**Why `tabCapture` instead of `createMediaElementSource()`?** The standard approach of attaching a `MediaElementSourceNode` directly to a `<video>` or `<audio>` element is permanently blocked on Widevine-protected content and on cross-origin media without CORS headers. Capturing the tab's audio output stream and routing *that* through the Web Audio graph works uniformly regardless of DRM or origin.

**Why an offscreen document?** A Manifest V3 service worker has no access to `AudioContext` or the Web Audio API. The offscreen document exists solely to host the actual processing graph (filters, convolver, gain nodes) that the tab-capture stream is routed through.

### The audio graph

```
source → bass (lowshelf) → clarity (highshelf) → lowpass
       → [ dry + wet(convolver reverb) ] → stereo panner → gain → destination
```

- **Reverb** uses a `ConvolverNode` fed a synthetic decaying-noise impulse response
- **Bass** is a lowshelf filter at 200 Hz
- **Clarity** is a highshelf filter at 3.2 kHz for presence
- **8D Pan** drives the `StereoPannerNode` with a slow sine LFO
- **LoFi** additionally stamps `playbackRate` on the underlying media element (tab capture can't affect this directly, so a small content-script injection handles it — only when the LoFi state actually changes, not on every slider tick)

**Performance-sensitive design decisions:**
- The convolver and the pan LFO are only connected into the graph while their effect is actually in use (reverb > 0%, or 8D Pan active) — not for every tab, all the time
- The `AudioContext` uses `latencyHint: 'playback'` to request the largest buffer the platform allows, cutting process-callback wakeups
- Slider drags are coalesced onto one message per animation frame instead of one per input event
- The panel's level-meter poll (used only for its decorative animation) pauses entirely when the panel is closed, the tab is backgrounded, or the window is hidden

### Manual sliders vs. presets

These are two independent layers, enforced in the audio engine itself rather than just in the UI:

- Sliders write only to a `manual` settings object
- A preset sets only which preset is active — it never touches the slider values
- The two are combined only at the point the settings are applied to the audio graph
- Clicking an active preset again, or "Clear All", drops back to the manual layer untouched

## Permissions & privacy

| Permission | Why it's needed |
|---|---|
| `activeTab` | Identify the current tab so settings apply to the right tab's playback |
| `scripting` | Inject the panel UI into the page, and sync playback rate for the LoFi preset |
| `tabs` | Detect navigation/tab closure so effects can be reapplied or cleaned up |
| `storage` | Save your effect settings locally via `chrome.storage.local` |
| `tabCapture` | Capture a tab's audio output so it can be routed through the effects chain — the only approach that works on DRM-protected and cross-origin media |
| `offscreen` | Host the Web Audio processing graph, which a service worker cannot run directly |
| `host_permissions: *://*/*` | The extension's purpose — audio enhancement — needs to work on any site, since audio isn't limited to a fixed set of domains |

**No data is collected, stored remotely, or transmitted anywhere.** All audio processing happens locally in your browser. The only thing saved is your own effect settings, kept on-device in `chrome.storage.local`.

## Known limitations

- Cross-origin media without CORS headers cannot be routed through Web Audio; the extension detects this and leaves that element playing untouched rather than muting it
- Pages that don't allow content scripts (`chrome://`, the Web Store, the built-in PDF viewer) can't host the panel
- The first `AudioContext` on a tab may start suspended until you interact with the page, per browser autoplay policy; it resumes automatically on the next control change

## Development

No build step — everything is vanilla HTML/CSS/JS, loaded directly by Chrome.

```
.
├── manifest.json        # MV3 config
├── sw.js                # background.js entry point (service worker)
├── background.js         # tab-capture lifecycle + per-tab settings
├── offscreen.html/.js   # the actual Web Audio processing graph
├── panel-host.js         # content script: injects the panel iframe
├── panel.html / panel.js # the UI
├── reverb.wav            # fallback impulse response
├── fonts/                 # bundled Poppins + Gilda Display (no network fetch)
└── icons/
```

To make changes: edit the relevant file, then hit the reload icon for the extension on `chrome://extensions` and refresh any test tab.

Pull requests are welcome — for anything beyond a small fix, opening an issue first to discuss the approach is appreciated.

## License

MIT — see [LICENSE](./LICENSE) for details. Contributions are welcome: open an issue or a pull request.
