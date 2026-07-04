/* Meeting Cost Meter — options page logic */
(function () {
  'use strict';

  const { MESSAGES, CURRENCIES, PLATFORMS, DEFAULT_SETTINGS, CONFIG } = self.MCM;

  const els = {
    hourlyRate: document.getElementById('hourlyRate'),
    errHourly: document.getElementById('err-hourlyRate'),
    currency: document.getElementById('currency'),
    platformGrid: document.getElementById('platform-grid'),
    thresholdList: document.getElementById('threshold-list'),
    thresholdNew: document.getElementById('threshold-new'),
    thresholdAddBtn: document.getElementById('threshold-add-btn'),
    errThresholds: document.getElementById('err-thresholds'),
    notifications: document.getElementById('notifications'),
    themeRadios: document.querySelectorAll('input[name="theme"]'),
    btnExport: document.getElementById('btn-export'),
    btnClear: document.getElementById('btn-clear'),
    btnReset: document.getElementById('btn-reset'),
    dataStatus: document.getElementById('data-status'),
    toast: document.getElementById('toast')
  };

  let settings = null;

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
    populateCurrency();
    buildPlatformRows();

    const resp = await sendBg({ type: MESSAGES.GET_SETTINGS });
    settings = (resp && resp.ok && resp.data && resp.data.settings)
      ? resp.data.settings
      : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

    renderAll();
    wire();
  }

  function populateCurrency() {
    while (els.currency.firstChild) els.currency.removeChild(els.currency.firstChild);
    Object.keys(CURRENCIES).forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code + ' (' + CURRENCIES[code].symbol + ') — ' + CURRENCIES[code].name;
      els.currency.appendChild(opt);
    });
  }

  function buildPlatformRows() {
    while (els.platformGrid.firstChild) els.platformGrid.removeChild(els.platformGrid.firstChild);
    Object.keys(PLATFORMS).forEach((pid) => {
      const p = PLATFORMS[pid];
      const row = document.createElement('div');
      row.className = 'platform-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = p.name;
      row.appendChild(nameEl);

      const enWrap = document.createElement('label');
      enWrap.className = 'toggle';
      const enLabel = document.createElement('span');
      enLabel.className = 'col-label';
      enLabel.textContent = 'Enabled';
      const enInput = document.createElement('input');
      enInput.type = 'checkbox';
      enInput.dataset.platform = pid;
      enInput.dataset.field = 'enabled';
      enWrap.appendChild(enLabel);
      enWrap.appendChild(enInput);
      row.appendChild(enWrap);

      const autoWrap = document.createElement('label');
      autoWrap.className = 'toggle';
      const autoLabel = document.createElement('span');
      autoLabel.className = 'col-label';
      autoLabel.textContent = 'Auto-detect attendees';
      const autoInput = document.createElement('input');
      autoInput.type = 'checkbox';
      autoInput.dataset.platform = pid;
      autoInput.dataset.field = 'autoDetectAttendees';
      autoWrap.appendChild(autoLabel);
      autoWrap.appendChild(autoInput);
      row.appendChild(autoWrap);

      els.platformGrid.appendChild(row);
    });
  }

  function renderAll() {
    // Theme first (affects everything else)
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(settings.theme === 'light' ? 'theme-light' : 'theme-dark');

    els.hourlyRate.value = String(settings.hourlyRate);
    els.currency.value = settings.currency;
    els.notifications.checked = !!settings.notifications;

    els.themeRadios.forEach((r) => { r.checked = r.value === settings.theme; });

    Object.keys(PLATFORMS).forEach((pid) => {
      const p = settings.platforms[pid] || { enabled: true, autoDetectAttendees: true };
      const en = document.querySelector('input[data-platform="' + pid + '"][data-field="enabled"]');
      const au = document.querySelector('input[data-platform="' + pid + '"][data-field="autoDetectAttendees"]');
      if (en) en.checked = !!p.enabled;
      if (au) au.checked = !!p.autoDetectAttendees;
    });

    renderThresholds();
  }

  function renderThresholds() {
    while (els.thresholdList.firstChild) els.thresholdList.removeChild(els.thresholdList.firstChild);
    const list = (settings.thresholds || []).slice().sort((a, b) => a - b);
    for (const t of list) {
      const li = document.createElement('li');

      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = self.MCM.formatMoney(t, settings.currency);
      li.appendChild(val);

      const rm = document.createElement('button');
      rm.className = 'btn small danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => {
        settings.thresholds = settings.thresholds.filter((x) => x !== t);
        persist().then(renderThresholds);
      });
      li.appendChild(rm);

      els.thresholdList.appendChild(li);
    }
    if (!list.length) {
      const empty = document.createElement('li');
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '12px';
      empty.style.background = 'transparent';
      empty.style.border = 'none';
      empty.textContent = 'No thresholds yet — add one below.';
      els.thresholdList.appendChild(empty);
    }
  }

  function wire() {
    // Rate
    els.hourlyRate.addEventListener('input', () => {
      const n = parseFloat(els.hourlyRate.value);
      if (!Number.isFinite(n) || n < CONFIG.MIN_HOURLY_RATE || n > CONFIG.MAX_HOURLY_RATE) {
        showError(els.errHourly,
          'Enter a number between ' + CONFIG.MIN_HOURLY_RATE + ' and ' + CONFIG.MAX_HOURLY_RATE + '.');
        return;
      }
      hideError(els.errHourly);
      settings.hourlyRate = n;
      persist();
    });

    // Currency
    els.currency.addEventListener('change', () => {
      if (CURRENCIES[els.currency.value]) {
        settings.currency = els.currency.value;
        persist();
        renderThresholds(); // symbol changed
      }
    });

    // Platform toggles (event delegation on the grid)
    els.platformGrid.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement)) return;
      const pid = t.dataset.platform;
      const field = t.dataset.field;
      if (!pid || !field || !settings.platforms[pid]) return;
      settings.platforms[pid][field] = !!t.checked;
      persist();
    });

    // Notifications
    els.notifications.addEventListener('change', () => {
      settings.notifications = !!els.notifications.checked;
      persist();
    });

    // Theme
    els.themeRadios.forEach((r) => {
      r.addEventListener('change', () => {
        if (r.checked && (r.value === 'dark' || r.value === 'light')) {
          settings.theme = r.value;
          document.body.classList.remove('theme-dark', 'theme-light');
          document.body.classList.add('theme-' + r.value);
          persist();
        }
      });
    });

    // Threshold add
    els.thresholdAddBtn.addEventListener('click', addThreshold);
    els.thresholdNew.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); addThreshold(); }
    });

    // Data actions
    els.btnExport.addEventListener('click', exportCsv);
    els.btnClear.addEventListener('click', clearHistory);
    els.btnReset.addEventListener('click', resetSettings);
  }

  function addThreshold() {
    const raw = els.thresholdNew.value;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
      showError(els.errThresholds, 'Threshold must be a positive number.');
      return;
    }
    if (n > 1e9) {
      showError(els.errThresholds, 'Threshold is too large.');
      return;
    }
    hideError(els.errThresholds);
    const set = new Set(settings.thresholds || []);
    set.add(n);
    settings.thresholds = Array.from(set).sort((a, b) => a - b);
    els.thresholdNew.value = '';
    persist().then(renderThresholds);
  }

  function showError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  async function persist() {
    const resp = await sendBg({ type: MESSAGES.SETTINGS_UPDATED, settings });
    if (resp && resp.ok && resp.data && resp.data.settings) {
      settings = resp.data.settings;
    }
    toast('Saved', 'ok');
  }

  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = 'toast ' + (kind || '');
    els.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { els.toast.hidden = true; }, 1500);
  }

  async function exportCsv() {
    const resp = await sendBg({ type: MESSAGES.GET_HISTORY });
    const history = (resp && resp.ok && resp.data && resp.data.history) || [];
    if (!history.length) {
      toast('No history to export', 'err');
      return;
    }
    const csv = self.MCM.historyToCsv(history);
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
    // eslint-disable-next-line no-alert
    if (!confirm('Clear all meeting history? This cannot be undone.')) return;
    await sendBg({ type: MESSAGES.CLEAR_HISTORY });
    toast('History cleared', 'ok');
  }

  async function resetSettings() {
    // eslint-disable-next-line no-alert
    if (!confirm('Reset all settings to defaults?')) return;
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    await persist();
    renderAll();
  }

  init().catch((e) => console.error('[MCM options] init failed', e));
})();
