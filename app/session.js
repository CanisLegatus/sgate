(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./importer.js'));
  else Object.assign(root.SGate, factory(root.SGate, root.SGate));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, I) {
  'use strict';
  const own = (object, key) => Object.hasOwn(object, key);
  const empty = () => Object.create(null);
  function settings(date = E.today()) {
    return { orderDate: date, incomingDate: E.calendar(date).first, coverageWeeks: 1 };
  }
  function overrideValue(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Неверные настройки товара');
    const mode = raw.mode || 'auto';
    if (!['auto','hold','increase','decrease'].includes(mode)) throw new Error('Неизвестная стратегия');
    const out = { mode, percent: Number(raw.percent || 0), baseTarget: null, forecast: null, promoWeeks: [false,false,false,false] };
    for (const field of ['baseTarget','forecast']) if (!E.blank(raw[field])) {
      out[field] = Number(raw[field]);
      if (!E.finite(out[field]) || out[field] < 0 || out[field] > 1e9) throw new Error('Неверное значение «' + field + '»');
    }
    if (!E.finite(out.percent) || out.percent < 0 || out.percent > 500 || mode === 'decrease' && out.percent > 100) throw new Error('Неверный процент');
    if (raw.promoWeeks !== undefined) {
      if (!Array.isArray(raw.promoWeeks) || raw.promoWeeks.length !== 4 || raw.promoWeeks.some(v => typeof v !== 'boolean')) throw new Error('Неверная разметка недель');
      out.promoWeeks = [...raw.promoWeeks];
    }
    if (raw.incomingDate) { E.dayValue(raw.incomingDate); out.incomingDate = raw.incomingDate; }
    return out;
  }
  function newSession(order, initialSettings) {
    return { order, settings: initialSettings || settings(), overrides: empty(), decisions: empty(), history: [] };
  }
  function calculate(state) {
    const ctx = E.createContext(state.order, state.settings), results = new Map();
    for (const p of state.order.products) results.set(p.sku, E.compute(p, ctx, state.overrides[p.sku] || {}));
    let invalidated = 0;
    for (const [sku, decision] of Object.entries(state.decisions)) {
      if (!results.has(sku) || decision.signature !== results.get(sku).signature) { delete state.decisions[sku]; invalidated++; }
    }
    return { ctx, results, invalidated, metrics: E.metrics(state.order, results, state.decisions, ctx) };
  }
  function decide(state, calculated, sku, kind, quantity) {
    if (!['apply','keep'].includes(kind)) throw new Error('Неверный тип решения');
    const p = calculated.ctx.products.get(sku), r = calculated.results.get(sku);
    if (!p || !r) throw new Error('Товар отсутствует');
    const error = E.checkDecision(p, r, kind, quantity, calculated.ctx, state.decisions);
    if (error) throw new Error(error);
    const q = kind === 'keep' ? r.source : Number(quantity);
    state.decisions[sku] = { kind, quantity: q, signature: r.signature, time: new Date().toISOString() };
    state.history.push({ sku, kind, quantity: q, time: new Date().toISOString() });
    if (state.history.length > 5000) state.history.splice(0, state.history.length - 5000);
    return q;
  }
  function changeRows(state, calculated) {
    const changes = [];
    for (const p of state.order.products) {
      const d = state.decisions[p.sku], r = calculated.results.get(p.sku);
      if (!d || d.signature !== r.signature || d.kind !== 'apply' || d.quantity === r.source) continue;
      const error = E.checkDecision(p, r, 'apply', d.quantity, calculated.ctx, state.decisions);
      if (error) throw new Error(`${p.sku}: ${error}`);
      changes.push({ sku: p.sku, name: p.name, source: r.source, quantity: d.quantity, reason: r.reasons.join('; '), strategy: r.mode });
    }
    return changes;
  }
  function localPayload(state) {
    return { version: 1, rulesVersion: E.VERSION, fingerprint: state.order.metadata.fingerprint, settings: state.settings, overrides: state.overrides, decisions: state.decisions, history: state.history };
  }
  function snapshot(state) {
    return JSON.parse(JSON.stringify({ ...localPayload(state), format: 'sgate-session', savedAt: new Date().toISOString(), rows: state.order.rows, metadata: state.order.metadata }));
  }
  function restorePayload(order, payload, allowDate = true) {
    if (!payload || payload.version !== 1 || payload.rulesVersion !== E.VERSION) throw new Error('Неподдерживаемая версия сессии');
    if (payload.fingerprint !== order.metadata.fingerprint) throw new Error('Сессия относится к другому исходному файлу');
    const config = payload.settings;
    if (!config || typeof config !== 'object') throw new Error('Нет настроек сессии');
    E.dayValue(config.orderDate); E.dayValue(config.incomingDate);
    if (!E.finite(config.coverageWeeks) || config.coverageWeeks < 1 || config.coverageWeeks > 12) throw new Error('Неверный горизонт покрытия');
    const state = newSession(order, { orderDate: allowDate ? config.orderDate : E.today(), incomingDate: allowDate ? config.incomingDate : E.calendar(E.today()).first, coverageWeeks: config.coverageWeeks });
    if (!payload.overrides || typeof payload.overrides !== 'object' || Array.isArray(payload.overrides) || !payload.decisions || typeof payload.decisions !== 'object' || Array.isArray(payload.decisions)) throw new Error('Неверная структура решений');
    const skus = new Set(order.products.map(p => p.sku));
    for (const [sku, value] of Object.entries(payload.overrides)) {
      if (!skus.has(sku)) throw new Error('Настройки неизвестного артикула: ' + sku);
      state.overrides[sku] = overrideValue(value);
    }
    const calculated = calculate(state), pending = [];
    for (const [sku, d] of Object.entries(payload.decisions)) {
      if (!skus.has(sku) || !d || !['keep','apply'].includes(d.kind) || !E.finite(d.quantity) || d.quantity < 0 || !Number.isInteger(d.quantity)) throw new Error('Повреждённое решение: ' + sku);
      const r = calculated.results.get(sku);
      if (d.signature !== r.signature) continue; // A changed date invalidates approvals.
      if (d.kind === 'keep' && d.quantity !== r.source) throw new Error('Изменённое исходное количество: ' + sku);
      const p = calculated.ctx.products.get(sku);
      const error = E.checkDecision(p, r, d.kind, d.quantity, calculated.ctx, empty());
      // Pair checks are performed with the entire restored decision set below.
      const pairError = error && error.startsWith('В паре замен');
      if (error && !pairError) throw new Error(sku + ': ' + error);
      pending.push([sku, { kind:d.kind, quantity:d.quantity, signature:d.signature, time: typeof d.time === 'string' ? d.time : '' }]);
    }
    for (const [sku, d] of pending) state.decisions[sku] = d;
    for (const [sku, d] of pending) {
      const error = E.checkDecision(calculated.ctx.products.get(sku), calculated.results.get(sku), d.kind, d.quantity, calculated.ctx, state.decisions);
      if (error) throw new Error(sku + ': ' + error);
    }
    state.history = Array.isArray(payload.history) ? payload.history.slice(-5000).filter(h => h && skus.has(h.sku) && E.finite(h.quantity)).map(h => ({ sku:h.sku, quantity:h.quantity, kind:String(h.kind || ''), time:String(h.time || '') })) : [];
    return state;
  }
  function restoreSnapshot(payload) {
    if (!payload || payload.format !== 'sgate-session' || !payload.metadata || !Array.isArray(payload.rows)) throw new Error('Это не файл сессии sgate');
    // Always reparse original cells; never trust product fields or computed quantities in JSON.
    const metadata = { name: String(payload.metadata.name || 'Восстановленная сессия'), fingerprint: String(payload.metadata.fingerprint || ''), sheetName: String(payload.metadata.sheetName || ''), demo: payload.metadata.demo === true };
    if (!metadata.fingerprint || metadata.fingerprint.length > 150) throw new Error('Нет отпечатка исходного файла');
    for (const row of payload.rows) {
      if (!row || !Number.isInteger(row.number) || row.number < 1 || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) throw new Error('Повреждённые строки сессии');
      if (Object.entries(row.cells).some(([k,v]) => !/^[A-Z]{1,3}$/.test(k) || !['string','number'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) throw new Error('Неверные ячейки сессии');
      if (row.errors && (!Array.isArray(row.errors) || row.errors.some(e => typeof e !== 'string'))) throw new Error('Неверные ошибки исходных строк');
    }
    return restorePayload(I.parseRows(payload.rows, metadata), payload);
  }
  function safeCSV(value) {
    let s = String(value === null || value === undefined ? '' : value);
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(rows) {
    return '\uFEFF' + rows.map(row => row.map(v => typeof v === 'number' ? String(v) : safeCSV(v)).join(';')).join('\r\n');
  }
  return { defaultSettings: settings, normalizeOverride: overrideValue, newSession, calculate, decide, changeRows, localPayload, snapshot, restorePayload, restoreSnapshot, safeCSV, csv };
});
