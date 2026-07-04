/* Meeting Cost Meter — background service worker (MV3)
 *
 * Responsibilities:
 *   - Own the authoritative copy of settings, per-tab sessions, and
 *     history in chrome.storage.local (so state survives SW restart).
 *   - Answer messages from content script / popup / options.
 *   - Update per-tab toolbar badge with a compact live cost.
 *   - Show chrome.notifications when a threshold is crossed.
 *   - Detect abrupt tab close via chrome.tabs.onRemoved and archive
 *     any live session into history.
 */
try {
  importScripts('shared/constants.js', 'shared/format.js');
} catch (e) {
  console.error('[MCM] Failed to load shared modules:', e);
}

const { MESSAGES, STORAGE_KEYS, CONFIG, PLATFORMS } = self.MCM;

// In-memory cache of persisted state. Always re-hydrated from storage
// on demand because the SW may be killed at any time.
let cache = null;

async function loadCache() {
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.SESSIONS,
    STORAGE_KEYS.HISTORY,
    STORAGE_KEYS.OVERLAY_STATE
  ]);
  cache = {
    settings: self.MCM.mergeSettings(raw[STORAGE_KEYS.SETTINGS]),
    sessions: raw[STORAGE_KEYS.SESSIONS] && typeof raw[STORAGE_KEYS.SESSIONS] === 'object'
      ? raw[STORAGE_KEYS.SESSIONS] : {},
    history: Array.isArray(raw[STORAGE_KEYS.HISTORY]) ? raw[STORAGE_KEYS.HISTORY] : [],
    overlayState: raw[STORAGE_KEYS.OVERLAY_STATE] && typeof raw[STORAGE_KEYS.OVERLAY_STATE] === 'object'
      ? raw[STORAGE_KEYS.OVERLAY_STATE] : {}
  };
  return cache;
}

async function ensureCache() {
  if (!cache) await loadCache();
  return cache;
}

async function persistSessions() {
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS]: cache.sessions });
}
async function persistHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: cache.history });
}
async function persistSettings() {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: cache.settings });
}
async function persistOverlayState() {
  await chrome.storage.local.set({ [STORAGE_KEYS.OVERLAY_STATE]: cache.overlayState });
}

/* ---------- Badge ---------- */

async function updateBadgeForTab(tabId, session) {
  try {
    if (!session || session.ended) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const totalMs = computeLiveElapsedMs(session);
    const cost = self.MCM.computeCost(session.attendees, session.rate, totalMs);
    const text = session.paused
      ? '⏸'
      : self.MCM.formatCompactMoney(cost, session.currency);
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: session.paused ? '#2A333A' : '#FFB020'
    });
    if (chrome.action.setBadgeTextColor) {
      try {
        await chrome.action.setBadgeTextColor({
          tabId,
          color: session.paused ? '#FFFFFF' : '#0F1417'
        });
      } catch (_) { /* Chrome < 110 lacks this; harmless */ }
    }
    await chrome.action.setBadgeText({ tabId, text });
  } catch (e) {
    // A tab can vanish between calls; ignore.
  }
}

function computeLiveElapsedMs(session) {
  if (!session) return 0;
  if (session.paused || !session.currentStartTime) {
    return session.totalElapsedMs || 0;
  }
  return (session.totalElapsedMs || 0) + (Date.now() - session.currentStartTime);
}

/* ---------- Session lifecycle ---------- */

function newSession(payload) {
  const now = Date.now();
  return {
    tabId: payload.tabId,
    platform: payload.platform,
    startTime: payload.startTime || now,
    currentStartTime: payload.paused ? null : now,
    totalElapsedMs: 0,
    paused: false,
    attendees: Math.max(1, payload.attendees || 1),
    rate: payload.rate,
    currency: payload.currency,
    autoAttendees: payload.autoAttendees !== false,
    thresholdsFired: [],
    lastUpdate: now,
    ended: false
  };
}

