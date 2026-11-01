'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const E = require('../app/engine.js');
const I = require('../app/importer.js');
const S = require('../app/session.js');
const XLSX = require('../vendor/xlsx.full.min.js');
function product(overrides = {}) {
  return { sku:'TEST-001',name:'Тест',row:8,hasStoreCube:true,productCube:'Группа-0,1',storeCube:'Группа-0.5',commercialA:'',commercialB:'',priceCategory:'',topOnDelivery:'',merchandising:'',tradeCategory:'основной ассортимент',promo:'',comment:'',warnings:'',stock:70,incoming:0,allocations:0,sales:[40,40,40,40],batch:28,centralStock:1000,price:100,cost:50,mtz:50,webRecommendation:0,managerOverride:null,webTotal:0,errors:[],...overrides };
}
function calculate(p, overrides = {}, config = {}, others = []) {
  const order={products:[p,...others],metadata:{fingerprint:'test'}};
  const ctx=E.createContext(order,{orderDate:'2026-10-29',incomingDate:'2026-11-05',coverageWeeks:1,...config});
  return { ctx, r:E.compute(p,ctx,overrides) };
}
test('weights, zero weeks, and no silent spike cleaning',()=>{
  assert.equal(E.forecast(product({sales:[2,4,6,8]})).value,6);
  assert.equal(E.forecast(product({sales:[0,0,0,4]})).value,1.6);
  const f=E.forecast(product({sales:[4,5,40,5]}));assert.equal(f.value,15.4);assert.equal(f.spike,true);
  assert.deepEqual(f.sales,[4,5,40,5]);
});
test('manual promo masks renormalize weights; all promo does not invent demand',()=>{
  assert.equal(E.forecast(product({sales:[2,2,100,100]}),{promoWeeks:[false,false,true,true]}).value,2);
  assert.equal(E.forecast(product(),{promoWeeks:[true,true,true,true]}).value,null);
  assert.equal(E.forecast(product(),{promoWeeks:[true,true,true,true],forecast:3}).value,3);
});
test('calendar uses actual days and the second Thursday across month/year boundaries',()=>{
  assert.deepEqual(E.calendar('2026-11-02'),{date:'2026-11-02',first:'2026-11-05',second:'2026-11-12',lead:3,isThursday:false});
  assert.equal(E.calendar('2026-10-30').lead,6);
  assert.equal(E.calendar('2026-12-28').first,'2026-12-31');assert.equal(E.calendar('2026-12-28').second,'2027-01-07');
  assert.throws(()=>E.calendar('2026-02-30'));
});
test('exact decimal cube comparison and absolute bans',()=>{
  for(const [a,b,allowed] of [['Г-0,8','Г-0.5',false],['Г-0,1','Г-0.5',true],['Г-0,5','Г-0.50',true],['Г-2','Г-10',true],['!Г-1','Г-1',false]])assert.equal(E.cubeEligibility(product({productCube:a,storeCube:b})).allowed,allowed);
  assert.equal(E.cubeEligibility(product({storeCube:''})).code,'closed');
  assert.equal(E.cubeEligibility(product({hasStoreCube:false})).known,false);
  for(const pc of ['ЗО','ЗО вр','ЗО сеть','!ВНЕ_АМ-1'])assert.equal(E.cubeEligibility(product({productCube:pc})).code,'explicit_block');
  assert.equal(E.cubeEligibility(product({productCube:'СС_ЗОЛОТО-1',storeCube:'СС_ЗОЛОТО-1'})).allowed,true);
});
test('blocked protected SKU cannot be ordered even when keeping Web',()=>{
  const p=product({productCube:'ЗО',commercialA:'И-индикатор',webRecommendation:56}),{ctx,r}=calculate(p);
  assert.equal(r.quantity,0);assert.match(E.checkDecision(p,r,'keep',undefined,ctx,{}),/Абсолютный/);
  assert.equal(E.checkDecision(p,r,'apply',0,ctx,{}),null);
});
test('B: today 70 -> 30 -> shortage 10; hold strategy buys 56 without per-SKU exceptions',()=>{
  const p=product({priceCategory:'ПЦ'}),{r}=calculate(p,{mode:'hold'});
  assert.equal(r.zero.firstSigned,30);assert.equal(r.zero.secondSigned,-10);assert.equal(r.quantity,56);
  assert.equal(r.projection.firstAfter,86);assert.equal(r.projection.secondSigned,46);
});
test('Monday does not pretend to be a full week before Thursday',()=>{
  const {r}=calculate(product(),{}, {orderDate:'2026-11-02'});
  assert.equal(r.zero.firstBefore,E.round(70-40*3/7));
  assert.notEqual(r.zero.firstBefore,30);
});
test('A: batch rounds up to prevent stock-out at a weekly target',()=>{
  const p=product({stock:5,sales:[10,10,10,10],batch:12});
  const {r}=calculate(p,{}, {orderDate:'2026-11-04'});
  assert.equal(r.quantity,12);assert.ok(r.projection.secondSigned>0);
});
test('C: percent changes target, not Web recommendation; repeated compute does not compound',()=>{
  const p=product({stock:100,sales:[0,0,0,0],batch:24});
  const ov={mode:'increase',baseTarget:100,percent:10};
  const a=calculate(p,ov).r,b=calculate(p,ov).r;
  assert.equal(a.target,110);assert.equal(a.quantity,24);assert.equal(b.target,110);
});
test('incoming once reduces need; later shipment does not erase earlier stockout',()=>{
  const p=product({stock:0,incoming:10,sales:[100,100,100,100],batch:1});
  const {r}=calculate(p,{baseTarget:100});assert.equal(r.quantity,90);
  const {ctx}=calculate(p,{}, {incomingDate:'2026-11-12'});
  const result=E.project(p,100,100,ctx,'2026-11-12');
  assert.equal(result.lostBefore,100);assert.equal(result.firstAfter,100);assert.equal(result.secondBefore,0);
});
test('lost sales are not treated as backlog to refill twice',()=>{
  const p=product({stock:0,sales:[10,10,10,10],batch:1});const {r}=calculate(p);
  assert.equal(r.zero.lostBefore,10);assert.equal(r.quantity,10);assert.equal(r.projection.firstAfter,10);
});
test('corrections respect batch and warehouse while accepted Web is untouched',()=>{
  const p=product({webRecommendation:5,batch:4,centralStock:5}),{ctx,r}=calculate(p);
  assert.equal(E.checkDecision(p,r,'keep',undefined,ctx,{}),null);
  assert.match(E.checkDecision(p,r,'apply',5,ctx,{}),/кратно/);
  assert.equal(E.checkDecision(p,r,'apply',4,ctx,{}),null);
  assert.match(E.checkDecision(p,r,'apply',8,ctx,{}),/складе/);
});
test('not-for-sale flag is ignored; MTZ does not inflate demand',()=>{
  const p=product({tradeCategory:'не для продажи',mtz:100000});
  assert.equal(calculate(p).r.quantity,calculate(product({mtz:0})).r.quantity);
});
test('replacement direction and zero-in-store switch to new SKU',()=>{
  const old=product({sku:'OLD',comment:'меняется на NEW',stock:0,productCube:'ЗО'});
  const next=product({sku:'NEW',comment:'вместо OLD ост. 0'});
  const {ctx}=calculate(old,{}, {},[next]);
  assert.equal(E.compute(next,ctx).replacement.allowed,true);
  old.stock=1;const ctx2=E.createContext({products:[old,next]},{orderDate:'2026-10-29'});
  assert.equal(E.compute(next,ctx2).replacement.allowed,false);
});
test('replacement pair may not be ordered twice, including unreviewed original',()=>{
  const old=product({sku:'OLD',comment:'меняется на NEW'}),next=product({sku:'NEW',comment:'вместо OLD',webRecommendation:28});
  const {ctx,r}=calculate(old,{}, {},[next]);
  assert.match(E.checkDecision(old,r,'apply',28,ctx,{}),/В паре замен/);
  assert.equal(E.checkDecision(old,r,'apply',28,ctx,{NEW:{quantity:0}}),null);
});
test('all correction invariants over many finite cases',()=>{
  for(const stock of [0,1,5,70])for(const k of [1,4,28])for(const warehouse of [0,1,5,1000]){
    const p=product({stock,batch:k,centralStock:warehouse});const {r}=calculate(p);
    assert.equal(E.validCorrection(p,r.quantity),null);
    assert.ok(r.quantity>=0);assert.ok(r.quantity<=warehouse);
  }
});
test('CSV keeps explicit numeric zero and escapes spreadsheet formula text',()=>{
  const csv=S.csv([['SKU','qty'],['=cmd',0]]);assert.match(csv,/'=cmd/);assert.match(csv,/;0/);
});
const hasFiles=fs.existsSync('example-files/order-full.xlsx');
let full;
function realOrder(){return full||(full=I.parseWorkbook(XLSX.read(fs.readFileSync('example-files/order-full.xlsx'),{type:'buffer',nodim:true}),{name:'local',fingerprint:'local-full'}));}
test('actual full file: ignore broken dimension, exact cube audit and stock metrics',{skip:!hasFiles},()=>{
  const order=realOrder();assert.equal(order.products.length,10626);assert.equal(order.metadata.groups,997);assert.equal(order.metadata.diagnostics.length,0);
  const returns=order.products.find(p=>p.sku==='249-110');assert.deepEqual(returns.sales,[0,3,-1,0]);assert.equal(returns.stockDays,-600);
  const state=S.newSession(order,{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1});const calc=S.calculate(state);
  const counts={};for(const r of calc.results.values())counts[r.cube.code]=(counts[r.cube.code]||0)+1;
  assert.deepEqual(counts,{explicit_block:3514,inside:6801,closed:235,outside:76});
  assert.equal(calc.metrics.active,7665);assert.equal(calc.metrics.value,18156991.3);
  for(const p of order.products){const r=calc.results.get(p.sku);if(r.action==='apply')assert.equal(E.validCorrection(p,r.quantity),null,p.sku);if(r.cube.known&&!r.cube.allowed)assert.equal(r.quantity,0,p.sku);}
});
test('seven user decisions remain representable, persist, and export only real changes',{skip:!hasFiles},()=>{
  const state=S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1}),calc=S.calculate(state);
  const expected={'794-562':0,'732-099':1,'914-005':56,'770-059':2,'778-078':0,'313-385':6,'318-087':24};
  for(const [sku,q]of Object.entries(expected))S.decide(state,calc,sku,q===calc.results.get(sku).source?'keep':'apply',q);
  assert.equal(Object.keys(state.decisions).length,7);
  const restored=S.restoreSnapshot(JSON.parse(JSON.stringify(S.snapshot(state))));
  assert.equal(Object.keys(restored.decisions).length,7);
  const changes=S.changeRows(restored,S.calculate(restored));
  assert.equal(changes.length,3);assert.ok(changes.some(c=>c.sku==='794-562'&&c.quantity===0));
});
test('date change invalidates confirmations, corrupt snapshots are rejected atomically',{skip:!hasFiles},()=>{
  const state=S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1}),calc=S.calculate(state);
  S.decide(state,calc,'914-005','apply',56);state.settings.orderDate='2026-11-03';
  assert.equal(S.calculate(state).invalidated,1);
  const snap=S.snapshot(state);snap.rows[0].cells.A={evil:'x'};
  assert.throws(()=>S.restoreSnapshot(snap),/ячейки/);
});
test('old cut imports safely but missing store cube never permits positive decisions',{skip:!fs.existsSync('example-files/order-cut.xlsx')},()=>{
  const order=I.parseWorkbook(XLSX.read(fs.readFileSync('example-files/order-cut.xlsx'),{type:'buffer',nodim:true}));assert.equal(order.products.length,9);
  const state=S.newSession(order),calc=S.calculate(state);
  for(const p of order.products){const r=calc.results.get(p.sku);assert.equal(r.quantity,0);assert.ok(E.checkDecision(p,r,'apply',p.batch,calc.ctx,{}));}
});

