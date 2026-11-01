(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./importer.js'));
  else Object.assign(root.SGate, factory(root.SGate, root.SGate));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, I) {
  'use strict';
  const empty = () => Object.create(null);
  function settings(date = E.today()) {
    return { orderDate:date, incomingDate:E.calendar(date).first, coverageWeeks:1, strategy:'auto', percent:0, safetyStockPercent:25 };
  }
  function normalizeSettings(raw) {
    const value = { ...settings(raw.orderDate), ...raw };
    if (!E.finite(value.coverageWeeks) || value.coverageWeeks < 1 || value.coverageWeeks > 12) throw new Error('Горизонт: от 1 до 12 недель');
    E.createContext({products:[]},value);
    return value;
  }
  function overrideValue(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Неверные настройки товара');
    const out = { baseTarget:null,forecast:null,promoWeeks:[false,false,false,false] };
    for (const key of ['baseTarget','forecast']) if (!E.blank(raw[key])) {
      out[key] = Number(raw[key]);
      if (!E.finite(out[key]) || out[key] < 0 || out[key] > 1e9) throw new Error('Неверное значение «' + key + '»');
    }
    if (raw.promoWeeks !== undefined) {
      if (!Array.isArray(raw.promoWeeks) || raw.promoWeeks.length !== 4 || raw.promoWeeks.some(v=>typeof v !== 'boolean')) throw new Error('Неверная разметка недель');
      out.promoWeeks = [...raw.promoWeeks];
    }
    if (raw.incomingDate) { E.dayValue(raw.incomingDate); out.incomingDate=raw.incomingDate; }
    return out;
  }
  function newSession(order,config) {
    return {order,settings:normalizeSettings(config || settings()),overrides:empty(),manualQuantities:empty(),replacementChoices:empty()};
  }
  function calculate(state) {
    const ctx=E.createContext(state.order,state.settings,state.replacementChoices),results=new Map();
    for (const p of state.order.products) {
      const r=E.compute(p,ctx,state.overrides[p.sku] || {});
      if (Object.hasOwn(state.manualQuantities,p.sku)) {
        const q=state.manualQuantities[p.sku],error=E.validateQuantity(p,r,q);
        if (error) throw new Error(p.sku + ': ' + error);
        r.quantity=q;r.manual=true;
        r.projection=r.demand === null ? null : E.project(p,r.demand,q,ctx,r.zero.incomingDate);
        r.reasons.push(`Количество задано вручную: ${q} шт.`);
        // Reassess residual shortage using the actual manual order, not the automatic alternative.
        if (['supply','arrival'].includes(r.problem.kind)) r.problem={required:false,kind:'none',severity:0,text:''};
        if (!r.review && !r.blocked && r.projection && (r.projection.lostAfter > 1e-6 || r.projection.secondBefore < r.reserve - 1e-6)) r.problem={required:true,kind:'supply',severity:80,text:'Ручного количества не хватает до второго четверга/резерва'};
        else if (!r.review && !r.blocked && r.projection?.lostBefore > 0) r.problem={required:true,kind:'arrival',severity:70,text:'Дефицит до ближайшей поставки: текущий заказ не успеет'};
      }
      results.set(p.sku,r);
    }
    for (const group of ctx.groups.values()) {
      const ordered=group.members.filter(sku=>results.get(sku)?.quantity > 0);
      if (ordered.length > 1) throw new Error('В группе замен положительный заказ у нескольких артикулов: ' + ordered.join(', '));
    }
    return {ctx,results,metrics:E.metrics(state.order,results,ctx)};
  }
  function replaceState(target,next) { Object.assign(target,next); }
  function chooseReplacement(state,calculated,groupId,sku) {
    const group=calculated.ctx.groups.get(groupId),p=calculated.ctx.products.get(sku);
    if (!group || !group.ambiguous || !group.members.includes(sku) || !p || !E.cubeEligibility(p).allowed || p.errors.length) throw new Error('Выбранный артикул не допущен к этой группе замен');
    const next={...state,replacementChoices:{...state.replacementChoices,[groupId]:sku},manualQuantities:{...state.manualQuantities}};
    for (const member of group.members) delete next.manualQuantities[member];
    calculate(next);replaceState(state,next);
  }
  function setQuantity(state,calculated,sku,quantity) {
    const p=calculated.ctx.products.get(sku),r=calculated.results.get(sku);
    if (!p || !r) throw new Error('Товар отсутствует');
    const next={...state,manualQuantities:{...state.manualQuantities},replacementChoices:{...state.replacementChoices}};
    // Entering a positive quantity explicitly selects that member of an ambiguous group.
    if (quantity > 0 && r.group?.ambiguous && r.group.chosen !== sku) chooseReplacement(next,calculated,r.group.id,sku);
    next.manualQuantities[sku]=quantity;
    calculate(next);replaceState(state,next);
  }
  function resetQuantity(state,sku) { delete state.manualQuantities[sku]; }
  function updateSettings(state,raw) {
    const config=normalizeSettings(raw),strategyChanged=config.strategy !== state.settings.strategy || config.percent !== state.settings.percent;
    const next={...state,settings:config,manualQuantities:strategyChanged ? empty() : {...state.manualQuantities}};
    calculate(next);replaceState(state,next);
  }
  function changeRows(state,calculated) {
    return state.order.products.flatMap(p=>{
      const r=calculated.results.get(p.sku);
      if (r.quantity === null || r.quantity === r.source) return [];
      const error=E.validateQuantity(p,r,r.quantity);if(error)throw new Error(p.sku+': '+error);
      return [{sku:p.sku,name:p.name,source:r.source,quantity:r.quantity,reason:r.reasons.join('; '),strategy:r.mode,manual:r.manual}];
    });
  }
  function problemItems(state,calculated,subset=state.order.products) {
    const groups=new Map(),singles=[];
    for (const p of subset) {
      const r=calculated.results.get(p.sku);if(!r.problem.required)continue;
      if (!r.group?.ambiguous) {singles.push(p);continue;}
      const prev=groups.get(r.group.id);
      if (!prev || r.source > calculated.results.get(prev.sku).source) groups.set(r.group.id,p);
    }
    return [...singles,...groups.values()];
  }
  function localPayload(state) {
    return {version:2,rulesVersion:E.VERSION,fingerprint:state.order.metadata.fingerprint,settings:state.settings,overrides:state.overrides,manualQuantities:state.manualQuantities,replacementChoices:state.replacementChoices};
  }
  function snapshot(state) {
    return JSON.parse(JSON.stringify({...localPayload(state),format:'sgate-session',savedAt:new Date().toISOString(),rows:state.order.rows,metadata:state.order.metadata}));
  }
  function record(value,name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверная структура: '+name);
    return value;
  }
  function restorePayload(order,payload,allowDate=true) {
    const legacy=payload?.version === 1 && ['sgate-1.0','sgate-1.1'].includes(payload.rulesVersion);
    if (!payload || !(payload.version === 2 && [E.VERSION,'sgate-2.0'].includes(payload.rulesVersion) || legacy)) throw new Error('Неподдерживаемая версия сессии');
    if (payload.fingerprint !== order.metadata.fingerprint) throw new Error('Сессия относится к другому исходному файлу');
    const cfg=record(payload.settings,'настройки'),config={...cfg};
    if (!allowDate) {config.orderDate=E.today();config.incomingDate=E.calendar(config.orderDate).first;}
    const state=newSession(order,config),skus=new Set(order.products.map(p=>p.sku));
    for (const [sku,raw] of Object.entries(record(payload.overrides,'параметры товаров'))) {
      if (!skus.has(sku)) throw new Error('Неизвестный артикул: '+sku);
      state.overrides[sku]=overrideValue(raw);
    }
    for (const [group,sku] of Object.entries(record(payload.replacementChoices || {},'замены'))) {
      if (typeof sku !== 'string') throw new Error('Неверный артикул замены');
      state.replacementChoices[group]=sku;
    }
    if (!legacy) for (const [sku,q] of Object.entries(record(payload.manualQuantities,'ручные количества'))) {
      if (!skus.has(sku) || !E.finite(q) || !Number.isInteger(q) || q < 0) throw new Error('Повреждённое ручное количество: '+sku);
      state.manualQuantities[sku]=q;
    }
    if (payload.rulesVersion !== E.VERSION) state.migratedFrom=payload.rulesVersion; // Approval records are deliberately not migrated.
    calculate(state);return state;
  }
  function restoreSnapshot(payload) {
    if (!payload || payload.format !== 'sgate-session' || !payload.metadata || !Array.isArray(payload.rows)) throw new Error('Это не файл сессии sgate');
    const metadata={name:String(payload.metadata.name || 'Восстановленная сессия'),fingerprint:String(payload.metadata.fingerprint || ''),sheetName:String(payload.metadata.sheetName || ''),demo:payload.metadata.demo === true};
    if (!metadata.fingerprint || metadata.fingerprint.length > 150) throw new Error('Нет отпечатка исходного файла');
    for (const row of payload.rows) {
      if (!row || !Number.isInteger(row.number) || row.number < 1 || !row.cells || typeof row.cells !== 'object' || Array.isArray(row.cells)) throw new Error('Повреждённые строки сессии');
      if (Object.entries(row.cells).some(([k,v])=>! /^[A-Z]{1,3}$/.test(k) || !['string','number'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) throw new Error('Неверные ячейки сессии');
      if (row.errors && (!Array.isArray(row.errors) || row.errors.some(e=>typeof e !== 'string'))) throw new Error('Неверные ошибки исходных строк');
    }
    return restorePayload(I.parseRows(payload.rows,metadata),payload);
  }
  function safeCSV(value) {
    let s=String(value === null || value === undefined ? '' : value);
    if (/^[\s]*[=+\-@]/.test(s)) s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function csv(rows) {return '\uFEFF'+rows.map(row=>row.map(v=>typeof v === 'number'?String(v):safeCSV(v)).join(';')).join('\r\n');}
  return {defaultSettings:settings,normalizeSettings,normalizeOverride:overrideValue,newSession,calculate,setQuantity,resetQuantity,updateSettings,chooseReplacement,changeRows,problemItems,localPayload,snapshot,restorePayload,restoreSnapshot,safeCSV,csv};
});