async function upsertSession(tabId, incoming) {
  await ensureCache();
  const existing = cache.sessions[tabId];
  if (!existing) {
    cache.sessions[tabId] = newSession(Object.assign({ tabId }, incoming));
  } else {
    // Merge selectively; content script is authoritative for
    // attendees/rate/currency/paused/elapsed but we keep our own
    // thresholdsFired list.
    if (typeof incoming.attendees === 'number') existing.attendees = incoming.attendees;
    if (typeof incoming.rate === 'number') existing.rate = incoming.rate;
    if (typeof incoming.currency === 'string') existing.currency = incoming.currency;
    if (typeof incoming.paused === 'boolean') existing.paused = incoming.paused;
    if (typeof incoming.autoAttendees === 'boolean') existing.autoAttendees = incoming.autoAttendees;
    if (typeof incoming.totalElapsedMs === 'number') existing.totalElapsedMs = incoming.totalElapsedMs;
    if (typeof incoming.currentStartTime === 'number' || incoming.currentStartTime === null) {
      existing.currentStartTime = incoming.currentStartTime;
    }
    if (typeof incoming.platform === 'string') existing.platform = incoming.platform;
    if (typeof incoming.startTime === 'number') existing.startTime = incoming.startTime;
    existing.lastUpdate = Date.now();
  }
  await persistSessions();
  await updateBadgeForTab(tabId, cache.sessions[tabId]);
  return cache.sessions[tabId];
}

async function endSession(tabId, reason) {
  await ensureCache();
  const s = cache.sessions[tabId];
  if (!s || s.ended) {
    delete cache.sessions[tabId];
    await persistSessions();
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
    return null;
  }
  const durationMs = computeLiveElapsedMs(s);
  const totalCost = self.MCM.computeCost(s.attendees, s.rate, durationMs);
  const entry = {
    id: 'h_' + s.startTime + '_' + tabId,
    startTime: s.startTime,
    endTime: Date.now(),
    platform: s.platform,
    durationMs,
    attendees: s.attendees,
    rate: s.rate,
    currency: s.currency,
    totalCost,
    endReason: reason || 'manual'
  };
  cache.history.unshift(entry);
  if (cache.history.length > CONFIG.HISTORY_LIMIT) {
    cache.history.length = CONFIG.HISTORY_LIMIT;
  }
  delete cache.sessions[tabId];
  await Promise.all([persistSessions(), persistHistory()]);
  try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
  return entry;
}

/* ---------- Notifications ---------- */

async function maybeNotifyThreshold(session, thresholdValue) {
  await ensureCache();
  if (!cache.settings.notifications) return;
  const platform = PLATFORMS[session.platform];
  const platformName = platform ? platform.name : 'Meeting';
  const cost = self.MCM.formatMoney(
    self.MCM.computeCost(session.attendees, session.rate, computeLiveElapsedMs(session)),
    session.currency
  );
  const currencySymbol = (self.MCM.CURRENCIES[session.currency] || { symbol: '$' }).symbol;
  const notificationId = 'mcm_threshold_' + session.tabId + '_' + thresholdValue;
  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: platformName + ' — cost threshold crossed',
      message: 'This meeting has passed ' + currencySymbol + thresholdValue +
        '. Running total: ' + cost + '.',
      priority: 1
    });
  } catch (e) {
    // Notifications can fail silently if permission was revoked.
  }
}