test('snapshot is detached: editing a backup cannot mutate live decisions or source cells',{skip:!hasFiles},()=>{
  const state=S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1}),calc=S.calculate(state);
  S.decide(state,calc,'914-005','apply',56);
  const copy=S.snapshot(state),original=state.order.rows[0].cells.A;
  copy.decisions['914-005'].quantity=999;copy.rows[0].cells.A='changed';
  assert.equal(state.decisions['914-005'].quantity,56);assert.equal(state.order.rows[0].cells.A,original);
});

test('negative weekly sales stay original and require manual interpretation, not zero filling',()=>{
  const p=product({sales:[0,3,-1,0]});
  const fc=E.forecast(p);assert.equal(fc.raw,0.3);assert.equal(fc.value,null);assert.deepEqual(fc.sales,[0,3,-1,0]);
  assert.equal(E.forecast(p,{forecast:2}).value,2);
  assert.equal(calculate(p).r.review,true);assert.equal(calculate(p,{forecast:2}).r.review,false);
});

test('unmapped promo does not silently extrapolate promotional sales into an automatic order',()=>{
  const p=product({promo:'ГАЗ 15.10 - 30.10',sales:[2,2,100,100]});
  assert.equal(calculate(p).r.review,true);
  const explicit=calculate(p,{promoWeeks:[false,false,true,true]}).r;
  assert.equal(explicit.demand,2);assert.equal(explicit.review,false);
});


