const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),XLSX=require('../../vendor/xlsx.full.min.js');
const root=path.resolve(__dirname,'../..'),appURL=pathToFileURL(path.join(root,'sgate.html')).href;
async function open(page){const errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});await page.goto(appURL);await expect(page.getByRole('heading',{name:'Заказ под контролем.'})).toBeVisible();return{errors,network};}
async function demo(page){await page.locator('#demo-button').click();await expect(page.locator('#workspace')).toBeVisible();}
async function select(page,sku){await page.locator('#search').fill(sku);await page.locator(`#product-rows tr[data-sku="${sku}"]`).click();await expect(page.locator('#drawer')).toBeVisible();}
async function close(page){await page.locator('#close-drawer').click();}
async function qty(page,q){await page.locator('#manual-form input').fill(String(q));await page.locator('#manual-form button').click();}
async function fixedDate(page){await page.locator('#settings-button').click();await page.locator('[name=orderDate]').fill('2026-11-02');await page.locator('[name=incomingDate]').fill('2026-11-05');await page.locator('#settings-form button[type=submit]').click();}
async function loadFull(page){await fixedDate(page);await page.locator('#file-input').setInputFiles(path.join(root,'example-files/order-full.xlsx'));await expect(page.locator('#workspace')).toBeVisible({timeout:60000});}

test('import immediately applies all changes and exports explicit zero without approvals',async({page})=>{
 const {errors,network}=await open(page);await demo(page);
 expect(await page.evaluate(()=>SGateApp.getCalculation().results.get('D-001').quantity)).toBe(0);
 expect(await page.evaluate(()=>SGateApp.getState().decisions)).toBeUndefined();
 await expect(page.locator('#keep-source,#apply-proposal,#approve-zeros')).toHaveCount(0);
 await page.locator('#export-button').click();await expect(page.locator('#export-summary')).toContainText('уже включено');
 const csvDownload=page.waitForEvent('download');await page.locator('#export-csv').click();const csv=fs.readFileSync(await(await csvDownload).path(),'utf8');expect(csv).toContain('D-001');expect(csv).toMatch(/;0;/);
 const excelDownload=page.waitForEvent('download');await page.locator('#export-xlsx').click();const wb=XLSX.read(fs.readFileSync(await(await excelDownload).path()),{type:'buffer'});expect(wb.SheetNames).toEqual(['Изменения для ввода','Наш заказ','Проблемные','Параметры']);
 expect(XLSX.utils.sheet_to_json(wb.Sheets['Изменения для ввода'],{header:1}).find(r=>r[0]==='D-001')[3]).toBe(0);
 expect(errors).toEqual([]);expect(network).toEqual([]);
});

test('manual quantity immediately changes order and export; reset returns automatic calculation',async({page})=>{
 const {errors}=await open(page);await demo(page);await select(page,'D-003');await qty(page,1);await expect(page.locator('#toast')).toContainText('кратно 8');
 await qty(page,16);await expect(page.locator('#current-quantity')).toHaveText('16');
 expect(await page.evaluate(()=>SGate.changeRows(SGateApp.getState(),SGateApp.getCalculation()).find(r=>r.sku==='D-003').quantity)).toBe(16);
 await page.locator('#reset-quantity').click();await expect(page.locator('#current-quantity')).toHaveText('0');expect(await page.evaluate(()=>SGateApp.getState().manualQuantities['D-003'])).toBeUndefined();expect(errors).toEqual([]);
});

test('global strategy and percent recalculate every item immediately and clear manual quantities',async({page})=>{
 await open(page);await demo(page);await select(page,'D-003');
 await page.locator('#strategy-form input[name=baseTarget]').fill('100');await page.locator('#strategy-form button').click();await qty(page,16);await close(page);
 await page.locator('#global-strategy').selectOption('increase');await page.locator('#global-percent').fill('10');await page.locator('#global-percent').dispatchEvent('change');
 const facts=await page.evaluate(()=>({manual:SGateApp.getState().manualQuantities,modes:[...SGateApp.getCalculation().results.values()].map(r=>r.mode),target:SGateApp.getCalculation().results.get('D-003').target}));
 expect(facts.manual).toEqual({});expect(facts.modes.every(m=>m==='increase')).toBe(true);expect(facts.target).toBe(110);
 await select(page,'D-003');await expect(page.locator('#drawer')).toContainText('цель 110');await close(page);
 await page.locator('#global-strategy').selectOption('decrease');expect(await page.evaluate(()=>[...SGateApp.getCalculation().results.values()].every(r=>r.mode==='decrease'))).toBe(true);
});

