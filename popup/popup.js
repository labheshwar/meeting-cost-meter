/* Meeting Cost Meter — popup logic */
(function () {
  'use strict';

  const { MESSAGES, CURRENCIES, PLATFORMS } = self.MCM;

  const els = {
    sectionCurrent: document.getElementById('section-current'),
    sectionEmpty: document.getElementById('section-empty'),
    sectionOther: document.getElementById('section-other'),
    curPlatform: document.getElementById('cur-platform'),
    curStatus: document.getElementById('cur-status'),
    curCost: document.getElementById('cur-cost'),
    curElapsed: document.getElementById('cur-elapsed'),
    curBurn: document.getElementById('cur-burn'),
    curAtt: document.getElementById('cur-att'),
    curAttMinus: document.getElementById('cur-att-minus'),
    curAttPlus: document.getElementById('cur-att-plus'),
    curRate: document.getElementById('cur-rate'),
    curCurrency: document.getElementById('cur-currency'),
    btnPause: document.getElementById('btn-pause'),
    btnReset: document.getElementById('btn-reset'),
    btnEnd: document.getElementById('btn-end'),
    btnExport: document.getElementById('btn-export'),
    btnClear: document.getElementById('btn-clear'),
    btnOptions: document.getElementById('btn-options'),
    otherList: document.getElementById('other-list'),
    historyList: document.getElementById('history-list'),
    historyEmpty: document.getElementById('history-empty')
  };

  let state = {
    currentTabId: null,
    session: null,        // session for current tab
    otherSessions: [],
    history: [],
    settings: null,
    tickTimer: null,
    // Track focused inputs so we don't stomp the value while typing.
    focusedInputId: null
  };

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

  async function init() {
    populateCurrencies();
    applyTheme();

    // Which tab is the popup for?
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTabId = tab && tab.id != null ? tab.id : null;

    await refresh();
    startTick();

    // Track focus so live refresh doesn't overwrite what the user is typing.
    ['cur-att', 'cur-rate'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', () => { state.focusedInputId = id; });
      el.addEventListener('blur', () => {
        if (state.focusedInputId === id) state.focusedInputId = null;
      });
    });

    wireControls();
  }

  function applyTheme() {
    // Read theme from local storage synchronously via runtime message on load.
    // The settings arrive from refresh(); we adjust the body class then.
  }

  function populateCurrencies() {
    const sel = els.curCurrency;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    Object.keys(CURRENCIES).forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code + ' (' + CURRENCIES[code].symbol + ')';
      sel.appendChild(opt);
    });
  }

  async function refresh() {
    const [activeResp, historyResp, settingsResp] = await Promise.all([
      sendBg({ type: MESSAGES.GET_ACTIVE_SESSIONS }),
      sendBg({ type: MESSAGES.GET_HISTORY }),
      sendBg({ type: MESSAGES.GET_SETTINGS })
    ]);

    const active = (activeResp && activeResp.ok && activeResp.data) || {};
    const sessions = Array.isArray(active.sessions) ? active.sessions : [];
    state.settings = (settingsResp && settingsResp.ok && settingsResp.data && settingsResp.data.settings)
      || self.MCM.DEFAULT_SETTINGS;

    // Apply theme
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(state.settings.theme === 'light' ? 'theme-light' : 'theme-dark');

    // Split into current-tab vs other-tab sessions
    state.session = sessions.find((s) => s.tabId === state.currentTabId) || null;
    state.otherSessions = sessions.filter((s) => s.tabId !== state.currentTabId);
    state.history = (historyResp && historyResp.ok && historyResp.data && historyResp.data.history) || [];

    renderCurrent();
    renderOther();
    renderHistory();
  }

  function liveElapsedMs(s) {
    if (!s) return 0;
    if (s.paused || !s.currentStartTime) return s.totalElapsedMs || 0;
    return (s.totalElapsedMs || 0) + (Date.now() - s.currentStartTime);
  }

  function renderCurrent() {
    if (!state.session) {
      els.sectionCurrent.hidden = true;
      els.sectionEmpty.hidden = false;
      return;
    }
    els.sectionEmpty.hidden = true;
    els.sectionCurrent.hidden = false;

    const s = state.session;
    const platformName = (PLATFORMS[s.platform] && PLATFORMS[s.platform].name) || s.platform || '—';
    els.curPlatform.textContent = platformName;

    const elapsed = liveElapsedMs(s);
    const cost = self.MCM.computeCost(s.attendees, s.rate, elapsed);
    const perSec = self.MCM.costPerSecond(s.attendees, s.rate);

    els.curCost.textContent = self.MCM.formatMoney(cost, s.currency);
    els.curElapsed.textContent = self.MCM.formatDuration(elapsed);
    els.curBurn.textContent = self.MCM.formatMoney(perSec, s.currency) + '/s';

    // Only touch input values when not focused (avoid stomping user typing)
    if (state.focusedInputId !== 'cur-att') els.curAtt.value = String(s.attendees);
    if (state.focusedInputId !== 'cur-rate') els.curRate.value = String(s.rate);
    els.curCurrency.value = s.currency;

    els.btnPause.textContent = s.paused ? 'Resume' : 'Pause';

    const anyThreshold = (state.settings.thresholds || []).some((t) => cost >= t);
    els.sectionCurrent.classList.toggle('paused', !!s.paused);
    els.sectionCurrent.classList.toggle('alert', anyThreshold && !s.paused);
    els.curStatus.textContent = s.paused ? 'Paused' : (anyThreshold ? 'Over budget' : 'Live');
  }

  function renderOther() {
    while (els.otherList.firstChild) els.otherList.removeChild(els.otherList.firstChild);
    if (!state.otherSessions.length) {
      els.sectionOther.hidden = true;
      return;
    }
    els.sectionOther.hidden = false;

    for (const s of state.otherSessions) {
      const li = document.createElement('li');
      li.className = 'other-item';
      li.setAttribute('role', 'button');
      li.tabIndex = 0;

      const row1 = document.createElement('div');
      row1.className = 'row1';
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      dot.style.width = '6px';
      dot.style.height = '6px';
      if (s.paused) { dot.style.background = 'var(--muted)'; dot.style.boxShadow = 'none'; dot.style.animation = 'none'; }
      row1.appendChild(dot);
      const name = document.createElement('span');
      name.textContent = (PLATFORMS[s.platform] && PLATFORMS[s.platform].name) || s.platform || 'Meeting';
      row1.appendChild(name);
      const costInline = document.createElement('span');
      costInline.className = 'cost-inline';
      costInline.style.marginLeft = 'auto';
      const cost = self.MCM.computeCost(s.attendees, s.rate, liveElapsedMs(s));
      costInline.textContent = self.MCM.formatMoney(cost, s.currency);
      row1.appendChild(costInline);
      li.appendChild(row1);

      const row2 = document.createElement('div');
      row2.className = 'row2';
      row2.textContent = self.MCM.formatDuration(liveElapsedMs(s)) +
        ' · ' + s.attendees + (s.attendees === 1 ? ' attendee' : ' attendees');
      li.appendChild(row2);

      li.addEventListener('click', () => activateTab(s.tabId));
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activateTab(s.tabId); }
      });

      els.otherList.appendChild(li);
    }
  }

  function renderHistory() {
    while (els.historyList.firstChild) els.historyList.removeChild(els.historyList.firstChild);
    if (!state.history.length) {
      els.historyEmpty.hidden = false;
      els.historyList.hidden = true;
      return;
    }
    els.historyEmpty.hidden = true;
    els.historyList.hidden = false;

    for (const e of state.history) {
      const li = document.createElement('li');
      li.className = 'hist-item';
      if (e.endReason === 'tab-closed') li.classList.add('abrupt');

      const row1 = document.createElement('div');
      row1.className = 'row1';
      const left = document.createElement('span');
      left.textContent = (PLATFORMS[e.platform] && PLATFORMS[e.platform].name) || e.platform || '—';
      row1.appendChild(left);
      const right = document.createElement('span');
      right.className = 'hist-cost';
      right.textContent = self.MCM.formatMoney(e.totalCost, e.currency);
      row1.appendChild(right);
      li.appendChild(row1);

      const row2 = document.createElement('div');
      row2.className = 'row2';
      const dateSpan = document.createElement('span');
      dateSpan.textContent = self.MCM.formatDate(e.startTime);
      row2.appendChild(dateSpan);
      const durSpan = document.createElement('span');
      durSpan.textContent = self.MCM.formatDuration(e.durationMs);
      row2.appendChild(durSpan);
      const attSpan = document.createElement('span');
      attSpan.textContent = e.attendees + '×';
      row2.appendChild(attSpan);
      const rateSpan = document.createElement('span');
      rateSpan.textContent = self.MCM.formatMoney(e.rate, e.currency) + '/hr';
      row2.appendChild(rateSpan);
      li.appendChild(row2);

      els.historyList.appendChild(li);
    }
  }

  async function activateTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });
      window.close();
    } catch (e) {
      // Tab may have closed already; just refresh.
      refresh();
    }
  }

  function wireControls() {
    els.btnOptions.addEventListener('click', () => {
      try { chrome.runtime.openOptionsPage(); } catch (_) {}
    });

    els.btnPause.addEventListener('click', async () => {
      if (!state.session) return;
      await sendBg({
        type: MESSAGES.CONTROL_SESSION,
        tabId: state.session.tabId,
        action: state.session.paused ? 'resume' : 'pause'
      });
      setTimeout(refresh, 100);
    });

    els.btnReset.addEventListener('click', async () => {
      if (!state.session) return;
      await sendBg({
        type: MESSAGES.CONTROL_SESSION,
        tabId: state.session.tabId,
        action: 'reset'
      });
      setTimeout(refresh, 100);
    });

    els.btnEnd.addEventListener('click', async () => {
      if (!state.session) return;
      await sendBg({
        type: MESSAGES.CONTROL_SESSION,
        tabId: state.session.tabId,
        action: 'end'
      });
      setTimeout(refresh, 100);
    });

    els.curAttMinus.addEventListener('click', () => stepAttendees(-1));
    els.curAttPlus.addEventListener('click', () => stepAttendees(1));
    els.curAtt.addEventListener('change', () => {
      const n = parseInt(els.curAtt.value, 10);
      if (Number.isFinite(n) && state.session) {
        sendBg({
          type: MESSAGES.CONTROL_SESSION,
          tabId: state.session.tabId,
          action: 'setAttendees',
          value: n
        }).then(refresh);
      }
    });

    let rateDebounce;
    els.curRate.addEventListener('input', () => {
      clearTimeout(rateDebounce);
      rateDebounce = setTimeout(() => {
        const n = parseFloat(els.curRate.value);
        if (Number.isFinite(n) && n >= 0 && state.session) {
          sendBg({
            type: MESSAGES.CONTROL_SESSION,
            tabId: state.session.tabId,
            action: 'setRate',
            value: n
          });
        }
      }, 250);
    });

    els.curCurrency.addEventListener('change', () => {
      if (!state.session) return;
      sendBg({
        type: MESSAGES.CONTROL_SESSION,
        tabId: state.session.tabId,
        action: 'setCurrency',
        value: els.curCurrency.value
      }).then(refresh);
    });

    els.btnExport.addEventListener('click', exportCsv);
    els.btnClear.addEventListener('click', clearHistory);
  }

  async function stepAttendees(delta) {
    if (!state.session) return;
    const next = Math.max(1, Math.min(999, (state.session.attendees || 1) + delta));
    await sendBg({
      type: MESSAGES.CONTROL_SESSION,
      tabId: state.session.tabId,
      action: 'setAttendees',
      value: next
    });
    refresh();
  }

  function exportCsv() {
    if (!state.history.length) return;
    const csv = self.MCM.historyToCsv(state.history);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'meeting-cost-history-' + ts + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 500);
  }

  async function clearHistory() {
    // Destructive — this is one of the two places the spec explicitly
    // allows a confirm() prompt.
    // eslint-disable-next-line no-alert
    if (!confirm('Clear all meeting history? This cannot be undone.')) return;
    await sendBg({ type: MESSAGES.CLEAR_HISTORY });
    refresh();
  }

  function startTick() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
      // Light tick: recompute live values only, no full refresh.
      if (state.session) renderCurrent();
      if (state.otherSessions.length) renderOther();
    }, 1000);
    // Do a full refresh less often to catch cross-tab state changes.
    setInterval(refresh, 5000);
  }

  window.addEventListener('beforeunload', () => {
    if (state.tickTimer) clearInterval(state.tickTimer);
  });

  init().catch((e) => console.error('[MCM popup] init failed', e));
})();