test('adequate Web remains unchanged; reduction and informational tags are optional',()=>{
  const p=product({stock:15,sales:[9,17,17,21],batch:2,webRecommendation:40,promo:'А 23.10 - 30.10',commercialA:'И-индикатор'});
  const {r}=calculate(p,{}, {orderDate:'2026-11-02'});
  assert.equal(r.demand,17.8);assert.equal(r.quantity,40);assert.equal(r.action,'keep');assert.equal(r.review,false);
  assert.equal(r.sourceRisk,false);assert.equal(r.attention.required,false);assert.equal(r.canReduce,true);
  assert.equal(r.sourceProjection.secondBefore,29.571429);
  assert.equal(calculate(p,{baseTarget:r.target},{orderDate:'2026-11-02'}).r.quantity,r.minimumQuantity);
});
test('attention checks Web coverage, not shortage in the no-order alternative',()=>{
  const p=product({stock:70,webRecommendation:56,priceCategory:'ПЦ'}),{r}=calculate(p);
  assert.ok(r.zero.secondSigned<0);assert.equal(r.attention.required,false);assert.equal(r.quantity,56);
  const shortage=calculate({...p,webRecommendation:0}).r;
  assert.equal(shortage.attention.kind,'risk');assert.ok(shortage.quantity>0);
  const forbidden=calculate({...p,productCube:'ЗО',webRecommendation:0}).r;
  assert.equal(forbidden.attention.required,false);assert.equal(forbidden.quantity,0);
});
test('complementary replacement comments form one directed relation, not a cycle',()=>{
  const a=product({sku:'OLD',comment:'меняется на NEW'}),b=product({sku:'NEW',comment:'вместо OLD'});
  const {ctx}=calculate(a,{}, {},[b]);const g=ctx.groupBySku.get('OLD');
  assert.equal(g.cyclic,false);assert.equal(g.ambiguous,false);assert.equal(g.links.length,1);
});
test('real mop and cyclic replacements: one queue case, explicit choice, no double order, persistence',{skip:!hasFiles},()=>{
  const state=S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1});let c=S.calculate(state);
  assert.equal(c.results.get('444-268').quantity,40);assert.equal(c.results.get('444-268').attention.required,false);
  assert.equal(S.queueItems(state,c).length,128);
  const group=c.ctx.groupBySku.get('655-001');assert.equal(group.cyclic,true);assert.equal(group.links.length,2);
  assert.equal(S.queueItems(state,c).filter(p=>group.members.includes(p.sku)).length,1);
  S.decide(state,c,'655-001','keep');assert.equal(state.decisions['655-001'].quantity,6);
  S.chooseReplacement(state,c,group.id,'655-007');c=S.calculate(state);assert.equal(state.decisions['655-001'],undefined);
  assert.throws(()=>S.decide(state,c,'655-007','apply',2),/Сначала согласуйте/);
  S.decide(state,c,'655-001','apply',0);c=S.calculate(state);S.decide(state,c,'655-007','apply',2);
  const restored=S.restoreSnapshot(JSON.parse(JSON.stringify(S.snapshot(state))));
  assert.equal(restored.replacementChoices[group.id],'655-007');assert.equal(restored.decisions['655-001'].quantity,0);assert.equal(restored.decisions['655-007'].quantity,2);
});
test('legacy sessions keep settings but never reuse approvals, even with a matching forged signature',{skip:!hasFiles},()=>{
  const state=S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1}),c=S.calculate(state);
  state.overrides['444-268']={mode:'hold',percent:0};S.decide(state,c,'914-005','apply',56);
  const payload=JSON.parse(JSON.stringify(S.localPayload(state)));payload.rulesVersion='sgate-1.0';
  const restored=S.restorePayload(state.order,payload);
  assert.equal(Object.keys(restored.decisions).length,0);assert.equal(restored.overrides['444-268'].mode,'hold');
});
