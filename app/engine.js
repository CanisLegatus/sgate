/* sgate: pure order rules. No I/O, DOM or hidden per-SKU exceptions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SGate = Object.assign(root.SGate || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'sgate-1.0';
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
  function createContext(order, settings) {
    const cal = calendar(settings.orderDate);
    const incomingDate = settings.incomingDate || cal.first;
    if (dayValue(incomingDate) < dayValue(settings.orderDate) || new Date(dayValue(incomingDate)).getUTCDay() !== 4) throw new Error('Едущая партия должна приходить в четверг не раньше дня расчёта');
    const products = new Map(order.products.map(p => [p.sku, p]));
    const edges = new Map(), parents = new Map(), ambiguous = new Set();
    const add = (oldSku, newSku) => {
      if (!oldSku || !newSku || oldSku === newSku) { ambiguous.add(oldSku); return; }
      if (edges.has(oldSku) && edges.get(oldSku) !== newSku) ambiguous.add(oldSku);
      if (parents.has(newSku) && parents.get(newSku) !== oldSku) ambiguous.add(newSku);
      edges.set(oldSku, newSku); parents.set(newSku, oldSku);
    };
    for (const p of order.products) {
      const next = String(p.comment).match(/^меняется\s+на\s+([\wА-Яа-яЁё-]+)/i);
      const prev = String(p.comment).match(/^вместо\s+([\wА-Яа-яЁё-]+)/i);
      if (next) add(p.sku, next[1]);
      if (prev) add(prev[1], p.sku);
    }
    for (const [oldSku, newSku] of edges) {
      if (edges.has(newSku) || parents.has(oldSku)) { ambiguous.add(oldSku); ambiguous.add(newSku); }
    }
    return { order, settings, cal, incomingDate, products, edges, parents, ambiguous };
  }
  function replacementGate(p, ctx) {
    const oldSku = ctx.parents.get(p.sku);
    if (ctx.ambiguous.has(p.sku)) return { allowed: false, known: false, reason: 'Цепочка или неоднозначная замена: нужен ручной разбор' };
    if (!oldSku) return { allowed: true, known: true, reason: '' };
    const old = ctx.products.get(oldSku);
    if (!old) return { allowed: false, known: false, reason: `Старый ${oldSku} отсутствует в файле: связь требует проверки` };
    const eligibility = cubeEligibility(old);
    if (!eligibility.allowed && eligibility.known && old.stock === 0) return { allowed: true, known: true, reason: `Замена ${oldSku}: старый запрещён, остаток 0` };
    return { allowed: false, known: eligibility.known, reason: `Новый вместо ${oldSku}: приоритет старого${old.stock > 0 ? ', его остаток ' + old.stock : ''}` };
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
    const promoUnresolved = Boolean(p.promo) && !fc.manual && fc.excluded === 0;
    const incomingDate = override.incomingDate || ctx.incomingDate;
    if (dayValue(incomingDate) < dayValue(ctx.settings.orderDate) || new Date(dayValue(incomingDate)).getUTCDay() !== 4) throw new Error('Дата партии — четверг не раньше дня заказа');
    const zero = project(p, D, 0, ctx, incomingDate);
    const between = dayValue(incomingDate) > dayValue(ctx.cal.first) && dayValue(incomingDate) < dayValue(ctx.cal.second) ? p.incoming : 0;
    const weeks = finite(ctx.settings.coverageWeeks) ? Math.max(1, ctx.settings.coverageWeeks) : 1;
    const minimumTarget = Math.max(0, D * weeks + reserve - between);
    const mode = ['auto', 'hold', 'increase', 'decrease'].includes(override.mode) ? override.mode : 'auto';
    const percent = Number(override.percent || 0);
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
    if (!cube.allowed || !replacement.allowed || p.errors.length || fc.value === null || promoUnresolved) quantity = 0;
    const warnings = [], reasons = [];
    if (!cube.allowed) reasons.push(cube.reason);
    else reasons.push(cube.reason);
    if (replacement.reason) reasons.push(replacement.reason);
    if (fc.manual) reasons.push(`Недельный прогноз задан вручную: ${round(D)}`);
    else reasons.push(`Прогноз: ${p.sales.join(' / ')} × веса 10/20/30/40${fc.excluded ? ', промонедели исключены вручную' : ''} = ${round(D)}`);
    if (protectedStock) reasons.push(`Защищённое наличие, резерв ${round(reserve)} шт. (25% недели)`);
    reasons.push(`Без заказа к ${ctx.cal.first}: ${zero.firstSigned}, к ${ctx.cal.second}: ${zero.secondSigned} шт. (расчётный остаток)`);
    if (zero.lostBefore > 0) warnings.push(`До ближайшего поступления ожидается дефицит ${zero.lostBefore} шт.; новый заказ приедет позже`);
    if (fc.spike) warnings.push('Есть скачок продаж. Ничего не срезано: проверьте причину');
    if (fc.value === null) warnings.push(fc.negativeHistory ? 'Есть отрицательные продажи в исходных неделях. Они сохранены; задайте прогноз вручную, смысл отрицательных значений не установлен' : 'Все недели исключены как промо: задайте обычный спрос вручную');
    if (p.promo) warnings.push('Промо: ' + p.promo + '. Недели не размечены автоматически; проверьте обычный и промоспрос');
    if (promoUnresolved) warnings.push('Автопредложение по промо отложено: задайте прогноз/промонедели или собственное количество. Исходное можно оставить явным решением');
    if (p.incoming > 0) reasons.push(`Уже едет ${p.incoming} шт. на ${incomingDate}; учтено один раз. Дату можно изменить`);
    if (p.allocations > 0) warnings.push(`Распределения ${p.allocations} шт. показаны отдельно, в AE не добавлены`);
    if (limited) warnings.push('Потребность выше доступного количества, заказ ограничен складом и кратностью');
    const source = baseline(p), webConflict = validCorrection(p, source);
    if (webConflict) warnings.push('Исходное количество Web: ' + webConflict + '. При согласии его можно оставить');
    if (p.batch <= 0) warnings.push('Нулевая/неверная кратность: положительная корректировка невозможна');
    if (ctx.cal.isThursday) warnings.push('Расчёт открыт в четверг: ближайшей выбрана следующая неделя. Проверьте календарь');
    const merch = merchFlags(p, ctx.cal.first);
    if (merch.length) warnings.push('Ручной контроль: ' + merch.map(m => m.text).join(', '));
    if (p.priceCategory === 'У') warnings.push('Уценка: ручной контроль, количество автоматически не уменьшается');
    if (p.warnings) warnings.push('Предупреждения Web: ' + p.warnings);
    if (p.errors.length) warnings.push(...p.errors);
    if (p.mtz > 0) reasons.push(`МТЗ ${p.mtz} показано справочно, в количество не добавлено`);
    if (cube.allowed && replacement.allowed) reasons.push(`Цель перед продажами после поступления: ${round(target)}, не хватает ${round(needed)}, предложение ${quantity} с партией ${p.batch}`);
    const signature = JSON.stringify([VERSION, ctx.settings.orderDate, ctx.settings.coverageWeeks, ctx.incomingDate, override, p.sku]);
    const review = !cube.known || !replacement.known || p.errors.length > 0 || fc.value === null || promoUnresolved;
    return { sku: p.sku, cube, replacement, forecast: fc, demand: D, protected: protectedStock, reserve: round(reserve), baseTarget: round(baseTarget), target: round(target), needed: round(needed), quantity, source, webConflict, limited, warnings, reasons, merch, zero, projection: project(p, D, quantity, ctx, incomingDate), mode, signature, review, blocked: cube.known && !cube.allowed || replacement.known && !replacement.allowed };
  }
  function checkDecision(p, result, kind, quantity, ctx, decisions) {
    const q = kind === 'keep' ? result.source : Number(quantity);
    if (!finite(q) || !Number.isInteger(q) || q < 0) return 'Неверное количество';
    if (q > 0 && (!result.cube.allowed || !result.replacement.allowed)) return result.cube.allowed ? result.replacement.reason : result.cube.reason;
    if (q > 0 && p.errors.length) return 'Исправьте ошибки исходных данных перед положительным решением';
    if (kind !== 'keep') {
      const error = validCorrection(p, q);
      if (error) return error;
    }
    if (q > 0) {
      for (const otherSku of [ctx.edges.get(p.sku), ctx.parents.get(p.sku)].filter(Boolean)) {
        const other = ctx.products.get(otherSku);
        if (!other) continue;
        const decision = decisions[otherSku];
        const otherQuantity = decision ? decision.quantity : baseline(other);
        if (otherQuantity > 0) return `В паре замен уже остаётся ${otherSku} (${otherQuantity} шт.). Сначала согласуйте для него 0`;
      }
    }
    return null;
  }
  function effective(p, result, decision) {
    return decision && decision.signature === result.signature ? decision.quantity : result.source;
  }
  function metrics(order, results, decisions, ctx) {
    let active = 0, value = 0, plannedActive = 0, plannedValue = 0, orderValue = 0, approved = 0, changes = 0;
    for (const p of order.products) {
      const r = results.get(p.sku), d = decisions[p.sku];
      const q = effective(p, r, d), plan = project(p, r.demand, q, ctx, r.zero.incomingDate);
      if (p.stock > 0) active++;
      value += Math.max(0, p.stock) * p.price;
      if (plan.firstAfter > 0) plannedActive++;
      plannedValue += plan.firstAfter * p.price;
      orderValue += q * p.price;
      if (d && d.signature === r.signature) { approved++; if (d.kind === 'apply' && q !== r.source) changes++; }
    }
    return { active, value: round(value), skuPerM2: active / 352, valuePerM2: value / 352 / 1000, plannedActive, plannedValue: round(plannedValue), orderValue: round(orderValue), approved, changes, total: order.products.length };
  }
  return { VERSION, WEIGHTS, blank, finite, round, today, dayValue, calendar, parseCube, compareDecimal, cubeEligibility, labels, protectedItem, forecast, promoInterval, merchFlags, baseline, createContext, project, validCorrection, compute, checkDecision, effective, metrics };
});
