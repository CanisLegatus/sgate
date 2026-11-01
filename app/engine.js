/* sgate: pure order rules. No I/O, DOM or hidden per-SKU exceptions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SGate = Object.assign(root.SGate || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'sgate-2.0';
  const DAY = 86400000;
  const BLOCKS = new Set(['ЗО', 'ЗО вр', 'ЗО сеть', '!ВНЕ_АМ-1']);
  const WEIGHTS = [0.1, 0.2, 0.3, 0.4];
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const round = v => Math.round(v * 1e6) / 1e6;
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  function dayValue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Неверная дата');
    const d = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(d) || new Date(d).toISOString().slice(0, 10) !== value) throw new Error('Неверная дата');
    return d;
  }
  const iso = value => new Date(value).toISOString().slice(0, 10);
  function today() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = key => parts.find(p => p.type === key).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function calendar(date) {
    const start = dayValue(date);
    let lead = (4 - new Date(start).getUTCDay() + 7) % 7;
    if (!lead) lead = 7;
    return { date, first: iso(start + lead * DAY), second: iso(start + (lead + 7) * DAY), lead, isThursday: new Date(start).getUTCDay() === 4 };
  }
  function parseCube(value) {
    const m = String(value || '').trim().match(/^(.+)-(\d+(?:[.,]\d+)?)$/);
    if (!m) return null;
    const level = m[2].replace(',', '.');
    if (level.length > 50) return null;
    return { family: m[1], level };
  }
  function compareDecimal(a, b) {
    const [ai, af = ''] = a.split('.'), [bi, bf = ''] = b.split('.');
    const length = Math.max(af.length, bf.length);
    const left = BigInt(ai + af.padEnd(length, '0')), right = BigInt(bi + bf.padEnd(length, '0'));
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function cubeEligibility(product) {
    if (BLOCKS.has(String(product.productCube || '').trim())) return { allowed: false, known: true, code: 'explicit_block', reason: 'Абсолютный запрет: ' + product.productCube };
    if (!product.hasStoreCube) return { allowed: false, known: false, code: 'missing_cube', reason: 'Нет колонки «КУБ»: допустимость не установлена' };
    if (!String(product.storeCube || '').trim()) return { allowed: false, known: true, code: 'closed', reason: 'Куб магазина закрыт' };
    const a = parseCube(product.productCube), b = parseCube(product.storeCube);
    if (!a || !b) return { allowed: false, known: false, code: 'unparsed', reason: 'Не удалось разобрать пару кубов' };
    if (a.family !== b.family) return { allowed: false, known: false, code: 'different_family', reason: 'Названия категорий куба не совпадают' };
    if (compareDecimal(a.level, b.level) > 0) return { allowed: false, known: true, code: 'outside', reason: `Вне куба: ${a.level} > ${b.level}` };
    return { allowed: true, known: true, code: 'inside', reason: `В кубе: ${a.level} ≤ ${b.level}` };
  }
  const labels = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  function protectedItem(p) {
    const tags = [...labels(p.commercialA), ...labels(p.commercialB), p.priceCategory];
    return tags.includes('И-индикатор') || tags.includes('И') || tags.includes('ПЦ') || p.topOnDelivery === 'ТОП-100';
  }
  function forecast(p, override = {}) {
    const sales = p.sales;
    if (!Array.isArray(sales) || sales.length !== 4 || sales.some(v => !finite(v))) throw new Error('Неверные недельные продажи');
    const raw = round(sales.reduce((s, n, i) => s + n * WEIGHTS[i], 0));
    const mask = Array.isArray(override.promoWeeks) ? override.promoWeeks : [false, false, false, false];
    let weight = 0, sum = 0;
    sales.forEach((n, i) => { if (!mask[i]) { weight += WEIGHTS[i]; sum += n * WEIGHTS[i]; } });
    const manual = override.forecast !== null && override.forecast !== undefined && override.forecast !== '';
    if (manual && (!finite(Number(override.forecast)) || Number(override.forecast) < 0)) throw new Error('Прогноз должен быть неотрицательным числом');
    const negativeHistory = sales.some((n,i) => n < 0 && !mask[i]);
    const value = manual ? Number(override.forecast) : negativeHistory ? null : weight ? round(sum / weight) : null;
    const sorted = [...sales].sort((a, b) => a - b), median = (sorted[1] + sorted[2]) / 2;
    const max = Math.max(...sales);
    // Diagnostic only. No source value or forecast is ever clipped.
    const spike = max >= Math.max(5, median * 3) && max > median;
    return { value, raw, manual, negativeHistory, excluded: mask.filter(Boolean).length, spike, sales: [...sales] };
  }
  function promoInterval(text, anchor) {
    const m = String(text || '').match(/(?:ГАЗ|А)\s+(\d{2})\.(\d{2})\s*-\s*(\d{2})\.(\d{2})/);
    if (!m) return null;
    const year = Number(anchor.slice(0, 4)), choices = [];
    for (const y of [year - 1, year, year + 1]) {
      try {
        const start = `${y}-${m[2]}-${m[1]}`;
        const endYear = Number(m[4] + m[3]) < Number(m[2] + m[1]) ? y + 1 : y;
        const end = `${endYear}-${m[4]}-${m[3]}`;
        const t = dayValue(anchor), a = dayValue(start), b = dayValue(end);
        choices.push({ start, end, distance: t < a ? a - t : t > b ? t - b : 0 });
      } catch (_) { /* invalid calendar text is not guessed */ }
    }
    return choices.sort((a, b) => a.distance - b.distance)[0] || null;
  }
  function merchFlags(p, delivery) {
    const flags = [];
    for (const tag of labels(p.merchandising)) {
      if (!/^(КОШ-|3СКЮ-|Тубус(?:-|$))/.test(tag)) continue;
      const m = tag.match(/-\((\d{2})\.(\d{2})\)$/);
      let expired = false, uncertain = false;
      if (m) {
        try {
          const end = `${delivery.slice(0, 4)}-${m[2]}-${m[1]}`;
          const diff = (dayValue(delivery) - dayValue(end)) / DAY;
          uncertain = Math.abs(diff) > 180 || diff === 0;
          expired = diff > 0 && !uncertain;
        } catch (_) { uncertain = true; }
      }
      if (!expired) flags.push({ text: tag, uncertain, reason: uncertain ? 'Проверьте год/границу срока мерчкатегории' : 'Ручной контроль мерчендайзинга' });
    }
    return flags;
  }
  function baseline(p) { return p.managerOverride !== null ? p.managerOverride : p.webRecommendation !== null ? p.webRecommendation : 0; }
  function createContext(order, settings, replacementChoices = {}) {
    const strategy = settings.strategy || 'auto', percent = Number(settings.percent || 0);
    if (!['auto','hold','increase','decrease'].includes(strategy) || !finite(percent) || percent < 0 || percent > 500 || strategy === 'decrease' && percent > 100) throw new Error('Неверная глобальная стратегия/процент');
    const cal = calendar(settings.orderDate);
    const incomingDate = settings.incomingDate || cal.first;
    if (dayValue(incomingDate) < dayValue(settings.orderDate) || new Date(dayValue(incomingDate)).getUTCDay() !== 4) throw new Error('Едущая партия должна приходить в четверг не раньше дня расчёта');
    const products = new Map(order.products.map(p => [p.sku, p]));
    const edges = new Map(), parents = new Map(), directed = new Map(), neighbors = new Map();
    const add = (oldSku, newSku) => {
      if (!oldSku || !newSku) return;
      if (!directed.has(oldSku)) directed.set(oldSku, new Set());
      directed.get(oldSku).add(newSku); // Duplicate complementary comments are one edge.
      edges.set(oldSku, newSku); parents.set(newSku, oldSku);
      for (const [a,b] of [[oldSku,newSku],[newSku,oldSku]]) {
        if (!neighbors.has(a)) neighbors.set(a,new Set());
        neighbors.get(a).add(b);
      }
    };
    for (const p of order.products) {
      const next = String(p.comment).match(/^меняется\s+на\s+([\wА-Яа-яЁё-]+)/i);
      const prev = String(p.comment).match(/^вместо\s+([\wА-Яа-яЁё-]+)/i);
      if (next) add(p.sku, next[1]);
      if (prev) add(prev[1], p.sku);
    }
    const groups = new Map(), groupBySku = new Map(), visited = new Set(), ambiguous = new Set();
    for (const start of neighbors.keys()) {
      if (visited.has(start)) continue;
      const members = [], stack = [start];
      while (stack.length) {
        const node = stack.pop(); if (visited.has(node)) continue;
        visited.add(node); members.push(node);
        for (const next of neighbors.get(node) || []) if (!visited.has(next)) stack.push(next);
      }
      members.sort();
      const links = members.flatMap(oldSku => [...(directed.get(oldSku) || [])].map(newSku => ({ oldSku,newSku })));
      const colors = new Map(); let cyclic = false;
      const visit = node => {
        const trail = [[node,false]];
        while (trail.length) {
          const [n,exit] = trail.pop();
          if (exit) { colors.set(n,2); continue; }
          if (colors.get(n) === 1) { cyclic = true; continue; }
          if (colors.get(n) === 2) continue;
          colors.set(n,1); trail.push([n,true]);
          for (const next of directed.get(n) || []) {
            if (colors.get(next) === 1) cyclic = true;
            else if (colors.get(next) !== 2) trail.push([next,false]);
          }
        }
      };
      for (const member of members) if (!colors.has(member)) visit(member);
      const id = members.join('|');
      const complex = cyclic || links.length !== 1 || members.some(sku => !products.has(sku));
      const chosen = replacementChoices[id] || null;
      if (chosen && (!complex || !members.includes(chosen) || !products.has(chosen))) throw new Error('Неверный выбор артикула в группе замен');
      const group = { id, members, links, cyclic, ambiguous: complex, chosen };
      groups.set(id,group);
      for (const member of members) { groupBySku.set(member,group); if (complex && !chosen) ambiguous.add(member); }
    }
    for (const id of Object.keys(replacementChoices)) if (!groups.has(id)) throw new Error('Неизвестная группа замен');
    return { order, settings, cal, incomingDate, products, edges, parents, ambiguous, groups, groupBySku };
  }
  function replacementGate(p, ctx) {
    const group = ctx.groupBySku.get(p.sku);
    if (!group) return { allowed:true, known:true, reason:'', group:null };
    if (group.chosen) return { allowed:group.chosen === p.sku, known:true, group,
      reason:group.chosen === p.sku ? 'Артикул для этой группы выбран вами' : `В группе выбран ${group.chosen}: одновременно не заказывать` };
    if (group.ambiguous) return { allowed:false, known:false, group,
      reason:group.cyclic ? 'Взаимная/циклическая замена в комментариях: старый артикул не определён' : 'Сложная или неполная связь замен: нужен выбор артикула' };
    const {oldSku,newSku} = group.links[0];
    if (p.sku !== newSku) return { allowed:true, known:true, reason:`Старый артикул; новый ${newSku}`, group };
    const old = ctx.products.get(oldSku), eligibility = cubeEligibility(old);
    if (!eligibility.allowed && eligibility.known && old.stock === 0) return { allowed:true, known:true, group, reason:`Замена ${oldSku}: старый запрещён, остаток 0` };
    return { allowed:false, known:eligibility.known, group, reason:`Новый вместо ${oldSku}: приоритет старого${old.stock > 0 ? ', его остаток ' + old.stock : ''}` };
  }
  function project(p, demand, quantity, ctx, incomingDate) {
    const start = dayValue(ctx.settings.orderDate), first = dayValue(ctx.cal.first), second = dayValue(ctx.cal.second);
    const incomingAt = dayValue(incomingDate || ctx.incomingDate);
    const daily = demand / 7;
    let stock = Math.max(0, p.stock), cursor = start, lost = 0, firstShortage = null;
    function advance(to) {
      const consumption = (to - cursor) / DAY * daily;
      const signed = stock - consumption;
      if (signed < -1e-8) {
        if (firstShortage === null) firstShortage = (cursor - start) / DAY + (daily ? stock / daily : 0);
        lost += -signed;
      }
      stock = Math.max(0, signed); cursor = to;
      return signed;
    }
    if (p.incoming > 0 && incomingAt <= first) { advance(incomingAt); stock += p.incoming; }
    const firstSigned = advance(first), before = stock, lostBefore = lost;
    stock += quantity;
    const after = stock;
    if (p.incoming > 0 && incomingAt > first && incomingAt < second) { advance(incomingAt); stock += p.incoming; }
    const secondSigned = advance(second);
    return { firstBefore: round(before), firstSigned: round(firstSigned), firstAfter: round(after), secondBefore: round(stock), secondSigned: round(secondSigned), lostBefore: round(lostBefore), lostAfter: round(lost - lostBefore), firstShortage, incomingDate: iso(incomingAt) };
  }
  function validCorrection(p, quantity) {
    if (!finite(quantity) || quantity < 0 || !Number.isInteger(quantity)) return 'Количество должно быть целым неотрицательным числом';
    if (quantity === 0) return null;
    if (!finite(p.batch) || p.batch <= 0 || !Number.isInteger(p.batch)) return 'Не задана допустимая кратность партии';
    if (quantity % p.batch !== 0) return `Количество должно быть кратно ${p.batch}`;
    if (quantity > p.centralStock) return `На центральном складе только ${p.centralStock}`;
    return null;
  }
  function compute(p, ctx, override = {}) {
    const cube = cubeEligibility(p), replacement = replacementGate(p, ctx);
    const fc = forecast(p, override), D = fc.value || 0, protectedStock = protectedItem(p);
    const reserve = protectedStock ? D * 0.25 : 0;
    const promo = promoInterval(p.promo, ctx.settings.orderDate);
    const older = (p.sales[0] + p.sales[1]) / 2, recent = (p.sales[2] + p.sales[3]) / 2;
    // Diagnostic only: preserve every sale; a two-week promotion can evade a single-peak check.
    const promoShift = Math.abs(older - recent) >= 5 && Math.max(older,recent) > 2 * Math.min(older,recent);
    const promoUnresolved = Boolean(p.promo) && !fc.manual && fc.excluded === 0 && (fc.spike || promoShift || !promo || (promo.start <= ctx.cal.second && promo.end >= ctx.cal.first));
    const incomingDate = override.incomingDate || ctx.incomingDate;
    if (dayValue(incomingDate) < dayValue(ctx.settings.orderDate) || new Date(dayValue(incomingDate)).getUTCDay() !== 4) throw new Error('Дата партии — четверг не раньше дня заказа');
    const zero = project(p, D, 0, ctx, incomingDate);
    const between = dayValue(incomingDate) > dayValue(ctx.cal.first) && dayValue(incomingDate) < dayValue(ctx.cal.second) ? p.incoming : 0;
    const weeks = finite(ctx.settings.coverageWeeks) ? Math.max(1, ctx.settings.coverageWeeks) : 1;
    const minimumTarget = Math.max(0, D * weeks + reserve - between);
    const mode = override.mode || ctx.settings.strategy || 'auto';
    const percent = Number(override.percent ?? ctx.settings.percent ?? 0);
    if (!finite(percent) || percent < 0 || percent > 500 || mode === 'decrease' && percent > 100) throw new Error('Процент вне допустимого диапазона');
    const explicitBase = override.baseTarget !== null && override.baseTarget !== undefined && override.baseTarget !== '';
    const baseTarget = explicitBase ? Number(override.baseTarget) : mode === 'auto' ? minimumTarget : Math.max(p.stock, minimumTarget);
    if (!finite(baseTarget) || baseTarget < 0) throw new Error('Целевой запас должен быть неотрицательным числом');
    let target = baseTarget * (mode === 'increase' ? 1 + percent / 100 : mode === 'decrease' ? 1 - percent / 100 : 1);
    target = Math.max(minimumTarget, target);
    const isNew = ['новинка', 'ин-аут', 'новинка сезонного товара'].includes(p.tradeCategory);
    if (isNew && p.stock === 0 && p.batch > 0) target = Math.max(target, p.batch);
    const needed = Math.max(0, target - zero.firstBefore);
    let quantity = p.batch > 0 ? Math.ceil(Math.max(0, needed - 1e-8) / p.batch) * p.batch : 0;
    const limited = quantity > p.centralStock;
    if (p.batch > 0) quantity = Math.min(quantity, Math.max(0, Math.floor(p.centralStock / p.batch) * p.batch));
    const source = baseline(p), sourceProjection = fc.value === null ? null : project(p,D,source,ctx,incomingDate);
    const sourceRisk = sourceProjection !== null && (sourceProjection.lostAfter > 1e-6 || sourceProjection.secondBefore < reserve - 1e-6);
    const blocked = cube.known && !cube.allowed || replacement.known && !replacement.allowed;
    const invalidBatch = needed > 0 && (!Number.isInteger(p.batch) || p.batch <= 0);
    const review = !blocked && (!cube.known || !replacement.known || p.errors.length > 0 || fc.value === null || promoUnresolved || invalidBatch);
    if (blocked) quantity = 0;
    else if (review) quantity = null;
    const warnings = [], reasons = [cube.reason];
    if (replacement.reason) reasons.push(replacement.reason);
    reasons.push(fc.manual ? `Недельный прогноз задан вручную: ${round(D)}` : `Продажи ${p.sales.join(' / ')}; веса 10/20/30/40${fc.excluded ? ', промонедели исключены вручную' : ''}; прогноз ${fc.value === null ? 'не определён' : round(D)}`);
    if (protectedStock) reasons.push(`Защищённое наличие: резерв ${round(reserve)} шт. (25% недели)`);
    if (fc.value !== null) reasons.push(`Без заказа к ${ctx.cal.first}: ${zero.firstSigned}, к ${ctx.cal.second}: ${zero.secondSigned} шт.`);
    reasons.push(`Целевой запас после поступления: база ${round(baseTarget)} → цель ${round(target)}; недостача ${round(needed)}; партия ${p.batch}`);
    reasons.push(`Исходный Web ${source} используется для сравнения, а не как норма заказа`);
    if (quantity !== null) reasons.push(`Наш заказ: ${quantity} шт.${blocked ? ' — запрет' : needed === 0 ? ' — запаса и поставок достаточно до второго четверга' : ' — по целевому запасу, кратности и доступности'}`);
    if (fc.spike) warnings.push('Есть скачок продаж. Исходные продажи не срезаны');
    if (fc.value === null) warnings.push(fc.negativeHistory ? 'Есть отрицательные продажи. Они сохранены; задайте прогноз вручную' : 'Все недели исключены как промо: задайте обычный спрос');
    if (p.promo) warnings.push('Промо: ' + p.promo);
    if (promoUnresolved) warnings.push('Нужно уточнить влияние промо: задайте прогноз или разметку недель');
    if (p.incoming > 0) reasons.push(`Уже едет ${p.incoming} шт. на ${incomingDate}; учтено один раз`);
    if (p.allocations > 0) warnings.push(`Распределения ${p.allocations} шт. показаны отдельно, к AE не прибавлены`);
    if (limited) warnings.push('Заказ ограничен центральным складом и кратностью; целевого запаса может не хватить');
    const webConflict = validCorrection(p,source);
    if (webConflict) warnings.push('В исходном Web: ' + webConflict);
    const merch = merchFlags(p,ctx.cal.first);
    if (merch.length) warnings.push('Контроль: ' + merch.map(m=>m.text).join(', '));
    if (p.priceCategory === 'У') warnings.push('Уценка: контроль без автоматического уменьшения только из-за тега');
    if (p.warnings) warnings.push('Предупреждения Web: ' + p.warnings);
    if (p.errors.length) warnings.push(...p.errors);
    if (ctx.cal.isThursday) warnings.push('День расчёта — четверг; ближайшим выбран следующий четверг');
    const projection = quantity === null || fc.value === null ? null : project(p,D,quantity,ctx,incomingDate);
    let problem = { required:false,kind:'none',severity:0,text:'' };
    if (!blocked) {
      if (!cube.known) problem = {required:true,kind:'data',severity:100,text:cube.reason};
      else if (!replacement.known) problem = {required:true,kind:'replacement',severity:95,text:replacement.reason};
      else if (p.errors.length || fc.value === null || invalidBatch) problem = {required:true,kind:'data',severity:90,text:p.errors[0] || (invalidBatch ? 'Не задана допустимая кратность партии' : 'Уточнить недельный прогноз')};
      else if (promoUnresolved) problem = {required:true,kind:'promo',severity:85,text:'Уточнить влияние промо на спрос'};
      else if (limited || projection && (projection.lostAfter > 1e-6 || projection.secondBefore < reserve - 1e-6)) problem = {required:true,kind:'supply',severity:80,text:'Склад/кратность не позволяют обеспечить целевой запас'};
      else if (projection && projection.lostBefore > 0) problem = {required:true,kind:'arrival',severity:70,text:'Дефицит до ближайшей поставки: текущий заказ не успеет'};
    }
    const control = cube.allowed && (merch.length > 0 || p.priceCategory === 'У' || fc.spike || p.allocations > 0 || Boolean(p.warnings));
    return { sku:p.sku,cube,replacement,forecast:fc,demand:fc.value,protected:protectedStock,reserve:round(reserve),baseTarget:round(baseTarget),target:round(target),needed:round(needed),quantity,autoQuantity:quantity,source,sourceProjection,sourceRisk,webConflict,limited,warnings,reasons,merch,zero,projection,mode,percent,review,blocked,problem,control,group:replacement.group,manual:false };
  }
  function validateQuantity(p, result, quantity) {
    const error = validCorrection(p,quantity);
    if (error) return error;
    if (quantity > 0 && !result.cube.allowed) return result.cube.reason;
    if (quantity > 0 && !result.replacement.allowed) return result.replacement.reason;
    if (quantity > 0 && p.errors.length) return 'Есть ошибки исходных данных: ' + p.errors.join('; ');
    return null;
  }
  function metrics(order, results, ctx) {
    let active = 0, value = 0, plannedActive = 0, plannedValue = 0, orderValue = 0, changes = 0, unresolved = 0, unprojected = 0;
    for (const p of order.products) {
      const r = results.get(p.sku), q = r.quantity;
      if (q === null) unresolved++;
      const plan = r.projection;
      if (!plan) unprojected++;

      if (p.stock > 0) active++;
      value += Math.max(0, p.stock) * p.price;
      if (plan) { if (plan.firstAfter > 0) plannedActive++; plannedValue += plan.firstAfter * p.price; }
      if (q !== null) { orderValue += q * p.price; if (q !== r.source) changes++; }
    }
    return { active, value: round(value), skuPerM2: active / 352, valuePerM2: value / 352 / 1000, plannedActive, plannedValue: round(plannedValue), orderValue: round(orderValue), unresolved, unprojected, changes, total: order.products.length };
  }
  return { VERSION, WEIGHTS, blank, finite, round, today, dayValue, calendar, parseCube, compareDecimal, cubeEligibility, labels, protectedItem, forecast, promoInterval, merchFlags, baseline, createContext, project, validCorrection, compute, validateQuantity, metrics };
});
