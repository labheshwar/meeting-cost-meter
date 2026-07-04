/* Meeting Cost Meter — content script
 *
 * Runs on meet.google.com / *.zoom.us / teams.microsoft.com / teams.live.com.
 * Detects when the user is inside a live call, injects a shadow-DOM overlay,
 * and drives a local per-second tick loop. Persists authoritative session
 * state to the background service worker every ~5 seconds.
 *
 * Every DOM query into the host page is wrapped in try/catch — Meet / Zoom /
 * Teams change their markup often, and a broken selector must never take
 * the overlay down.
 */
(function () {
  'use strict';

  if (!self.MCM) return;
  if (window.__mcmContentInjected) return;
  window.__mcmContentInjected = true;

  const { MESSAGES, PLATFORMS, CONFIG } = self.MCM;

  const platformId = self.MCM.detectPlatformFromHost(location.hostname);
  if (!platformId) return;
  const platform = PLATFORMS[platformId];

  const state = {
    settings: null,
    inCall: false,
    lastInCallSeen: 0,
    session: null,        // active local session or null
    overlayHost: null,
    overlayEls: null,
    overlayPosition: null,
    minimized: false,
    tickTimer: null,
    pollTimer: null,
    persistTimer: null,
    manualAttendeeOverride: false,
    lastPlatformScanAt: 0,
    // After a manual end, we require the in-call indicator to disappear
    // at least once before we're allowed to start a new session — that
    // prevents "End" from just being an expensive Reset.
    suppressUntilInCallFalse: false
  };

  const OVERLAY_HOST_ID = '__mcm_overlay_root__';

  /* ==================== safe DOM helpers ==================== */

  function safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function queryHostDoc(selector) {
    return safe(() => document.querySelector(selector), null);
  }

  /* ==================== settings ==================== */

  async function fetchSettings() {
    const resp = await sendBg({ type: MESSAGES.GET_SETTINGS });
    if (resp && resp.ok && resp.data && resp.data.settings) {
      state.settings = resp.data.settings;
    } else {
      state.settings = JSON.parse(JSON.stringify(self.MCM.DEFAULT_SETTINGS));
    }
  }

  function isPlatformEnabled() {
    if (!state.settings) return true;
    const p = state.settings.platforms && state.settings.platforms[platformId];
    return !p || p.enabled !== false;
  }

  function autoDetectEnabled() {
    if (state.manualAttendeeOverride) return false;
    if (!state.settings) return true;
    const p = state.settings.platforms && state.settings.platforms[platformId];
    return !p || p.autoDetectAttendees !== false;
  }

  /* ==================== messaging ==================== */

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (!msg || !msg.type) return sendResponse({ ok: false });
      try {
        if (msg.type === MESSAGES.SETTINGS_UPDATED && msg.settings) {
          state.settings = msg.settings;
          renderOverlay();
          sendResponse({ ok: true });
        } else if (msg.type === MESSAGES.CONTROL_SESSION) {
          handleControl(msg);
          sendResponse({ ok: true });
        } else if (msg.type === MESSAGES.GET_TAB_SESSION) {
          sendResponse({ ok: true, data: { session: snapshotSession() } });
        } else {
          sendResponse({ ok: false });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  function handleControl(msg) {
    if (!state.session) return;
    switch (msg.action) {
      case 'pause': pauseSession(); break;
      case 'resume': resumeSession(); break;
      case 'reset': resetSession(); break;
      case 'end': endSession('manual'); break;
      case 'setAttendees':
        if (typeof msg.value === 'number') setAttendees(msg.value, true);
        break;
      case 'setRate':
        if (typeof msg.value === 'number') setRate(msg.value);
        break;
      case 'setCurrency':
        if (typeof msg.value === 'string') setCurrency(msg.value);
        break;
    }
  }

  /* ==================== in-call detection ==================== */

  function detectInCall() {
    for (const sel of platform.inCallSelectors) {
      const el = safe(() => document.querySelector(sel), null);
      if (el && isVisible(el)) {
        state.__matchedSelector = sel;
        return true;
      }
    }
    state.__matchedSelector = null;
    return false;
  }

  function isVisible(el) {
    return safe(() => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (!style) return true;
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    }, true);
  }

  function detectAttendeeCount() {
    for (const ext of platform.participantExtractors) {
      const el = safe(() => document.querySelector(ext.selector), null);
      if (!el) continue;
      const n = safe(() => ext.extract(el), NaN);
      if (Number.isFinite(n) && n > 0 && n < CONFIG.MAX_ATTENDEES) return n;
    }
    return null;
  }

  /* ==================== session ==================== */

  function startSession() {
    const now = Date.now();
    state.session = {
      startTime: now,
      currentStartTime: now,
      totalElapsedMs: 0,
      paused: false,
      attendees: 1,
      rate: state.settings.hourlyRate,
      currency: state.settings.currency,
      autoAttendees: autoDetectEnabled(),
      thresholdsFired: []
    };
    state.manualAttendeeOverride = false;
    // Immediately try to auto-detect
    if (state.session.autoAttendees) {
      const detected = detectAttendeeCount();
      if (detected) state.session.attendees = detected;
    }
    injectOverlay();
    scheduleTick();
    schedulePersist();
    persistSession();
  }

  function pauseSession() {
    if (!state.session || state.session.paused) return;
    const now = Date.now();
    state.session.totalElapsedMs += now - (state.session.currentStartTime || now);
    state.session.currentStartTime = null;
    state.session.paused = true;
    renderOverlay();
    persistSession();
  }

  function resumeSession() {
    if (!state.session || !state.session.paused) return;
    state.session.paused = false;
    state.session.currentStartTime = Date.now();
    renderOverlay();
    persistSession();
  }

  function resetSession() {
    if (!state.session) return;
    const now = Date.now();
    state.session.startTime = now;
    state.session.currentStartTime = state.session.paused ? null : now;
    state.session.totalElapsedMs = 0;
    state.session.thresholdsFired = [];
    renderOverlay();
    persistSession();
  }

  function setAttendees(n, isManual) {
    if (!state.session) return;
    const clamped = Math.max(CONFIG.MIN_ATTENDEES, Math.min(CONFIG.MAX_ATTENDEES, Math.floor(n)));
    state.session.attendees = clamped;
    if (isManual) {
      state.manualAttendeeOverride = true;
      state.session.autoAttendees = false;
    }
    renderOverlay();
    persistSession();
  }

  function setRate(n) {
    if (!state.session) return;
    const clamped = Math.max(CONFIG.MIN_HOURLY_RATE, Math.min(CONFIG.MAX_HOURLY_RATE, n));
    state.session.rate = clamped;
    renderOverlay();
    persistSession();
  }

  function setCurrency(code) {
    if (!state.session) return;
    if (!self.MCM.CURRENCIES[code]) return;
    state.session.currency = code;
    renderOverlay();
    persistSession();
  }

  async function endSession(reason) {
    if (!state.session) return;
    stopTick();
    stopPersist();
    const finalReason = reason || 'manual';
    await sendBg({ type: MESSAGES.SESSION_END, reason: finalReason });
    state.session = null;
    removeOverlay();
    if (finalReason === 'manual') {
      state.suppressUntilInCallFalse = true;
    }
  }

  function snapshotSession() {
    if (!state.session) return null;
    return {
      startTime: state.session.startTime,
      currentStartTime: state.session.currentStartTime,
      totalElapsedMs: state.session.totalElapsedMs,
      paused: state.session.paused,
      attendees: state.session.attendees,
      rate: state.session.rate,
      currency: state.session.currency,
      autoAttendees: state.session.autoAttendees,
      platform: platformId
    };
  }

  function persistSession() {
    if (!state.session) return;
    sendBg({
      type: MESSAGES.SESSION_UPDATE,
      payload: {
        platform: platformId,
        startTime: state.session.startTime,
        currentStartTime: state.session.currentStartTime,
        totalElapsedMs: state.session.totalElapsedMs,
        paused: state.session.paused,
        attendees: state.session.attendees,
        rate: state.session.rate,
        currency: state.session.currency,
        autoAttendees: state.session.autoAttendees
      }
    });
  }

  function liveElapsedMs() {
    if (!state.session) return 0;
    if (state.session.paused || !state.session.currentStartTime) return state.session.totalElapsedMs;
    return state.session.totalElapsedMs + (Date.now() - state.session.currentStartTime);
  }

  /* ==================== timers ==================== */

  function scheduleTick() {
    stopTick();
    state.tickTimer = setInterval(() => {
      try {
        // Auto-detect attendee count occasionally while auto is on
        const now = Date.now();
        if (state.session && state.session.autoAttendees &&
            now - state.lastPlatformScanAt > 5000) {
          state.lastPlatformScanAt = now;
          const detected = detectAttendeeCount();
          if (detected && detected !== state.session.attendees) {
            state.session.attendees = detected;
          }
        }
        renderOverlay();
        checkThresholds();
      } catch (e) { /* keep ticking */ }
    }, CONFIG.TICK_INTERVAL_MS);
  }

  function stopTick() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  }

  function schedulePersist() {
    stopPersist();
    state.persistTimer = setInterval(() => {
      try { persistSession(); } catch (_) {}
    }, CONFIG.PERSIST_INTERVAL_MS);
  }

  function stopPersist() {
    if (state.persistTimer) { clearInterval(state.persistTimer); state.persistTimer = null; }
  }

  function schedulePoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollTick, CONFIG.POLL_INTERVAL_MS);
    // Also run once immediately.
    pollTick();
  }

  function pollTick() {
    try {
      if (!isPlatformEnabled()) {
        if (state.session) endSession('platform-disabled');
        return;
      }
      const inCall = detectInCall();
      if (inCall !== state.__lastLoggedInCall) {
        // Log state transitions so users can diagnose from DevTools.
        console.log(
          '[MCM] ' + platformId + ' in-call:',
          inCall,
          inCall ? '(matched: ' + state.__matchedSelector + ')' : ''
        );
        state.__lastLoggedInCall = inCall;
      }
      if (inCall) {
        state.lastInCallSeen = Date.now();
        if (!state.session && !state.suppressUntilInCallFalse) startSession();
      } else {
        // Any moment the in-call indicator is missing lifts the
        // "manually ended, don't restart" suppression.
        state.suppressUntilInCallFalse = false;
        if (state.session) {
          const lost = Date.now() - state.lastInCallSeen;
          if (lost > CONFIG.IN_CALL_LOST_TIMEOUT_MS) {
            endSession('auto');
          }
        }
      }
    } catch (e) { /* poll must never crash */ }
  }

  /* ==================== thresholds ==================== */

  function checkThresholds() {
    if (!state.session || !state.settings) return;
    const cost = self.MCM.computeCost(
      state.session.attendees, state.session.rate, liveElapsedMs()
    );
    const list = state.settings.thresholds || [];
    for (const t of list) {
      if (cost >= t && state.session.thresholdsFired.indexOf(t) === -1) {
        state.session.thresholdsFired.push(t);
        pulseAlert();
        sendBg({ type: MESSAGES.NOTIFY, threshold: t });
      }
    }
  }

  /* ==================== overlay UI (shadow DOM) ==================== */

  const OVERLAY_STYLES = [
    ':host { all: initial; }',
    '.wrap { position: fixed; z-index: 2147483647;',
    '  font-family: "Space Grotesk", "Avenir Next", "Segoe UI", system-ui, sans-serif;',
    '  color: #E6EAEE; user-select: none; }',
    '.wrap * { box-sizing: border-box; }',
    '.mono { font-family: "JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, "Courier New", monospace; }',
    '.card { background: #171D22; border: 1px solid #2A333A; border-radius: 6px;',
    '  padding: 12px 14px; width: 220px; box-shadow: 0 6px 24px rgba(0,0,0,0.45); }',
    '.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;',
    '  cursor: grab; }',
    '.header:active { cursor: grabbing; }',
    '.title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;',
    '  color: #8A97A2; display: flex; align-items: center; gap: 6px; }',
    '.dot { width: 8px; height: 8px; border-radius: 50%; background: #2DD4BF;',
    '  box-shadow: 0 0 6px #2DD4BF; animation: mcm-pulse 2s ease-in-out infinite; }',
    '.dot.paused { background: #8A97A2; box-shadow: none; animation: none; }',
    '@keyframes mcm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }',
    '.hdr-btns { display: flex; gap: 4px; }',
    '.hdr-btn { background: transparent; border: none; color: #8A97A2; cursor: pointer;',
    '  width: 20px; height: 20px; line-height: 1; padding: 0; font-size: 14px; border-radius: 3px; }',
    '.hdr-btn:hover { background: #1F262C; color: #E6EAEE; }',
    '.cost { font-size: 28px; font-weight: 600; color: #FFB020;',
    '  text-shadow: 0 0 8px rgba(255,176,32,0.35); letter-spacing: 0.02em;',
    '  line-height: 1.1; }',
    '.meta { display: flex; justify-content: space-between; font-size: 11px;',
    '  color: #8A97A2; margin-top: 6px; }',
    '.meta .val { color: #E6EAEE; }',
    '.row { display: flex; align-items: center; justify-content: space-between;',
    '  margin-top: 10px; font-size: 12px; color: #8A97A2; }',
    '.stepper { display: flex; align-items: center; gap: 6px; }',
    '.step-btn { background: #1F262C; border: 1px solid #2A333A; color: #E6EAEE;',
    '  width: 22px; height: 22px; border-radius: 3px; cursor: pointer; font-size: 14px;',
    '  line-height: 1; padding: 0; }',
    '.step-btn:hover { background: #2A333A; }',
    '.att-count { min-width: 24px; text-align: center; color: #E6EAEE; font-weight: 500; }',
    '.controls { display: flex; gap: 6px; margin-top: 12px; }',
    '.ctrl { flex: 1; background: #1F262C; border: 1px solid #2A333A; color: #E6EAEE;',
    '  padding: 6px 8px; border-radius: 3px; font-size: 11px; cursor: pointer;',
    '  font-family: inherit; letter-spacing: 0.02em; }',
    '.ctrl:hover { background: #2A333A; }',
    '.ctrl.end { color: #FF5470; }',
    '.ctrl.end:hover { background: rgba(255,84,112,0.1); }',
    '.wrap.alert .card { border-color: #FF5470; }',
    '.wrap.alert .cost { color: #FF5470; text-shadow: 0 0 10px rgba(255,84,112,0.5); }',
    '.wrap.flash .card { animation: mcm-flash 600ms ease-out; }',
    '@keyframes mcm-flash { 0% { box-shadow: 0 0 0 0 rgba(255,84,112,0.6); }',
    '  100% { box-shadow: 0 6px 24px rgba(0,0,0,0.45); } }',
    '.pill { display: flex; align-items: center; gap: 8px; background: #171D22;',
    '  border: 1px solid #2A333A; border-radius: 999px; padding: 6px 12px;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,0.4); cursor: grab; }',
    '.pill:active { cursor: grabbing; }',
    '.pill .cost { font-size: 15px; }',
    '.pill .dot { width: 6px; height: 6px; }',
    '.pill-expand { background: transparent; border: none; color: #8A97A2;',
    '  cursor: pointer; font-size: 12px; padding: 0 0 0 4px; }',
    '.pill-expand:hover { color: #E6EAEE; }'
  ].join('\n');

  async function injectOverlay() {
    if (state.overlayHost) return;
    let host;
    try {
      host = document.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.style.all = 'initial';
      host.style.position = 'fixed';
      host.style.zIndex = '2147483647';
      host.style.top = '0';
      host.style.left = '0';
      host.style.width = '0';
      host.style.height = '0';
      document.documentElement.appendChild(host);
    } catch (e) {
      console.warn('[MCM] Failed to attach overlay host', e);
      return;
    }

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_STYLES;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.style.top = '80px';
    wrap.style.right = '20px';
    shadow.appendChild(wrap);

    state.overlayHost = host;
    state.overlayEls = { shadow, wrap };

    // Restore saved position/minimized state
    try {
      const resp = await sendBg({ type: MESSAGES.GET_OVERLAY_STATE, platform: platformId });
      if (resp && resp.ok && resp.data && resp.data.state) {
        const s = resp.data.state;
        if (s.minimized) state.minimized = true;
        if (s.position && typeof s.position === 'object') {
          state.overlayPosition = s.position;
        }
      }
    } catch (_) {}

    renderOverlay();
  }

  function removeOverlay() {
    if (state.overlayHost && state.overlayHost.parentNode) {
      try { state.overlayHost.parentNode.removeChild(state.overlayHost); } catch (_) {}
    }
    state.overlayHost = null;
    state.overlayEls = null;
  }

  function renderOverlay() {
    if (!state.overlayEls || !state.session) return;
    const { shadow, wrap } = state.overlayEls;

    // Position
    applyPosition(wrap);

    // Determine alert state (currently-crossed but under next threshold)
    const cost = self.MCM.computeCost(
      state.session.attendees, state.session.rate, liveElapsedMs()
    );
    const anyThreshold = (state.settings && state.settings.thresholds || [])
      .some((t) => cost >= t);
    const flashJustFired = state.__pendingFlash;
    wrap.classList.toggle('alert', anyThreshold);
    if (flashJustFired) {
      wrap.classList.add('flash');
      setTimeout(() => { try { wrap.classList.remove('flash'); } catch (_) {} }, 620);
      state.__pendingFlash = false;
    }

    // Clear and rebuild inner content
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

    if (state.minimized) {
      wrap.appendChild(buildPill(cost));
    } else {
      wrap.appendChild(buildCard(cost));
    }
  }

  function buildPill(cost) {
    const pill = document.createElement('div');
    pill.className = 'pill';
    attachDrag(pill);

    const dot = document.createElement('span');
    dot.className = 'dot' + (state.session.paused ? ' paused' : '');
    pill.appendChild(dot);

    const costEl = document.createElement('span');
    costEl.className = 'cost mono';
    costEl.textContent = self.MCM.formatMoney(cost, state.session.currency);
    pill.appendChild(costEl);

    const expandBtn = document.createElement('button');
    expandBtn.className = 'pill-expand';
    expandBtn.title = 'Expand';
    expandBtn.setAttribute('aria-label', 'Expand');
    expandBtn.textContent = '▢';
    expandBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.minimized = false;
      saveOverlayState();
      renderOverlay();
    });
    pill.appendChild(expandBtn);

    return pill;
  }

  function buildCard(cost) {
    const card = document.createElement('div');
    card.className = 'card';

    // Header
    const header = document.createElement('div');
    header.className = 'header';
    attachDrag(header);

    const title = document.createElement('div');
    title.className = 'title';
    const dot = document.createElement('span');
    dot.className = 'dot' + (state.session.paused ? ' paused' : '');
    title.appendChild(dot);
    const titleText = document.createElement('span');
    titleText.textContent = 'MEETING COST';
    title.appendChild(titleText);
    header.appendChild(title);

    const hdrBtns = document.createElement('div');
    hdrBtns.className = 'hdr-btns';
    const minBtn = document.createElement('button');
    minBtn.className = 'hdr-btn';
    minBtn.title = 'Minimize';
    minBtn.setAttribute('aria-label', 'Minimize');
    minBtn.textContent = '—';
    minBtn.addEventListener('click', () => {
      state.minimized = true;
      saveOverlayState();
      renderOverlay();
    });
    hdrBtns.appendChild(minBtn);
    header.appendChild(hdrBtns);
    card.appendChild(header);

    // Cost
    const costEl = document.createElement('div');
    costEl.className = 'cost mono';
    costEl.textContent = self.MCM.formatMoney(cost, state.session.currency);
    card.appendChild(costEl);

    // Meta: duration + rate/sec
    const meta = document.createElement('div');
    meta.className = 'meta';
    const durSpan = document.createElement('span');
    durSpan.appendChild(document.createTextNode('Elapsed '));
    const durVal = document.createElement('span');
    durVal.className = 'val mono';
    durVal.textContent = self.MCM.formatDuration(liveElapsedMs());
    durSpan.appendChild(durVal);
    meta.appendChild(durSpan);

    const rateSpan = document.createElement('span');
    const perSec = self.MCM.costPerSecond(state.session.attendees, state.session.rate);
    const rateVal = document.createElement('span');
    rateVal.className = 'val mono';
    rateVal.textContent = self.MCM.formatMoney(perSec, state.session.currency) + '/s';
    rateSpan.appendChild(rateVal);
    meta.appendChild(rateSpan);
    card.appendChild(meta);

    // Attendees stepper
    const attRow = document.createElement('div');
    attRow.className = 'row';
    const attLabel = document.createElement('span');
    attLabel.textContent = 'Attendees' + (state.session.autoAttendees ? ' (auto)' : '');
    attRow.appendChild(attLabel);

    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    const minusBtn = document.createElement('button');
    minusBtn.className = 'step-btn';
    minusBtn.textContent = '−';
    minusBtn.setAttribute('aria-label', 'Fewer attendees');
    minusBtn.addEventListener('click', () => {
      setAttendees(state.session.attendees - 1, true);
    });
    stepper.appendChild(minusBtn);

    const attCount = document.createElement('span');
    attCount.className = 'att-count mono';
    attCount.textContent = String(state.session.attendees);
    stepper.appendChild(attCount);

    const plusBtn = document.createElement('button');
    plusBtn.className = 'step-btn';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'More attendees');
    plusBtn.addEventListener('click', () => {
      setAttendees(state.session.attendees + 1, true);
    });
    stepper.appendChild(plusBtn);
    attRow.appendChild(stepper);
    card.appendChild(attRow);

    // Rate row
    const rateRow = document.createElement('div');
    rateRow.className = 'row';
    const rateLabel = document.createElement('span');
    rateLabel.textContent = 'Rate/hr';
    rateRow.appendChild(rateLabel);
    const rateReadout = document.createElement('span');
    rateReadout.className = 'mono';
    rateReadout.style.color = '#E6EAEE';
    rateReadout.textContent = self.MCM.formatMoney(state.session.rate, state.session.currency);
    rateRow.appendChild(rateReadout);
    card.appendChild(rateRow);

    // Controls
    const controls = document.createElement('div');
    controls.className = 'controls';

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'ctrl';
    pauseBtn.textContent = state.session.paused ? 'Resume' : 'Pause';
    pauseBtn.addEventListener('click', () => {
      if (state.session.paused) resumeSession(); else pauseSession();
    });
    controls.appendChild(pauseBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'ctrl';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', resetSession);
    controls.appendChild(resetBtn);

    const endBtn = document.createElement('button');
    endBtn.className = 'ctrl end';
    endBtn.textContent = 'End';
    endBtn.addEventListener('click', () => endSession('manual'));
    controls.appendChild(endBtn);

    card.appendChild(controls);
    return card;
  }

  function pulseAlert() {
    state.__pendingFlash = true;
    renderOverlay();
  }

  /* ==================== drag ==================== */

  function attachDrag(handle) {
    if (!handle || !state.overlayEls) return;
    const wrap = state.overlayEls.wrap;
    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handle.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = wrap.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      ev.preventDefault();
    });

    document.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const nx = Math.max(0, Math.min(window.innerWidth - 40, startLeft + dx));
      const ny = Math.max(0, Math.min(window.innerHeight - 40, startTop + dy));
      wrap.style.left = nx + 'px';
      wrap.style.top = ny + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = wrap.getBoundingClientRect();
      state.overlayPosition = { left: rect.left, top: rect.top };
      saveOverlayState();
    });
  }

  function applyPosition(wrap) {
    if (state.overlayPosition && typeof state.overlayPosition.left === 'number') {
      wrap.style.left = state.overlayPosition.left + 'px';
      wrap.style.top = state.overlayPosition.top + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    } else {
      wrap.style.top = '80px';
      wrap.style.right = '20px';
      wrap.style.left = 'auto';
      wrap.style.bottom = 'auto';
    }
  }

  function saveOverlayState() {
    sendBg({
      type: MESSAGES.SET_OVERLAY_STATE,
      platform: platformId,
      state: {
        minimized: !!state.minimized,
        position: state.overlayPosition || null
      }
    });
  }

  /* ==================== boot ==================== */

  function installDiagnose() {
    // Attach to the isolated-world window so users can call this from
    // DevTools console (switch context dropdown to the extension) to
    // see which selectors match — the single most useful thing when
    // Meet/Zoom/Teams changes its DOM.
    try {
      window.__MCM = window.__MCM || {};
      window.__MCM.diagnose = function () {
        const rows = [];
        console.group('[MCM] diagnose — ' + platformId);
        console.log('URL:', location.href);
        console.log('platform enabled:', isPlatformEnabled());
        console.log('settings:', state.settings);
        console.log('session:', state.session);
        console.log('lastInCallSeen:', state.lastInCallSeen);
        console.log('---- in-call selectors ----');
        for (const sel of platform.inCallSelectors) {
          let el = null, err = null;
          try { el = document.querySelector(sel); } catch (e) { err = e && e.message; }
          const visible = el ? isVisible(el) : false;
          const status = err ? 'ERR: ' + err
            : el ? (visible ? 'MATCH (visible)' : 'match (hidden)')
            : 'no match';
          rows.push({ selector: sel, status });
          console.log('  ' + sel + '  →  ' + status);
        }
        console.log('---- participant extractors ----');
        for (const ext of platform.participantExtractors) {
          let el = null, err = null, count = null;
          try { el = document.querySelector(ext.selector); } catch (e) { err = e && e.message; }
          if (el) {
            try { count = ext.extract(el); } catch (e) { err = e && e.message; }
          }
          console.log('  ' + ext.selector + '  →  ' +
            (err ? 'ERR: ' + err : el ? 'matched (n=' + count + ')' : 'no match'));
        }
        console.groupEnd();
        return rows;
      };
      window.__MCM.state = state;
      window.__MCM.forceStart = function () { startSession(); };
      window.__MCM.forceEnd = function () { endSession('manual'); };
    } catch (_) { /* isolated-world attach can fail on some pages */ }
  }

  async function boot() {
    await fetchSettings();
    console.log('[MCM] loaded on', platformId,
      '- platform enabled:', isPlatformEnabled(),
      '- run __MCM.diagnose() to inspect selectors');
    installDiagnose();
    if (!isPlatformEnabled()) return;
    schedulePoll();

    // Best-effort archive on unload; background's tabs.onRemoved is the
    // real safety net.
    window.addEventListener('beforeunload', () => {
      try {
        if (state.session) {
          // sendBeacon isn't usable for extension messaging; fire-and-forget.
          persistSession();
        }
      } catch (_) {}
    });

    // Re-fetch settings if they change
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (area === 'local' && changes.settings) {
          state.settings = self.MCM.mergeSettings(changes.settings.newValue);
          renderOverlay();
        }
      } catch (_) {}
    });
  }

  boot().catch((e) => console.warn('[MCM] boot failed', e));
})();
