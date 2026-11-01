(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else Object.assign(root.SGate, factory(root.SGate));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  const FIELDS = {
    'Код': 'sku', 'Группа/Товар': 'name', 'Мерчендайзинговая категория': 'merchandising', 'Категория торговая': 'tradeCategory', 'Акции': 'promo', 'Категория цены магазина': 'priceCategory', 'Категория куб': 'productCube', 'ТОП100 на дату поставки': 'topOnDelivery', 'Мин. партия': 'batch', 'Всего Кол-во': 'centralStock', 'Себестоимость': 'cost', 'Цена магазина': 'price', 'Наценка факт': 'markup', 'Дата последней поставки': 'lastDelivery', 'История продаж (Продажи -4 недели)': 'sales0', 'История продаж (Продажи -3 недели)': 'sales1', 'История продаж (Продажи -2 недели)': 'sales2', 'История продаж (Продажи -1 неделя)': 'sales3', 'Продажи всего': 'totalSales', 'Остаток факт': 'stock', 'Запас факт': 'stockDays', 'МТЗ': 'mtz', 'КУБ': 'storeCube', 'Рек': 'webRecommendation', 'Заказ УМ': 'managerOverride', 'Заказ итого': 'webTotal', 'Запас дней (план)': 'plannedDays', 'Товар в пути': 'inTransit', 'Товар в поставке': 'incoming', 'Распределения': 'allocations', 'Необработанные заказы': 'pending', 'Дата окончания продаж': 'salesEnd', 'Дата прихода следующей партии товара (контейнера)': 'containerDate', 'Склад прихода товара': 'arrivalWarehouse', 'Комментарий': 'comment', 'Предупреждения': 'warnings'
  };
  const NUMERIC = ['batch','centralStock','cost','price','markup','sales0','sales1','sales2','sales3','totalSales','stock','stockDays','mtz','plannedDays','inTransit','incoming','allocations','pending'];
  const OPTIONAL = ['webRecommendation','managerOverride','webTotal'];
  const HEADER = ['Код','Группа/Товар','Коммерческая категория','Коммерческая категория', ...Object.keys(FIELDS).filter(h => !['Код','Группа/Товар'].includes(h))];
  const text = v => E.blank(v) ? '' : String(v).trim();
  function number(value, name, errors, allowNegative = false) {
    if (E.blank(value)) return 0;
    const s = typeof value === 'number' ? value : String(value).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
    const n = Number(s);
    if (!Number.isFinite(n) || !allowNegative && n < 0 || Math.abs(n) > 1e12) { errors.push(`Неверное число «${name}»: ${String(value).slice(0, 60)}`); return 0; }
    return n;
  }
  function parseRows(rows, metadata = {}) {
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Недопустимый размер таблицы');
    const headers = rows.filter(r => Object.values(r.cells).some(v => text(v) === 'Код') && Object.values(r.cells).some(v => text(v) === 'Группа/Товар'));
    if (headers.length !== 1) throw new Error('Не найдена единственная строка заголовков «Код / Группа/Товар»');
    const header = headers[0], mapping = Object.create(null), columns = Object.create(null);
    let commercial = 0;
    for (const [col, value] of Object.entries(header.cells)) {
      const name = text(value);
      let key = name === 'Коммерческая категория' ? ['commercialA','commercialB'][commercial++] : FIELDS[name];
      if (name === 'Коммерческая категория' && commercial > 2) throw new Error('Более двух коммерческих категорий');
      if (!key) continue;
      if (Object.hasOwn(mapping, key)) throw new Error(`Повтор заголовка «${name}»`);
      mapping[key] = col; columns[col] = name;
    }
    const required = ['sku','name','batch','centralStock','stock','price','productCube','webRecommendation','incoming','sales0','sales1','sales2','sales3'];
    const missing = required.filter(k => !mapping[k]);
    if (missing.length) throw new Error('Отсутствуют необходимые поля: ' + missing.join(', '));
    const products = [], seen = new Set(), diagnostics = [];
    let groups = 0, labelRows = 0, group = '';
    for (const r of rows) {
      if (r.number <= header.number) continue;
      const entries = Object.entries(r.cells).filter(([, v]) => !E.blank(v));
      if (!entries.length) continue;
      const read = key => r.cells[mapping[key]];
      const sku = text(read('sku')), name = text(read('name'));
      const onlyNames = entries.every(([col]) => col === mapping.sku || col === mapping.name);
      if (onlyNames && name) { if (sku) { groups++; group = name; } else labelRows++; continue; }
      if (!sku || !name) throw new Error(`Строка ${r.number}: нет артикула или названия товара`);
      if (seen.has(sku)) throw new Error(`Повтор артикула ${sku} (строка ${r.number})`);
      seen.add(sku);
      const errors = [...(r.errors || [])];
      const p = { sku, name, row: r.number, group, hasStoreCube: Boolean(mapping.storeCube), errors };
      for (const key of Object.values(FIELDS).concat(['commercialA','commercialB'])) p[key] = text(read(key));
      for (const key of NUMERIC) p[key] = number(read(key), columns[mapping[key]] || key, errors, ['markup','sales0','sales1','sales2','sales3','totalSales','stockDays','plannedDays'].includes(key));
      for (const key of OPTIONAL) p[key] = E.blank(read(key)) ? null : number(read(key), columns[mapping[key]] || key, errors);
      p.sales = [p.sales0,p.sales1,p.sales2,p.sales3];
      for (const key of ['stock','batch','centralStock','incoming',...OPTIONAL]) if (p[key] !== null && !Number.isInteger(p[key])) errors.push(`Дробное количество «${key}»`);
      if (p.batch <= 0) errors.push('Кратность партии должна быть больше нуля');
      if (Math.abs(p.sales.reduce((a,b) => a+b, 0) - p.totalSales) > 1e-6 && mapping.totalSales) diagnostics.push(`Строка ${r.number}: сумма недель не совпадает с продажами всего`);
      products.push(p);
    }
    if (!products.length) throw new Error('В файле нет товарных строк');
    const headerText = rows.filter(r => r.number < header.number).flatMap(r => Object.values(r.cells)).map(text).join(' ');
    const dm = headerText.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
    let createdDate = '';
    if (dm) { try { createdDate = `${dm[3]}-${dm[2]}-${dm[1]}`; E.dayValue(createdDate); } catch (_) { createdDate = ''; } }
    return { products, metadata: { ...metadata, createdDate, orderNumber: (headerText.match(/[БB]-\d+/) || [''])[0], headerRow: header.number, groups, labelRows, productCount: products.length, columns: mapping, hasStoreCube: Boolean(mapping.storeCube), diagnostics }, rows };
  }
  function workbookRows(workbook) {
    if (!workbook || workbook.SheetNames.length !== 1) throw new Error('Нужен Excel с одним листом заказа');
    const sheet = workbook.Sheets[workbook.SheetNames[0]], map = new Map();
    // Iterate actual cells: dimension/!ref in these exports may be A1 or A1:AK1048576.
    for (const [address, cell] of Object.entries(sheet)) {
      const m = address.match(/^([A-Z]+)(\d+)$/);
      if (!m || !cell || E.blank(cell.v) && !cell.f && cell.t !== 'e') continue;
      const n = Number(m[2]);
      if (!map.has(n)) map.set(n, { number: n, cells: Object.create(null), errors: [] });
      const row = map.get(n);
      if (cell.f) row.errors.push(`Формула в ${address}: нужен экспорт значений`);
      if (cell.t === 'e') row.errors.push(`Ошибка Excel в ${address}`);
      row.cells[m[1]] = cell.v === undefined ? '' : cell.v;
    }
    return [...map.values()].sort((a,b) => a.number-b.number);
  }
  function parseWorkbook(workbook, metadata) { return parseRows(workbookRows(workbook), { ...metadata, sheetName: workbook.SheetNames[0] }); }
  return { FIELDS, HEADER, parseRows, workbookRows, parseWorkbook };
});
