const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const XLSX = require('../../vendor/xlsx.full.min.js');
const root = path.resolve(__dirname, '../..');
const appURL = pathToFileURL(path.join(root, 'sgate.html')).href;
async function open(page) {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const network=[];page.on('request',req=>{if(/^https?:/.test(req.url()))network.push(req.url());});
  await page.goto(appURL);
  await expect(page.getByRole('heading',{name:'Заказ под контролем.'})).toBeVisible();
  return {errors,network};
}
async function demo(page){await page.getByRole('button',{name:'Посмотреть на демо-данных'}).click();await expect(page.locator('#workspace')).toBeVisible();}
async function select(page,sku){await page.locator('#search').fill(sku);await page.locator(`#product-rows tr[data-sku="${sku}"]`).click();await expect(page.locator('#drawer')).toBeVisible();}
async function close(page){await page.locator('#close-drawer').click();}

test('standalone opens offline, interactive strategy computes percent and validates own quantity',async({page})=>{
  const {errors,network}=await open(page);await demo(page);await select(page,'D-003');
  await page.locator('#strategy-form select[name=mode]').selectOption('increase');
  await page.locator('#strategy-form input[name=baseTarget]').fill('100');
  await page.locator('#strategy-form input[name=percent]').fill('10');
  await page.getByRole('button',{name:'Пересчитать предложение'}).click();
  await expect(page.locator('#drawer')).toContainText('цель 110');
  await page.locator('#manual-form input').fill('1');await page.locator('#manual-form button').click();
  await expect(page.locator('#toast')).toContainText('кратно 8');
  await page.locator('#keep-source').click();await expect(page.locator('#drawer')).toContainText('Согласовано: оставить исходный');
  expect(await page.evaluate(()=>SGateApp.getState().decisions['D-003'].quantity)).toBe(8);
  await close(page);
  fs.mkdirSync(path.join(root,'analysis/browser'),{recursive:true});
  await page.screenshot({path:path.join(root,'analysis/browser/workspace.png'),fullPage:true});
  expect(errors).toEqual([]);expect(network).toEqual([]);
});

test('explicit zero survives CSV; full JSON session restores accepted decisions',async({page})=>{
  const {errors}=await open(page);await demo(page);await select(page,'D-001');
  await expect(page.locator('#keep-source')).toBeDisabled();
  await page.locator('#apply-proposal').click();await close(page);
  await page.locator('#export-button').click();
  const dl=page.waitForEvent('download');await page.locator('#export-csv').click();const csv=await(await dl).path();
  const contents=fs.readFileSync(csv,'utf8');expect(contents).toContain('D-001');expect(contents).toMatch(/;0;/);
  const excelDL=page.waitForEvent('download');await page.locator('#export-xlsx').click();const excel=await(await excelDL).path();
  const workbook=XLSX.read(fs.readFileSync(excel),{type:'buffer'});
  expect(workbook.SheetNames).toEqual(['Изменения для ввода','Проверка заказа','Параметры']);
  const exported=XLSX.utils.sheet_to_json(workbook.Sheets['Изменения для ввода'],{header:1});expect(exported[1][0]).toBe('D-001');expect(exported[1][3]).toBe(0);
  await page.locator('[data-close="export-dialog"]').click();
  const sessionDL=page.waitForEvent('download');await page.locator('#save-button').click();const backup=await(await sessionDL).path();
  await page.reload();await page.locator('#session-input').setInputFiles({name:'session.json',mimeType:'application/json',buffer:fs.readFileSync(backup)});
  await expect(page.locator('#workspace')).toBeVisible();
  expect(await page.evaluate(()=>SGateApp.getState().decisions['D-001'].quantity)).toBe(0);
  expect(errors).toEqual([]);
});

