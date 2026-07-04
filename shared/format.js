/* Meeting Cost Meter — shared formatting helpers */
(function (global) {
  'use strict';

  function getCurrency(code) {
    const currencies = (global.MCM && global.MCM.CURRENCIES) || {};
    return currencies[code] || { code: code || 'USD', symbol: '$', name: 'US Dollar' };
  }

  function formatMoney(amount, currencyCode) {
    const cur = getCurrency(currencyCode);
    const safe = Number.isFinite(amount) ? amount : 0;
    const abs = Math.abs(safe);
    // Above 10k, drop the cents for readability on the meter.
    const digits = abs >= 10000 ? 0 : 2;
    const rounded = safe.toFixed(digits);
    const [intPart, decPart] = rounded.split('.');
    const withGroups = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return cur.symbol + (decPart ? withGroups + '.' + decPart : withGroups);
  }

  function formatCompactMoney(amount, currencyCode) {
    const cur = getCurrency(currencyCode);
    const safe = Number.isFinite(amount) ? amount : 0;
    const abs = Math.abs(safe);
    let str;
    if (abs >= 1e9) str = (safe / 1e9).toFixed(1) + 'B';
    else if (abs >= 1e6) str = (safe / 1e6).toFixed(1) + 'M';
    else if (abs >= 1e3) str = (safe / 1e3).toFixed(1) + 'k';
    else str = Math.round(safe).toString();
    // Strip a trailing ".0" for cleaner badges (e.g. "1k" not "1.0k")
    str = str.replace(/\.0([kMB])$/, '$1');
    return cur.symbol + str;
  }

  function formatDuration(ms) {
    const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const totalSec = Math.floor(safeMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return pad(m) + ':' + pad(s);
  }

  function formatDate(ts) {
    if (!Number.isFinite(ts)) return '—';
    try {
      const d = new Date(ts);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) + ' ' + d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return String(ts);
    }
  }

  function computeCost(attendees, hourlyRate, elapsedMs) {
    const a = Number.isFinite(attendees) && attendees > 0 ? attendees : 0;
    const r = Number.isFinite(hourlyRate) && hourlyRate > 0 ? hourlyRate : 0;
    const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    return a * r * (t / 3600000);
  }

  function costPerSecond(attendees, hourlyRate) {
    const a = Number.isFinite(attendees) && attendees > 0 ? attendees : 0;
    const r = Number.isFinite(hourlyRate) && hourlyRate > 0 ? hourlyRate : 0;
    return (a * r) / 3600;
  }

  // Escape a CSV cell: wrap in quotes if it contains a comma, quote, or newline.
  function csvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function historyToCsv(entries) {
    const header = [
      'Started', 'Ended', 'Platform', 'DurationSeconds',
      'Attendees', 'HourlyRate', 'Currency', 'TotalCost', 'EndReason'
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const e of entries || []) {
      lines.push([
        new Date(e.startTime || 0).toISOString(),
        new Date(e.endTime || 0).toISOString(),
        e.platform || '',
        Math.round((e.durationMs || 0) / 1000),
        e.attendees != null ? e.attendees : '',
        e.rate != null ? e.rate : '',
        e.currency || '',
        (e.totalCost != null ? e.totalCost : 0).toFixed(2),
        e.endReason || ''
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n');
  }

  global.MCM = global.MCM || {};
  global.MCM.formatMoney = formatMoney;
  global.MCM.formatCompactMoney = formatCompactMoney;
  global.MCM.formatDuration = formatDuration;
  global.MCM.formatDate = formatDate;
  global.MCM.computeCost = computeCost;
  global.MCM.costPerSecond = costPerSecond;
  global.MCM.historyToCsv = historyToCsv;
})(typeof self !== 'undefined' ? self : this);
