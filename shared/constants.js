/* Meeting Cost Meter — shared constants
 * Loaded as a classic script in service worker (via importScripts),
 * content scripts (via manifest content_scripts array), and extension
 * pages (via <script src>). All values are attached to `self.MCM` so
 * they are reachable from every context without ES modules.
 */
(function (global) {
  'use strict';

  const PLATFORMS = {
    meet: {
      id: 'meet',
      name: 'Google Meet',
      hostMatch: /(^|\.)meet\.google\.com$/i,
      // Any element matching = "we are inside a live call". Multiple
      // selectors give resilience against DOM churn.
      inCallSelectors: [
        '[aria-label="Leave call"]',
        '[data-tooltip="Leave call"]',
        '[aria-label*="Leave call" i]',
        '[data-tooltip*="Leave call" i]',
        'button[jsname][aria-label*="hang up" i]'
      ],
      // Best-effort participant count locators. Each entry has a
      // selector + optional extractor. Extractor receives the element
      // and returns a number, or NaN to fall through to the next.
      participantExtractors: [
        {
          selector: '[aria-label*="Show everyone" i]',
          extract: (el) => parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10)
        },
        {
          selector: 'button[aria-label*="participant" i]',
          extract: (el) => {
            const label = el.getAttribute('aria-label') || '';
            const m = label.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : NaN;
          }
        },
        {
          selector: '[data-participant-id]',
          extract: () => document.querySelectorAll('[data-participant-id]').length
        }
      ]
    },
    zoom: {
      id: 'zoom',
      name: 'Zoom',
      hostMatch: /(^|\.)zoom\.us$/i,
      inCallSelectors: [
        // High-confidence: explicit leave/end buttons (broad — modern
        // Zoom labels are just "Leave", not "Leave meeting").
        'button[aria-label="Leave"]',
        'button[aria-label="End"]',
        'button[aria-label*="Leave" i]',
        'button[aria-label*="End meeting" i]',
        'button[aria-label*="End Meeting" i]',
        // Class-based fallbacks Zoom has used across versions
        '.footer__leave-btn',
        '.footer-button__leave-btn',
        '.leave-meeting-options__btn',
        'button.zm-btn--danger',
        'button.footer__leave-btn-container',
        // Meeting-app container fallbacks (only fire in-call, not on
        // the join screen where these DOM roots don't exist yet).
        '#zmmtg-root .footer',
        '.meeting-client-inner .footer',
        '.meeting-app .footer'
      ],
      participantExtractors: [
        {
          selector: '.footer-button__number-counter, .footer-button-base__number-counter',
          extract: (el) => parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10)
        },
        {
          selector: 'button[aria-label*="participant" i], button[aria-label*="Participants" i]',
          extract: (el) => {
            const label = el.getAttribute('aria-label') || '';
            const m = label.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : NaN;
          }
        },
        {
          selector: '.participants-header__title, .participants-section-container__participants-count',
          extract: (el) => parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10)
        }
      ]
    },
    teams: {
      id: 'teams',
      name: 'Microsoft Teams',
      hostMatch: /(^|\.)teams\.(microsoft|live)\.com$/i,
      inCallSelectors: [
        // High-confidence: hangup buttons across Teams versions
        '[data-tid="hangup-main-btn"]',
        '[data-tid="hangup-button"]',
        '[data-tid="hangupButton"]',
        '[data-tid="calling-hangup-button"]',
        '[data-tid="call-end"]',
        'button[data-tid*="hangup" i]',
        'button[data-tid*="end-call" i]',
        '#hangup-button',
        // aria-label / title — modern Teams shows "Leave (Ctrl+Shift+H)"
        'button[aria-label^="Leave" i]',
        'button[aria-label*="Hang up" i]',
        'button[title^="Leave" i]',
        'button[title*="Hang up" i]',
        // In-call screen containers (only present during an active call)
        '[data-tid="calling-screen"]',
        '[data-tid="in-call-screen"]',
        '[data-tid="new-call-experience"]',
        '[data-tid="call-stage"]'
      ],
      participantExtractors: [
        {
          selector: '[data-tid="roster-button-tile"], [data-tid="roster-button"], button[aria-label*="people" i], button[aria-label*="participants" i]',
          extract: (el) => {
            const label = el.getAttribute('aria-label') || el.textContent || '';
            const m = label.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : NaN;
          }
        },
        {
          selector: '[data-tid="roster-participant-counter"], [data-tid="participant-count"]',
          extract: (el) => parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10)
        },
        {
          selector: 'button[aria-label*="Show participants" i], button[aria-label*="Show people" i]',
          extract: (el) => {
            const label = el.getAttribute('aria-label') || '';
            const m = label.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : NaN;
          }
        }
      ]
    }
  };

  const CURRENCIES = {
    USD: { code: 'USD', symbol: '$', name: 'US Dollar' },
    EUR: { code: 'EUR', symbol: '€', name: 'Euro' },
    GBP: { code: 'GBP', symbol: '£', name: 'British Pound' },
    INR: { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
    PKR: { code: 'PKR', symbol: '₨', name: 'Pakistani Rupee' },
    AUD: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
    CAD: { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
    AED: { code: 'AED', symbol: 'AED', name: 'UAE Dirham' },
    JPY: { code: 'JPY', symbol: '¥', name: 'Japanese Yen' }
  };

  const MESSAGES = {
    GET_SETTINGS: 'GET_SETTINGS',
    SETTINGS_UPDATED: 'SETTINGS_UPDATED',
    SESSION_UPDATE: 'SESSION_UPDATE',
    SESSION_END: 'SESSION_END',
    GET_TAB_SESSION: 'GET_TAB_SESSION',
    GET_ACTIVE_SESSIONS: 'GET_ACTIVE_SESSIONS',
    GET_HISTORY: 'GET_HISTORY',
    CLEAR_HISTORY: 'CLEAR_HISTORY',
    NOTIFY: 'NOTIFY',
    CONTROL_SESSION: 'CONTROL_SESSION',
    GET_OVERLAY_STATE: 'GET_OVERLAY_STATE',
    SET_OVERLAY_STATE: 'SET_OVERLAY_STATE'
  };

  const DEFAULT_SETTINGS = {
    hourlyRate: 50,
    currency: 'PKR',
    platforms: {
      meet: { enabled: true, autoDetectAttendees: true },
      zoom: { enabled: true, autoDetectAttendees: true },
      teams: { enabled: true, autoDetectAttendees: true }
    },
    thresholds: [50, 100, 250, 500],
    notifications: true,
    theme: 'dark'
  };

  const STORAGE_KEYS = {
    SETTINGS: 'settings',
    SESSIONS: 'sessions',
    HISTORY: 'history',
    OVERLAY_STATE: 'overlayState'
  };

  const CONFIG = {
    POLL_INTERVAL_MS: 2000,
    PERSIST_INTERVAL_MS: 5000,
    IN_CALL_LOST_TIMEOUT_MS: 15000,
    TICK_INTERVAL_MS: 1000,
    HISTORY_LIMIT: 200,
    MIN_HOURLY_RATE: 0,
    MAX_HOURLY_RATE: 100000,
    MIN_ATTENDEES: 1,
    MAX_ATTENDEES: 999
  };

  function detectPlatformFromHost(hostname) {
    if (!hostname) return null;
    for (const key of Object.keys(PLATFORMS)) {
      if (PLATFORMS[key].hostMatch.test(hostname)) return key;
    }
    return null;
  }

  function mergeSettings(stored) {
    const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!stored || typeof stored !== 'object') return base;
    if (typeof stored.hourlyRate === 'number' && stored.hourlyRate >= 0) {
      base.hourlyRate = stored.hourlyRate;
    }
    if (typeof stored.currency === 'string' && CURRENCIES[stored.currency]) {
      base.currency = stored.currency;
    }
    if (stored.platforms && typeof stored.platforms === 'object') {
      for (const pid of Object.keys(base.platforms)) {
        const p = stored.platforms[pid];
        if (p && typeof p === 'object') {
          if (typeof p.enabled === 'boolean') base.platforms[pid].enabled = p.enabled;
          if (typeof p.autoDetectAttendees === 'boolean') {
            base.platforms[pid].autoDetectAttendees = p.autoDetectAttendees;
          }
        }
      }
    }
    if (Array.isArray(stored.thresholds)) {
      const cleaned = stored.thresholds
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      if (cleaned.length) base.thresholds = cleaned;
    }
    if (typeof stored.notifications === 'boolean') {
      base.notifications = stored.notifications;
    }
    if (stored.theme === 'dark' || stored.theme === 'light') {
      base.theme = stored.theme;
    }
    return base;
  }

  global.MCM = global.MCM || {};
  global.MCM.PLATFORMS = PLATFORMS;
  global.MCM.CURRENCIES = CURRENCIES;
  global.MCM.MESSAGES = MESSAGES;
  global.MCM.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  global.MCM.STORAGE_KEYS = STORAGE_KEYS;
  global.MCM.CONFIG = CONFIG;
  global.MCM.detectPlatformFromHost = detectPlatformFromHost;
  global.MCM.mergeSettings = mergeSettings;
})(typeof self !== 'undefined' ? self : this);