test('malformed session leaves loaded order intact; date change invalidates decisions',async({page})=>{
  await open(page);await demo(page);await select(page,'D-003');await page.locator('#keep-source').click();await close(page);
  const invalid=await page.evaluate(()=>{const s=SGate.snapshot(SGateApp.getState());s.decisions['D-003'].quantity=99;return JSON.stringify(s);});
  await page.locator('#session-input').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(invalid)});
  await expect(page.locator('#toast')).toContainText('исходное количество');
  expect(await page.evaluate(()=>SGateApp.getState().decisions['D-003'].quantity)).toBe(8);
  await page.locator('#settings-button').click();
  await page.locator('#settings-form input[name=orderDate]').fill('2026-11-02');
  await page.locator('#settings-form input[name=incomingDate]').fill('2026-11-05');
  await page.locator('#settings-form button[type=submit]').click();
  // In case the runtime day was already Nov 2, change the date once more.
  await page.locator('#settings-button').click();await page.locator('#settings-form input[name=orderDate]').fill('2026-11-03');await page.locator('#settings-form input[name=incomingDate]').fill('2026-11-05');await page.locator('#settings-form button[type=submit]').click();
  expect(await page.evaluate(()=>Object.keys(SGateApp.getState().decisions).length)).toBe(0);
});

test('demo has correct newest sales and works on narrow screen',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page);
  fs.mkdirSync(path.join(root,'analysis/browser'),{recursive:true});await page.screenshot({path:path.join(root,'analysis/browser/mobile-welcome.png'),fullPage:true});
  await demo(page);
  expect(await page.evaluate(()=>SGateApp.getState().order.products.find(p=>p.sku==='D-005').sales)).toEqual([4,5,40,5]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await select(page,'D-002');await expect(page.locator('#drawer')).toBeVisible();
});

test('real full Excel: imports all cells despite dimension, correct metrics and preserves Web conflicts',async({page})=>{
  test.skip(!fs.existsSync(path.join(root,'example-files/order-full.xlsx')),'Local Excel is not published');
  const {errors,network}=await open(page);await page.locator('#file-input').setInputFiles(path.join(root,'example-files/order-full.xlsx'));
  await expect(page.locator('#workspace')).toBeVisible({timeout:60000});
  const facts=await page.evaluate(()=>{const s=SGateApp.getState(),c=SGateApp.getCalculation(),counts={};for(const r of c.results.values())counts[r.cube.code]=(counts[r.cube.code]||0)+1;return{products:s.order.products.length,counts,active:c.metrics.active,value:c.metrics.value};});
  expect(facts).toEqual({products:10626,counts:{explicit_block:3514,inside:6801,closed:235,outside:76},active:7665,value:18156991.3});
  await select(page,'398-875');await page.locator('#keep-source').click();
  expect(await page.evaluate(()=>SGateApp.getState().decisions['398-875'].quantity)).toBe(5);
  await page.locator('#manual-form input').fill('5');await page.locator('#manual-form button').click();await expect(page.locator('#toast')).toContainText('кратно 4');
  await page.locator('#manual-form input').fill('4');await page.locator('#manual-form button').click();
  expect(await page.evaluate(()=>SGateApp.getState().decisions['398-875'].quantity)).toBe(4);
  await close(page);await page.locator('[data-filter="all"]').click();await page.locator('#search').fill('');await expect(page.locator('#product-rows tr')).toHaveCount(75);
  await page.screenshot({path:path.join(root,'analysis/browser/full-order.png'),fullPage:true});
  await select(page,'249-110');await expect(page.locator('#drawer')).toContainText('отрицательные продажи');await expect(page.locator('#apply-proposal')).toBeDisabled();
  await page.locator('#strategy-form input[name=forecast]').fill('2');await page.getByRole('button',{name:'Пересчитать предложение'}).click();await expect(page.locator('#apply-proposal')).toBeEnabled();
  expect(errors).toEqual([]);expect(network).toEqual([]);
});

test('old cut file safely shows missing cube and never offers positive correction',async({page})=>{
  test.skip(!fs.existsSync(path.join(root,'example-files/order-cut.xlsx')),'Local Excel is not published');
  await open(page);await page.locator('#file-input').setInputFiles(path.join(root,'example-files/order-cut.xlsx'));await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('нет «КУБ»');
  expect(await page.evaluate(()=>[...SGateApp.getCalculation().results.values()].every(r=>r.quantity===0))).toBe(true);
});
