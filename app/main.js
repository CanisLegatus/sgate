(function () {
  'use strict';
  const E = window.SGate;
  const $ = id => document.getElementById(id);
  const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const precise = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const esc = value => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const f = value => Number.isFinite(value) ? nf.format(value) : '—';
  const date = value => { try { return new Intl.DateTimeFormat('ru-RU', { day:'2-digit', month:'short', timeZone:'UTC' }).format(new Date(E.dayValue(value))); } catch (_) { return value; } };
  let state = null, calculated = null, selected = null, filter = 'pending', query = '', sort = 'priority', page = 0;
  let defaultDateIsManual = false;
  let defaults = E.defaultSettings(), toastTimer, searchTimer, storageWarning = false;
  const PAGE_SIZE = 75;
  function toast(message, error = false) {
    $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4000);
  }
  function fail(error) { console.error(error); toast(error.message || String(error), true); }
  function busy(value) { $('busy').hidden = !value; }
  const nextPaint = () => new Promise(resolve => setTimeout(resolve, 30));
  function storageKey() { return 'sgate.v1.' + state.order.metadata.fingerprint; }
  function persist() {
    if (!state) return;
    try { localStorage.setItem(storageKey(), JSON.stringify(E.localPayload(state))); }
    catch (_) { if (!storageWarning) { storageWarning = true; toast('Браузер не сохраняет решения. Используйте «Сохранить сессию»', true); } }
  }
  function recalculate() {
    calculated = E.calculate(state);
    if (calculated.invalidated) toast(`Пересчитано: подтверждения ${calculated.invalidated} товаров сняты из-за изменения параметров`);
    persist(); render();
  }
  function approved(p) { const d = state.decisions[p.sku]; return d && d.signature === calculated.results.get(p.sku).signature; }
  function priority(p) {
    const r = calculated.results.get(p.sku);
    return (approved(p) ? 0 : 100000) + (r.review ? 20000 : 0) + (r.zero.lostBefore + r.zero.lostAfter > 0 ? 10000 : 0) + (r.blocked && r.source > 0 ? 8000 : 0) + (p.promo ? 3000 : 0) + (r.protected ? 1500 : 0) + Math.min(1000, Math.abs(r.quantity - r.source));
  }
  const filterDefinitions = [
    ['pending','Не проверены',(p,r) => !approved(p)],
    ['changes','Предлагаем изменить',(p,r) => r.quantity !== r.source],
    ['risk','Риск дефицита',(p,r) => r.zero.lostBefore + r.zero.lostAfter > 0 || r.zero.secondBefore < r.reserve],
    ['review','Проверить',(p,r) => r.review || r.warnings.length > 0],
    ['protected','ПЦ / индикаторы / ТОП',(p,r) => r.protected],
    ['blocked','Запреты',(p,r) => !r.cube.allowed],
    ['approved','Согласованы',(p,r) => approved(p)],
    ['all','Все товары',() => true]
  ];
  function list() {
    const predicate = filterDefinitions.find(v => v[0] === filter)[2];
    const terms = query.toLocaleLowerCase('ru-RU').split(/\s+/).filter(Boolean);
    const rows = state.order.products.filter(p => {
      const r = calculated.results.get(p.sku);
      return predicate(p,r) && (!terms.length || terms.every(t => [p.sku,p.name,p.group,p.productCube,p.tradeCategory,p.commercialA,p.commercialB].join(' ').toLocaleLowerCase('ru-RU').includes(t)));
    });
    rows.sort((a,b) => sort === 'sku' ? a.sku.localeCompare(b.sku) : sort === 'delta' ? Math.abs(calculated.results.get(b.sku).quantity - E.baseline(b)) - Math.abs(calculated.results.get(a.sku).quantity - E.baseline(a)) || a.row-b.row : priority(b)-priority(a) || a.row-b.row);
    return rows;
  }
  function renderMetrics() {
    const m = E.metrics(state.order, calculated.results, state.decisions, calculated.ctx);
    calculated.metrics = m;
    const cards = [
      ['СОГЛАСОВАНО',`${money.format(m.approved)} <span style="font-size:13px;opacity:.6">/ ${money.format(m.total)}</span>`,`${m.changes} корректировок для переноса`],
      ['SKU НА М²',precise.format(m.skuPerM2),`${money.format(m.active)} SKU в наличии · 352 м²`],
      ['ТЫС. ₽ НА М²',precise.format(m.valuePerM2),'В розничных ценах · не норматив'],
      ['ЗАПАС СЕЙЧАС',`${precise.format(m.value/1e6)} <span style="font-size:13px">млн ₽</span>`,`После поступления: ${precise.format(m.plannedValue/1e6)} млн ₽*`],
      ['ПРОЕКТ ЗАКАЗА',`${money.format(m.orderValue)} <span style="font-size:13px">₽</span>`,'С учётом непросмотренных Web-позиций*']
    ];
    $('metrics').innerHTML = cards.map(([label,value,note]) => `<div class="metric"><div class="label">${label}</div><div class="number">${value}</div><small>${esc(note)}</small></div>`).join('');
  }
  function renderTable() {
    const rows = list(), pages = Math.max(1, Math.ceil(rows.length/PAGE_SIZE));
    page = Math.max(0, Math.min(page, pages-1));
    const current = rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
    $('list-summary').textContent = `${money.format(rows.length)} товаров в выборке`;
    $('page-label').textContent = rows.length ? `${page*PAGE_SIZE+1}–${Math.min((page+1)*PAGE_SIZE,rows.length)} из ${money.format(rows.length)}` : 'Нет товаров по выбранным условиям';
    $('prev-page').disabled = page === 0; $('next-page').disabled = page >= pages-1;
    $('product-rows').innerHTML = current.map(p => {
      const r = calculated.results.get(p.sku), d = approved(p) ? state.decisions[p.sku] : null;
      const max = Math.max(1,...p.sales);
      const tags = [!r.cube.allowed ? `<span class="tag red">${r.cube.known?'Запрет':'Допуск неизвестен'}</span>` : '',r.protected?'<span class="tag green">Защита наличия</span>':'',p.promo?'<span class="tag orange">Промо</span>':'',r.webConflict?'<span class="tag orange">Конфликт Web</span>':''].join('');
      const status = d ? `<span class="status approved">✓ ${d.kind==='keep'?'Исходный':f(d.quantity)+' шт.'}</span>` : `<span class="status ${r.review?'review':'pending'}">${r.review?'Нужен разбор':'Не проверен'} →</span>`;
      return `<tr data-sku="${esc(p.sku)}" tabindex="0" aria-label="Открыть ${esc(p.sku)}" class="${selected===p.sku?'selected':''}"><td><span class="sku">${esc(p.sku)}</span><span class="product-name">${esc(p.name)}</span><div class="tags">${tags}</div></td><td><div class="sales-mini">${p.sales.map(n=>`<span style="height:${Math.max(2,n/max*25)}px"></span>`).join('')}</div><div class="sales-values">${p.sales.map(f).join(' / ')}</div></td><td><span class="qty">${f(r.demand)}</span></td><td class="stock-cell"><span class="qty">${f(p.stock)}</span><small>едет ${f(p.incoming)}</small></td><td><span class="qty cross">${f(r.source)}</span>${p.managerOverride!==null?'<small class="sku">есть ввод УМ</small>':''}</td><td><span class="qty proposed">${r.review?'—':f(r.quantity)}</span><small class="sku">${esc({auto:'По потребности',hold:'Держим',increase:'Увеличиваем',decrease:'Уменьшаем'}[r.mode])}</small></td><td>${status}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty-row">Здесь пока нет товаров. Измените фильтр или поисковый запрос.</td></tr>';
  }
  function render() {
    if (!state) return;
    $('welcome').hidden = true; $('workspace').hidden = false;
    const meta = state.order.metadata, cal = calculated.ctx.cal;
    $('source-label').textContent = `${meta.name || 'Заказ'}${meta.orderNumber?' · '+meta.orderNumber:''} · ${money.format(state.order.products.length)} товаров${meta.demo?' · демо':''}`;
    const notices = [];
    if (state.settings.orderDate !== E.today()) notices.push(`Историческая дата расчёта ${state.settings.orderDate}; сегодня ${E.today()}.`);
    if (meta.demo) notices.push('Демонстрационные данные. Они не относятся к вашему магазину.');
    if (meta.createdDate && meta.createdDate !== state.settings.orderDate) notices.push(`Выгрузка от ${meta.createdDate}, расчёт на ${state.settings.orderDate}. Для рабочего заказа нужен свежий файл; для исторического разбора измените дату в настройках.`);
    if (!meta.hasStoreCube) notices.push('В файле нет «КУБ» магазина. Положительные решения заблокированы до загрузки полной новой выгрузки.');
    if (meta.diagnostics.length) notices.push(`${meta.diagnostics.length} замечаний к сумме недель; проверьте исходную выгрузку.`);
    $('notice').hidden = !notices.length; $('notice').textContent = notices.join(' ');
    $('schedule').innerHTML = `<span>Заказ <strong>${esc(date(state.settings.orderDate))}</strong></span><span class="arrow">→</span><span>Поступление <strong>${esc(date(cal.first))}</strong></span><span class="arrow">→</span><span>Проверяем до <strong>${esc(date(cal.second))}</strong></span><span>· ${cal.lead} + 7 дней</span>`;
    $('table-count').textContent = money.format(state.order.products.length);
    renderMetrics();
    $('filters').innerHTML = filterDefinitions.map(([key,label,predicate]) => `<button class="filter ${key===filter?'active':''}" data-filter="${key}" aria-pressed="${key===filter}">${esc(label)}<span>${money.format(state.order.products.filter(p=>predicate(p,calculated.results.get(p.sku))).length)}</span></button>`).join('');
    renderTable();
    if (selected) renderDrawer();
  }
  function renderDrawer() {
    const p = calculated.ctx.products.get(selected);
    if (!p) return closeDrawer();
    const r = calculated.results.get(selected), ov = state.overrides[selected] || {}, d = approved(p) ? state.decisions[selected] : null;
    const previewQ = d ? d.quantity : r.quantity;
    const plan = E.project(p,r.demand,previewQ,calculated.ctx,r.zero.incomingDate);
    const tags = `<span class="tag ${r.cube.allowed?'green':'red'}">${esc(r.cube.reason)}</span>${r.protected?'<span class="tag green">Защита +25%</span>':''}`;
    const keepError = E.checkDecision(p,r,'keep',r.source,calculated.ctx,state.decisions);
    const fields = [ ['Куб товара',p.productCube],['Куб магазина',p.storeCube || '(пусто)'],['Коммерческая категория C',p.commercialA],['Коммерческая категория D',p.commercialB],['Торговая категория',p.tradeCategory],['Мерчкатегория',p.merchandising],['Цена магазина',f(p.price)+' ₽'],['Себестоимость',f(p.cost)+' ₽'],['ТОП на поставку',p.topOnDelivery],['Категория цены',p.priceCategory],['МТЗ (справочно)',p.mtz],['Запас дней Web сейчас',p.stockDays],['Запас дней Web план',p.plannedDays],['Товар в пути (AD)',p.inTransit],['Распределения (AF)',p.allocations],['Необработанные (AG)',p.pending],['Комментарий',p.comment],['Предупреждения Web',p.warnings],['Строка Excel',p.row] ];
    $('drawer').innerHTML = `<div class="drawer-header"><span class="eyebrow">${esc(p.sku)} · ${esc(p.group || 'Товар')}</span><button id="close-drawer" class="icon-button" aria-label="Закрыть карточку">×</button><h2>${esc(p.name)}</h2><div class="tags">${tags}</div></div><div class="drawer-body"><div class="detail-stats"><div><span>В магазине</span><strong>${f(p.stock)}</strong></div><div><span>Уже едет</span><strong>${f(p.incoming)}</strong></div><div><span>Партия</span><strong>${f(p.batch)}</strong></div><div><span>Центр. склад</span><strong>${f(p.centralStock)}</strong></div></div><div class="detail-section"><h3>Запас по выбранному решению · ${f(previewQ)} шт.</h3><div class="trajectory"><div><small>Сегодня</small><strong>${f(p.stock)}</strong><span>${esc(date(state.settings.orderDate))}</span></div><div><small>После поступления</small><strong>${f(plan.firstAfter)}</strong><span>${esc(date(calculated.ctx.cal.first))}</span></div><div><small>Перед следующим</small><strong style="${plan.secondSigned<0?'color:var(--red)':''}">${f(plan.secondSigned)}</strong><span>${esc(date(calculated.ctx.cal.second))}</span></div></div><p class="muted" style="font-size:10px;margin-top:7px">Без нового заказа: ${f(r.zero.firstSigned)} → ${f(r.zero.secondSigned)}. Минус означает неудовлетворённый спрос, физический остаток — 0.</p></div>${r.warnings.length?`<div class="warning-list">${r.warnings.map(w=>`<p>• ${esc(w)}</p>`).join('')}</div>`:''}<div class="detail-section"><h3>Стратегия и целевой запас</h3><form id="strategy-form" class="strategy-form"><div class="form-grid"><label>Стратегия<select name="mode">${[['auto','По потребности'],['hold','Держим сток'],['increase','Увеличиваем'],['decrease','Уменьшаем']].map(([v,l])=>`<option value="${v}" ${(ov.mode||'auto')===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Изменение цели, %<input name="percent" type="number" min="0" max="500" step="1" value="${esc(ov.percent||0)}"></label></div><div class="form-grid"><label>Базовая цель, шт.<input name="baseTarget" type="number" min="0" step="0.1" placeholder="Авто: ${f(r.baseTarget)}" value="${ov.baseTarget===null||ov.baseTarget===undefined?'':esc(ov.baseTarget)}"><small>Процент применяется к этой базе. Пусто — стартовая формула приложения, не утверждённая универсальная норма.</small></label><label>Прогноз, шт./нед.<input name="forecast" type="number" min="0" step="0.1" placeholder="По весам: ${f(r.forecast.raw)}" value="${ov.forecast===null||ov.forecast===undefined?'':esc(ov.forecast)}"><small>Ручная оценка заменяет взвешенный прогноз только для этого товара.</small></label></div><label>Продажи −4 / −3 / −2 / −1<span class="sales-values" style="display:block;margin:6px 0">${p.sales.map(f).join(' / ')}</span></label><div><label>Промонедели для исключения из обычного спроса</label><div class="promo-checks" style="margin-top:8px">${[0,1,2,3].map(i=>`<label><input name="promo${i}" type="checkbox" ${(ov.promoWeeks||[])[i]?'checked':''}>−${4-i}</label>`).join('')}</div><small class="muted" style="font-size:9px">Размечайте по известным датам акции. Границы недель не угадываются.</small></div>${p.incoming>0?`<label>Дата едущей партии<input name="incomingDate" type="date" value="${esc(r.zero.incomingDate)}"><small>Все поставки по четвергам; текущая дата — допущение, проверьте её.</small></label>`:''}<div class="info-note">Стартовая формула: «по потребности» — недельное покрытие + резерв для защищённых; для других стратегий авто-база — не меньше текущего остатка. Цель не опускается ниже покрытия. Можете задать базу вручную. Очистка пиков выключена.</div><button type="submit" class="button">Пересчитать предложение</button></form><p class="muted" style="margin-top:10px;font-size:10px">База ${f(r.baseTarget)} → цель ${f(r.target)} → потребность ${f(r.needed)} → партия ${f(r.quantity)}.</p></div><div class="detail-section"><h3>Почему такое предложение</h3><ul class="explanation">${r.reasons.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div><div class="decision-panel"><div class="decision-actions"><button class="button" id="keep-source" ${keepError?'disabled':''} title="${esc(keepError||'Не создаёт ручной корректировки')}">Оставить исходный · ${f(r.source)}</button><button class="button primary" id="apply-proposal" ${r.review?'disabled title="Уточните условия расчёта; при необходимости введите собственное количество"':''}>Принять · ${f(r.quantity)}</button></div><form id="manual-form" class="manual-form" novalidate><label>Своя корректировка, шт.<input name="quantity" type="number" min="0" step="${p.batch||1}" value="${f(previewQ).replace(/[\s\u00a0]/g,'').replace(',','.')}" required></label><button type="submit" class="button">Применить</button></form>${keepError?`<p class="muted" style="font-size:10px;margin-top:8px">Оставить положительный исходный нельзя: ${esc(keepError)}</p>`:''}${d?`<p class="status approved" style="margin-top:12px">✓ Согласовано: ${d.kind==='keep'?'оставить исходный':f(d.quantity)+' шт.'}</p><button id="reset-decision" class="text-button">Снять подтверждение</button>`:''}</div><details class="source-data"><summary>Все исходные показатели</summary><dl>${fields.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v===''?'—':v)}</dd>`).join('')}</dl></details></div>`;
    $('drawer').hidden = false; $('drawer-shade').hidden = false;
  }
  function openDrawer(sku) { selected = sku; renderTable(); renderDrawer(); $('close-drawer').focus(); }
  function closeDrawer() { selected = null; $('drawer').hidden = true; $('drawer-shade').hidden = true; if(state) renderTable(); }
  function setDecision(kind, quantity) {
    try { E.decide(state,calculated,selected,kind,quantity); persist(); render(); toast('Решение сохранено'); }
    catch(error) { fail(error); }
  }
  async function fingerprint(buffer) {
    if (globalThis.crypto && crypto.subtle) return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))).map(n=>n.toString(16).padStart(2,'0')).join('');
    // Local lookup fallback for old file:// browsers, not a security checksum.
    let a=2166136261,b=0; for(const byte of new Uint8Array(buffer)){a=Math.imul(a^byte,16777619);b=(b+byte)>>>0;}
    return 'local-'+(a>>>0).toString(16)+'-'+b.toString(16)+'-'+buffer.byteLength;
  }
  async function loadExcel(file) {
    if (!file) return;
    busy(true);
    try {
      if (file.size > 40*1024*1024) throw new Error('Файл больше 40 МБ. Используйте выгрузку без лишних листов');
      await nextPaint();
      const buffer = await file.arrayBuffer(), hash = await fingerprint(buffer);
      const wb = XLSX.read(buffer,{type:'array',cellDates:false,cellFormula:true,nodim:true});
      const order = E.parseWorkbook(wb,{name:file.name,fingerprint:hash});
      const fresh = E.newSession(order, defaultDateIsManual ? {...defaults} : E.defaultSettings());
      let restored = null;
      try { const stored=localStorage.getItem('sgate.v1.'+hash); if(stored) restored=E.restorePayload(order,JSON.parse(stored),false); }
      catch (_) { toast('Предыдущее автосохранение не подошло: исходные данные загружены заново',true); }
      state = restored || fresh; selected=null; page=0; filter='pending';query='';$('search').value='';
      recalculate(); toast(restored?'Заказ загружен, настройки восстановлены. Подтверждения другой даты сняты':'Заказ загружен: '+money.format(order.products.length)+' товаров');
    } catch(error) { fail(error); }
    finally { busy(false); $('file-input').value=''; }
  }
  function download(name, data, type) {
    const blob = new Blob([data],{type}), url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function saveSession() {
    if (!state) return;
    download('sgate-session-'+state.settings.orderDate+'.json',JSON.stringify(E.snapshot(state)), 'application/json');toast('Сессия выгружена: храните её рядом с исходным заказом');
  }
  function openSettings() {
    const config=state?state.settings:defaults,form=$('settings-form');
    for(const key of ['orderDate','incomingDate','coverageWeeks']) form.elements[key].value=config[key];
    $('settings-dialog').showModal();
  }
  function exportRows() {
    const changes=E.changeRows(state,calculated);
    return [['Артикул','Товар','Было','Заказ УМ (ввести)','Стратегия','Обоснование'],...changes.map(c=>[c.sku,c.name,c.source,c.quantity,c.strategy,c.reason])];
  }
  function openExport() {
    try {
      const rows=E.changeRows(state,calculated),m=calculated.metrics;
      $('export-summary').innerHTML=`<p><strong>${rows.length}</strong> подтверждённых изменений для ввода.</p><p class="muted">Согласовано ${m.approved} из ${m.total}. Непросмотренные товары не входят в список корректировок и сохраняют исходные количества.</p>`;
      $('export-csv').disabled=!rows.length;
      $('export-dialog').showModal();
    } catch(error){fail(error);}
  }
  function exportXLSX() {
    try {
      const wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(exportRows()),'Изменения для ввода');
      const audit=[['Артикул','Товар','Стратегия','Прогноз в неделю','Остаток','Едет','Исходный','Предложено','Согласовано','Действие','Куб товара','Куб магазина','Замечания']];
      for(const p of state.order.products){const r=calculated.results.get(p.sku),d=approved(p)?state.decisions[p.sku]:null;audit.push([p.sku,p.name,r.mode,r.demand,p.stock,p.incoming,r.source,r.quantity,d?d.quantity:'',d?d.kind:'не проверен',p.productCube,p.storeCube,r.warnings.join('; ')]);}
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(audit),'Проверка заказа');
      const meta=[['Дата расчёта',state.settings.orderDate],['Ближайшая поставка',calculated.ctx.cal.first],['Проверка до',calculated.ctx.cal.second],['Источник',state.order.metadata.name],['Отпечаток',state.order.metadata.fingerprint],['Версия правил',E.VERSION],['Веса недель','10 / 20 / 30 / 40%'],['Примечание','Только подтверждённые изменения переносятся вручную. Отправка логистам — человеком.']];
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(meta),'Параметры');
      download('sgate-review-'+state.settings.orderDate+'.xlsx',XLSX.write(wb,{bookType:'xlsx',type:'array',compression:true}),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }catch(error){fail(error);}
  }
  function demo() {
    const headers=E.HEADER, rows=[{number:1,cells:{A:'Демонстрационный заказ '+E.today().split('-').reverse().join('.')}},{number:7,cells:Object.fromEntries(headers.map((h,i)=>[XLSX.utils.encode_col(i),h]))}];
    const examples=[
      ['D-001','Бронзовые поросята · вне куба','Декор-0,8','Декор-0.5',[8,9,10,8],5,4,100,12,''],
      ['D-002','Стаканы стеклянные · ПЦ','Посуда-0,2','Посуда-0.5',[35,40,38,45],70,12,1000,60,'ПЦ'],
      ['D-003','Свеча ароматическая','Декор-0,1','Декор-0.5',[6,4,3,1],13,8,300,8,''],
      ['D-004','Полотенце хлопковое · едет партия','Текстиль-0,2','Текстиль-0.5',[9,8,4,5],38,12,500,0,''],
      ['D-005','Набор открыток · единичный пик','Подарки-0,1','Подарки-0.5',[4,5,40,5],8,6,500,12,''],
      ['D-006','Чашка керамическая · закрытый куб','Посуда-0,1','',[2,2,1,3],5,6,300,0,''],
      ['D-007','Жевательные конфеты · пример Web','Еда-0,1','Еда-0.5',[25,12,23,15],76,24,1000,24,'']
    ];
    examples.forEach((e,i)=>{
      const [sku,name,pc,sc,sales,stock,k,l,web,priceCat]=e;
      const values={'Код':sku,'Группа/Товар':name,'Категория куб':pc,'КУБ':sc,'Категория торговая':'основной ассортимент','Категория цены магазина':priceCat,'Мин. партия':k,'Всего Кол-во':l,'Цена магазина':100+i*30,'Себестоимость':50,'Остаток факт':stock,'Рек':web,'Заказ итого':web,'Продажи всего':sales.reduce((a,b)=>a+b,0),'Товар в поставке':i===3?36:0};
      for(let j=0;j<4;j++)values[`История продаж (Продажи -${4-j} ${j===3?"неделя":"недели"})`]=sales[j];
      rows.push({number:8+i,cells:Object.fromEntries(headers.map((h,j)=>[XLSX.utils.encode_col(j),values[h]===undefined?'':values[h]]))});
    });
    state=E.newSession(E.parseRows(rows,{name:'Демонстрационный заказ',fingerprint:'demo-v1',demo:true}),{...defaults});
    selected=null;filter='all';query='';$('search').value='';page=0;recalculate();
  }
  $('dropzone').addEventListener('click',()=>$('file-input').click());
  $('dropzone').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file-input').click();}});
  for(const type of ['dragenter','dragover'])$('dropzone').addEventListener(type,e=>{e.preventDefault();$('dropzone').classList.add('dragging');});
  for(const type of ['dragleave','drop'])$('dropzone').addEventListener(type,e=>{e.preventDefault();$('dropzone').classList.remove('dragging');if(type==='drop')loadExcel(e.dataTransfer.files[0]);});
  $('file-input').addEventListener('change',e=>loadExcel(e.target.files[0]));
  $('new-file-button').addEventListener('click',()=>$('file-input').click());
  $('demo-button').addEventListener('click',()=>{try{demo();}catch(error){fail(error);}});
  $('settings-button').addEventListener('click',openSettings);
  $('save-button').addEventListener('click',saveSession);
  $('restore-button').addEventListener('click',()=>$('session-input').click());
  $('export-button').addEventListener('click',openExport);
  document.addEventListener('click',e=>{const button=e.target.closest('[data-close]');if(button)$(button.dataset.close).close();});
  $('settings-form').elements.orderDate.addEventListener('change',e=>{try{$('settings-form').elements.incomingDate.value=E.calendar(e.target.value).first;}catch(_) {}});
  $('settings-form').addEventListener('submit',e=>{
    e.preventDefault();try{const form=new FormData(e.target),config={orderDate:String(form.get('orderDate')),incomingDate:String(form.get('incomingDate')),coverageWeeks:Number(form.get('coverageWeeks'))};
      if(!E.finite(config.coverageWeeks)||config.coverageWeeks<1||config.coverageWeeks>12)throw new Error('Горизонт: от 1 до 12 недель');
      E.createContext(state?state.order:{products:[]},config);
      if(state){const previous=state.settings;state.settings=config;try{recalculate();}catch(error){state.settings=previous;throw error;}}else {defaults=config;defaultDateIsManual=true;}
      $('settings-dialog').close();toast('Параметры применены');
    }catch(error){fail(error);}
  });
  $('filters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b){filter=b.dataset.filter;page=0;render();}});
  $('search').addEventListener('input',e=>{query=e.target.value;page=0;clearTimeout(searchTimer);searchTimer=setTimeout(renderTable,120);});
  $('sort').addEventListener('change',e=>{sort=e.target.value;page=0;renderTable();});
  $('prev-page').addEventListener('click',()=>{page--;renderTable();});$('next-page').addEventListener('click',()=>{page++;renderTable();});
  $('product-rows').addEventListener('click',e=>{const row=e.target.closest('[data-sku]');if(row)openDrawer(row.dataset.sku);});
  $('product-rows').addEventListener('keydown',e=>{if(e.key==='Enter'){const row=e.target.closest('[data-sku]');if(row)openDrawer(row.dataset.sku);}});
  $('drawer-shade').addEventListener('click',closeDrawer);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&selected)closeDrawer();});
  $('drawer').addEventListener('click',e=>{
    const id=e.target.closest('button')?.id;
    if(id==='close-drawer')closeDrawer();
    if(id==='keep-source')setDecision('keep');
    if(id==='apply-proposal')setDecision('apply',calculated.results.get(selected).quantity);
    if(id==='reset-decision'){delete state.decisions[selected];persist();render();}
  });
  $('drawer').addEventListener('submit',e=>{
    e.preventDefault();
    if(e.target.id==='manual-form'){const value=new FormData(e.target).get('quantity');if(E.blank(value))return toast('Введите количество. Для обнуления введите 0',true);return setDecision('apply',Number(value));}
    if(e.target.id!=='strategy-form')return;
    try{const form=new FormData(e.target),raw={mode:form.get('mode'),percent:form.get('percent'),baseTarget:form.get('baseTarget'),forecast:form.get('forecast'),promoWeeks:[0,1,2,3].map(i=>form.has('promo'+i))};
      if(form.get('incomingDate'))raw.incomingDate=form.get('incomingDate');
      const ov=E.normalizeOverride(raw),previous=state.overrides[selected];state.overrides[selected]=ov;
      try{recalculate();}catch(error){if(previous)state.overrides[selected]=previous;else delete state.overrides[selected];throw error;}
      toast('Предложение пересчитано. Подтвердите новое решение');
    }catch(error){fail(error);}
  });
  $('approve-zeros').addEventListener('click',()=>{
    if(!state)return;let count=0;
    for(const p of state.order.products){const r=calculated.results.get(p.sku);if(!r.cube.allowed&&r.cube.known&&!approved(p)){E.decide(state,calculated,p.sku,'apply',0);count++;}}
    persist();render();toast(`Согласовано ${count} запретов с количеством 0`);
  });
  $('export-csv').addEventListener('click',()=>{try{download('sgate-changes-'+state.settings.orderDate+'.csv',E.csv(exportRows()),'text/csv;charset=utf-8');}catch(error){fail(error);}});
  $('export-xlsx').addEventListener('click',exportXLSX);
  $('session-input').addEventListener('change',async e=>{
    const file=e.target.files[0];if(!file)return;busy(true);
    try{if(file.size>80*1024*1024)throw new Error('Сессия больше 80 МБ');await nextPaint();const restored=E.restoreSnapshot(JSON.parse(await file.text()));
      state=restored;selected=null;page=0;query='';$('search').value='';filter='pending';recalculate();toast('Сессия открыта. Проверьте дату расчёта');
    }catch(error){fail(error);}finally{busy(false);e.target.value='';}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state)render();});
  // Explicit API for diagnostics and reproducible browser tests; no external transport.
  window.SGateApp={getState:()=>state,getCalculation:()=>calculated,demo,loadExcel};
})();
