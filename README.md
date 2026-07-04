# Meeting Cost Meter

A Chrome extension that shows the live running cost of your Google Meet, Zoom,
and Microsoft Teams meetings as a floating overlay — attendee count × hourly
rate × time, ticking in real time like an old-school taxi meter.

The point isn't a dashboard stat you'll ignore. The point is that the number
is right there, glowing, going up.

![Icon](icons/icon128.png)

---

## What it does

- **Auto-detects live calls** on Google Meet, Zoom (any `*.zoom.us` subdomain),
  Microsoft Teams (`teams.microsoft.com` and `teams.live.com`) by looking for
  the "Leave call" button.
- **Injects a draggable overlay** into the page via **shadow DOM**, so the
  host page's styles can't leak in or break it. Shows:
  - Live cost in a warm amber LED-style readout
  - Elapsed duration
  - Cost-per-second burn rate
  - Attendee count with a `+ / −` stepper (auto-detected, or manual override)
  - Pause / Reset / End / Minimize controls
- **Toolbar badge** shows a compact live cost (e.g. `$1.2k`) per tab while a
  session is running; shows a pause icon `⏸` when paused.
- **Configurable cost thresholds** (default `$50 / $100 / $250 / $500`) — the
  overlay flashes red when a threshold is crossed, and (optionally) a native
  Chrome notification fires.
- **Popup** shows the current tab's session with full controls, a list of
  meetings running in other tabs (click to jump to them), and a scrollable
  recent history with **Export CSV** and **Clear** actions.
- **Options page** for default hourly rate, default currency, per-platform
  enable / auto-detect toggles, threshold list, notifications, and theme.
- **Currencies:** USD, EUR, GBP, INR, PKR (default), AUD, CAD, AED, JPY.
- **Session persistence:** state is written to `chrome.storage.local` every
  ~5 seconds, so nothing is lost when the MV3 service worker sleeps.
- **Abrupt tab close is caught** via `chrome.tabs.onRemoved` in the service
  worker and archived to history with an "ended abruptly" marker.

---

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the folder containing this README (the folder with `manifest.json`
   in it).
5. Pin the extension to your toolbar (puzzle-piece icon → pin).
6. Open a Google Meet / Zoom / Teams tab, join a call — the overlay should
   appear within a couple of seconds. Click the toolbar icon to open the
   popup, or right-click it → **Options** for settings.

To update after code changes: go to `chrome://extensions` and hit the reload
button on the Meeting Cost Meter card.

---

## File layout

```
manifest.json
background.js               MV3 service worker — state, badge, notifications, tab-close cleanup
content/content.js          in-call detection, shadow-DOM overlay, tick loop, drag, persistence
popup/popup.html            popup UI
popup/popup.css
popup/popup.js
options/options.html        settings UI
options/options.css
options/options.js
shared/constants.js         platform configs, currency list, default settings, message types
shared/format.js            money / duration / compact-number / CSV helpers
icons/icon16.png            toolbar / management icons
icons/icon32.png
icons/icon48.png
icons/icon128.png
```

Every extension surface (background, content, popup, options) uses the same
`shared/*.js` modules via classic script loading — no bundler, no npm.

---

## Design notes

- **Manifest V3.** Service worker instead of persistent background page.
- **Vanilla JS/HTML/CSS only.** No React, no build step, no npm dependencies.
- **Offline-safe.** No remote fonts, no CDN, no telemetry. The overlay and
  popup fall back through a system font stack (`JetBrains Mono / Cascadia
  Code / SF Mono / Consolas / monospace` for numbers; `Space Grotesk /
  Avenir Next / Segoe UI / system-ui` for labels).
- **Minimal permissions.** Only `storage` and `notifications` — no `tabs`,
  no `activeTab`, no `scripting`. Cross-tab visibility relies on
  `host_permissions` for the three meeting sites, which is enough for
  `chrome.tabs.onRemoved` and for listing our own content-script tabs
  in the popup.
- **Shadow DOM overlay.** All overlay CSS is scoped inside a closed shadow
  root, so Meet/Zoom/Teams style rules can't touch it.
- **Safe DOM handling.** Every query into the host meeting page is wrapped
  in `try / catch` — if a selector breaks after a UI update from Google or
  Zoom, the extension keeps working, it just falls back to the manual
  attendee count. `innerHTML` is never used with dynamically-sourced
  strings; all live values go through `textContent`.

---

## Known limitations

- **Selectors are best-effort.** Google, Zoom, and Microsoft change the
  DOM of their meeting pages without notice. The `inCallSelectors` and
  `participantExtractors` in `shared/constants.js` are the fragile
  bit — if the overlay stops appearing or the attendee count stops
  auto-updating, the fix is usually to add a new selector there.
  Everything is wrapped in `try / catch` so a broken selector degrades
  gracefully rather than crashing the extension.
- **Attendee auto-detect is heuristic.** When it guesses wrong, use the
  overlay's `+ / −` stepper to override; that disables auto-detect for the
  rest of the session so it can't fight you.
- **Cost is a rough model** — one flat hourly rate × attendee count. It
  doesn't know about seniority, benefits, overhead multipliers, or that
  half the room is only half-listening. Set your rate to whatever you want
  the meter to show; the meter's job is to make the number visible, not to
  be an authoritative payroll calculation.
- **The service worker sleeps.** During sleep, the overlay's own tick loop
  keeps the on-page display live; the toolbar badge is refreshed by a
  `chrome.alarms` heartbeat (~30s cadence), so it can lag by a few seconds.
- **Zoom's web client can be inconsistent.** Zoom nudges users toward the
  desktop app; when the browser client falls back to a limited mode the
  in-call selectors may not match. If nothing appears, check `chrome://
  extensions` → *service worker* → *inspect* for warnings.
- **Only current-window tab-switching from the popup.** The "other running
  meetings" list can focus tabs across windows, but only tabs the extension
  can already see under its host permissions.
- **History is capped at 200 entries** locally in `chrome.storage.local`.
  Older entries are dropped. Export the CSV if you want long-term records.

---

## Development tips

- Reload after edits: `chrome://extensions` → reload button on the card,
  then refresh the meeting tab so a fresh content script loads.
- Inspect the service worker: `chrome://extensions` → click "service
  worker" under the extension card.
- Inspect the overlay: right-click the page → **Inspect**. The overlay
  is inside a closed shadow root attached to `#__mcm_overlay_root__` on
  `document.documentElement`. Since it's a *closed* shadow root, DevTools
  will show the host element but not its innards — flip the root open
  in `content/content.js` (search for `mode: 'closed'` and change to
  `'open'`) if you need to poke at the internals.

---

## License

MIT — do whatever you want with it. If you make it better, a PR is welcome.