test('JSON session restores strategy and manual values; corrupt restore leaves live order intact',async({page})=>{
 await open(page);await demo(page);await select(page,'D-003');await qty(page,16);await close(page);
 const bad=await page.evaluate(()=>{const s=SGate.snapshot(SGateApp.getState());s.manualQuantities['D-003']=1;return JSON.stringify(s);});
 await page.locator('#session-input').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(bad)});await expect(page.locator('#toast')).toContainText('кратно 8');expect(await page.evaluate(()=>SGateApp.getState().manualQuantities['D-003'])).toBe(16);
 const downloaded=page.waitForEvent('download');await page.locator('#save-button').click();const backup=fs.readFileSync(await(await downloaded).path());await page.reload();
 await page.locator('#session-input').setInputFiles({name:'session.json',mimeType:'application/json',buffer:backup});await expect(page.locator('#workspace')).toBeVisible();expect(await page.evaluate(()=>SGateApp.getCalculation().results.get('D-003').quantity)).toBe(16);
});

test('real report: automatic lower/raise/zero lists, example SKU, cycle and no duplicate orders',async({page})=>{
 test.skip(!fs.existsSync(path.join(root,'example-files/order-full.xlsx')),'Local Excel is not published');
 const {errors,network}=await open(page);await loadFull(page);
 const facts=await page.evaluate(()=>{const c=SGateApp.getCalculation();return{total:c.metrics.total,changes:c.metrics.changes,unresolved:c.metrics.unresolved,value:c.metrics.value,q: c.results.get('967-001').quantity,mop:c.results.get('444-268').quantity};});
 expect(facts).toEqual({total:10626,changes:1415,unresolved:354,value:18156991.3,q:0,mop:16});
 for(const [key,count]of [['down',148],['up',3],['zero',1264]]){expect(Number((await page.locator(`#filters [data-filter=${key}] span`).textContent()).replace(/\s/g,''))).toBe(count);}
 await page.locator('#filters [data-filter=zero]').click();await select(page,'967-001');await expect(page.locator('#current-quantity')).toHaveText('0');await close(page);
 await select(page,'655-001');await expect(page.locator('.replacement-panel')).toContainText('Взаимная замена');await expect(page.locator('#current-quantity')).toHaveText('Не рассчитан');
 await page.locator('#replacement-form select').selectOption('655-001');await page.locator('#replacement-form button').click();await expect(page.locator('#current-quantity')).toHaveText('2');
 await page.locator('[data-open-peer="655-007"]').click();await qty(page,2);expect(await page.evaluate(()=>SGateApp.getCalculation().results.get('655-001').quantity)).toBe(0);await expect(page.locator('#current-quantity')).toHaveText('2');await close(page);
 await page.locator('#search').fill('');await page.locator('#filters [data-filter=changes]').click();fs.mkdirSync(path.join(root,'analysis/browser'),{recursive:true});await page.screenshot({path:path.join(root,'analysis/browser/automatic-order.png')});
 await select(page,'249-110');await expect(page.locator('#drawer')).toContainText('отрицательные продажи');await page.locator('#strategy-form input[name=forecast]').fill('2');await page.locator('#strategy-form button').click();expect(await page.evaluate(()=>SGateApp.getCalculation().results.get('249-110').quantity)).not.toBeNull();
 expect(errors).toEqual([]);expect(network).toEqual([]);
});

test('old cut never converts unknown eligibility into a silent zero',async({page})=>{
 test.skip(!fs.existsSync(path.join(root,'example-files/order-cut.xlsx')),'Local Excel is not published');await open(page);await page.locator('#file-input').setInputFiles(path.join(root,'example-files/order-cut.xlsx'));await expect(page.locator('#workspace')).toBeVisible();await expect(page.locator('#notice')).toContainText('нет «КУБ»');expect(await page.evaluate(()=>[...SGateApp.getCalculation().results.values()].every(r=>r.blocked?r.quantity===0:r.quantity===null))).toBe(true);
});

test('mobile layout contains global controls and searchable quantity editor',async({page})=>{
 await page.setViewportSize({width:390,height:844});const{errors}=await open(page);await demo(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('#global-strategy')).toBeVisible();await select(page,'D-003');await qty(page,16);await expect(page.locator('#current-quantity')).toHaveText('16');expect(errors).toEqual([]);
});