/* ---------- Message handling ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (result) => sendResponse({ ok: true, data: result }),
    (err) => {
      console.error('[MCM] message handler error', err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  );
  return true; // keep sendResponse alive for async handling
});

async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== 'object' || !msg.type) {
    throw new Error('Invalid message');
  }
  await ensureCache();
  const senderTabId = sender && sender.tab ? sender.tab.id : null;

  switch (msg.type) {
    case MESSAGES.GET_SETTINGS:
      return { settings: cache.settings };

    case MESSAGES.SETTINGS_UPDATED: {
      if (msg.settings) {
        cache.settings = self.MCM.mergeSettings(msg.settings);
        await persistSettings();
      }
      // Broadcast so live overlays can pick up currency/rate/thresholds.
      broadcastToContentScripts({ type: MESSAGES.SETTINGS_UPDATED, settings: cache.settings });
      return { settings: cache.settings };
    }

    case MESSAGES.SESSION_UPDATE: {
      const tabId = msg.tabId != null ? msg.tabId : senderTabId;
      if (tabId == null) throw new Error('SESSION_UPDATE requires tabId');
      const session = await upsertSession(tabId, msg.payload || {});
      return { session };
    }

    case MESSAGES.SESSION_END: {
      const tabId = msg.tabId != null ? msg.tabId : senderTabId;
      if (tabId == null) throw new Error('SESSION_END requires tabId');
      const entry = await endSession(tabId, msg.reason);
      return { entry };
    }

    case MESSAGES.GET_TAB_SESSION: {
      const tabId = msg.tabId != null ? msg.tabId : senderTabId;
      return { session: tabId != null ? cache.sessions[tabId] || null : null };
    }

    case MESSAGES.GET_ACTIVE_SESSIONS:
      return {
        sessions: Object.keys(cache.sessions).map((k) => cache.sessions[k]),
        settings: cache.settings
      };

    case MESSAGES.GET_HISTORY:
      return { history: cache.history };

    case MESSAGES.CLEAR_HISTORY:
      cache.history = [];
      await persistHistory();
      return { ok: true };

    case MESSAGES.NOTIFY: {
      const tabId = msg.tabId != null ? msg.tabId : senderTabId;
      const session = tabId != null ? cache.sessions[tabId] : null;
      if (session && typeof msg.threshold === 'number') {
        if (!session.thresholdsFired) session.thresholdsFired = [];
        if (session.thresholdsFired.indexOf(msg.threshold) === -1) {
          session.thresholdsFired.push(msg.threshold);
          await persistSessions();
          await maybeNotifyThreshold(session, msg.threshold);
        }
      }
      return { ok: true };
    }

    case MESSAGES.CONTROL_SESSION: {
      // Popup can pause/resume/reset/end/setAttendees/setRate/setCurrency
      // by proxy — we forward to the content script for the tab.
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') throw new Error('CONTROL_SESSION requires tabId');
      try {
        const resp = await chrome.tabs.sendMessage(tabId, msg);
        return resp || { ok: true };
      } catch (e) {
        // Content script may have died (e.g. tab navigated); handle end
        // directly so history is at least preserved.
        if (msg.action === 'end') {
          const entry = await endSession(tabId, 'manual');
          return { entry };
        }
        throw e;
      }
    }

    case MESSAGES.GET_OVERLAY_STATE: {
      const key = msg.platform || 'default';
      return { state: cache.overlayState[key] || null };
    }

    case MESSAGES.SET_OVERLAY_STATE: {
      const key = msg.platform || 'default';
      cache.overlayState[key] = msg.state || {};
      await persistOverlayState();
      return { ok: true };
    }

    default:
      throw new Error('Unknown message type: ' + msg.type);
  }
}

function broadcastToContentScripts(msg) {
  // Best-effort broadcast to any live content script.
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, msg).catch(() => { /* not injected here */ });
    }
  });
}

/* ---------- Tab-close cleanup ---------- */

chrome.tabs.onRemoved.addListener(async (tabId /*, removeInfo */) => {
  try {
    await ensureCache();
    if (cache.sessions[tabId]) {
      await endSession(tabId, 'tab-closed');
    }
  } catch (e) {
    console.error('[MCM] onRemoved cleanup failed', e);
  }
});

/* ---------- Live badge tick ----------
 * Chrome may put the service worker to sleep; when it does, chrome.alarms
 * wakes us up to refresh badges for running sessions. 30s cadence
 * balances "badge feels live" against battery drain.
 */
chrome.alarms.create('mcm-badge-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mcm-badge-tick') return;
  try {
    await ensureCache();
    for (const tabIdStr of Object.keys(cache.sessions)) {
      const tabId = Number(tabIdStr);
      await updateBadgeForTab(tabId, cache.sessions[tabIdStr]);
    }
  } catch (_) { /* ignore */ }
});

/* ---------- Install / startup ---------- */

chrome.runtime.onInstalled.addListener(async () => {
  await loadCache();
  // Ensure defaults are written so options page reads a stable object.
  await persistSettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadCache();
  // Clear stale session entries whose tabs no longer exist.
  try {
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set(tabs.map((t) => t.id));
    let dirty = false;
    for (const tabIdStr of Object.keys(cache.sessions)) {
      const tabId = Number(tabIdStr);
      if (!liveIds.has(tabId)) {
        await endSession(tabId, 'tab-closed');
        dirty = true;
      }
    }
    if (dirty) await persistSessions();
  } catch (_) { /* ignore */ }
});

// Load cache eagerly on worker wake-up.
loadCache().catch((e) => console.error('[MCM] initial cache load failed', e));
