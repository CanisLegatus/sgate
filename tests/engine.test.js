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
const hasFiles=fs.existsSync('example-files/order-full.xlsx');let full;
function realOrder(){return full||(full=I.parseWorkbook(XLSX.read(fs.readFileSync('example-files/order-full.xlsx'),{type:'buffer',nodim:true}),{name:'local',fingerprint:'local-full'}));}
function localState(){return S.newSession(realOrder(),{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1});}

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
  const {r}=calculate(p,{baseTarget:100});assert.equal(r.quantity,115);
  const {ctx}=calculate(p,{}, {incomingDate:'2026-11-12'});
  const result=E.project(p,100,100,ctx,'2026-11-12');
  assert.equal(result.lostBefore,100);assert.equal(result.firstAfter,100);assert.equal(result.secondBefore,0);
});
test('lost sales are not treated as backlog to refill twice',()=>{
  const p=product({stock:0,sales:[10,10,10,10],batch:1});const {r}=calculate(p);
  assert.equal(r.zero.lostBefore,10);assert.equal(r.quantity,13);assert.equal(r.projection.firstAfter,13);
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


test('automatic need is independent of whether Web already covers the horizon',()=>{
  const p=product({stock:70,webRecommendation:56,priceCategory:'ПЦ'}),a=calculate(p).r,b=calculate({...p,webRecommendation:0}).r;
  assert.equal(a.quantity,b.quantity);assert.ok(a.zero.secondSigned<0);assert.equal(a.sourceRisk,false);assert.equal(b.sourceRisk,true);
});
test('complementary replacement comments form one directed relation, not a cycle',()=>{
  const a=product({sku:'OLD',comment:'меняется на NEW'}),b=product({sku:'NEW',comment:'вместо OLD'});
  const {ctx}=calculate(a,{}, {},[b]);const g=ctx.groupBySku.get('OLD');
  assert.equal(g.cyclic,false);assert.equal(g.ambiguous,false);assert.equal(g.links.length,1);
});
test('auto computes its own need even when Web is sufficient or excessive',()=>{
  const p=product({stock:20,sales:[1,2,2,2],batch:20,webRecommendation:20});
  const {r}=calculate(p,{}, {orderDate:'2026-11-02'});assert.equal(r.quantity,0);assert.equal(r.source,20);assert.equal(r.demand,1.9);
  const mop=calculate(product({stock:15,sales:[9,17,17,21],batch:2,webRecommendation:40,promo:'А 23.10 - 30.10',commercialA:'И-индикатор'}),{}, {orderDate:'2026-11-02'}).r;
  assert.equal(mop.quantity,16);assert.equal(mop.projection.secondBefore,5.571429);assert.equal(mop.review,false);
});
test('manual values change order, metrics and export immediately; reset restores auto',()=>{
  const p=product({stock:20,sales:[1,2,2,2],batch:20,webRecommendation:20}),s=S.newSession({products:[p],metadata:{fingerprint:'test'}});let c=S.calculate(s);
  assert.equal(c.results.get(p.sku).quantity,0);assert.equal(S.changeRows(s,c)[0].quantity,0);assert.equal(c.metrics.orderValue,0);
  S.setQuantity(s,c,p.sku,40);c=S.calculate(s);assert.equal(c.results.get(p.sku).quantity,40);assert.equal(c.metrics.orderValue,4000);assert.equal(S.changeRows(s,c)[0].quantity,40);
  assert.throws(()=>S.setQuantity(s,c,p.sku,1),/кратно/);assert.equal(s.manualQuantities[p.sku],40);
  S.resetQuantity(s,p.sku);assert.equal(S.calculate(s).results.get(p.sku).quantity,0);
});
test('global strategy recomputes all products and resets manual quantities without compounding',()=>{
  const p=product({stock:100,sales:[0,0,0,0],batch:24}),b=product({sku:'SECOND',stock:50,sales:[0,0,0,0],batch:1,productCube:'ЗО'});
  const s=S.newSession({products:[p,b],metadata:{fingerprint:'test'}});S.setQuantity(s,S.calculate(s),p.sku,48);
  S.updateSettings(s,{...s.settings,strategy:'increase',percent:10});let c=S.calculate(s);
  assert.deepEqual(Object.keys(s.manualQuantities),[]);assert.equal(c.results.get(p.sku).target,110);assert.equal(c.results.get(p.sku).quantity,24);assert.equal(c.results.get(b.sku).quantity,0);
  assert.equal(S.calculate(s).results.get(p.sku).target,110);
  const before=s.settings;assert.throws(()=>S.updateSettings(s,{...s.settings,strategy:'decrease',percent:101}),/стратегия/);assert.equal(s.settings,before);
});
test('manual and automatic positive orders obey bans, batch and warehouse',()=>{
  for(const patch of [{productCube:'ЗО'},{storeCube:''},{productCube:'Группа-0.8'},{centralStock:0}]){
    const p=product(patch),s=S.newSession({products:[p],metadata:{fingerprint:'t'}}),c=S.calculate(s);
    assert.equal(c.results.get(p.sku).quantity,0);assert.throws(()=>S.setQuantity(s,c,p.sku,28));
  }
});
test('unresolved values are null, not zero or fallback Web, and are excluded from commands',()=>{
  const p=product({sales:[2,-1,2,2],webRecommendation:56}),s=S.newSession({products:[p],metadata:{fingerprint:'t'}}),c=S.calculate(s);
  assert.equal(c.results.get(p.sku).quantity,null);assert.equal(c.metrics.unresolved,1);assert.equal(S.changeRows(s,c).length,0);assert.equal(S.problemItems(s,c).length,1);
  S.setQuantity(s,c,p.sku,28);const manual=S.calculate(s);assert.equal(S.changeRows(s,manual)[0].quantity,28);assert.equal(manual.metrics.unresolved,0);assert.equal(manual.metrics.unprojected,1);assert.equal(manual.metrics.orderValue,2800);
});
test('full report automatically produces changes and all quantities satisfy invariants',{skip:!hasFiles},()=>{
  const s=localState(),c=S.calculate(s);assert.equal(s.order.products.length,10626);assert.equal(c.metrics.active,7665);assert.equal(c.metrics.value,18156991.3);
  assert.equal(c.results.get('967-001').quantity,0);assert.equal(c.results.get('444-268').quantity,16);
  const counts={down:0,up:0,zero:0,same:0,unknown:0};for(const p of s.order.products){const r=c.results.get(p.sku);counts[r.quantity===null?'unknown':r.quantity===r.source?'same':r.quantity===0?'zero':r.quantity<r.source?'down':'up']++;if(r.quantity!==null)assert.equal(E.validateQuantity(p,r,r.quantity),null,p.sku);}
  assert.deepEqual(counts,{down:167,up:42,zero:1081,same:8982,unknown:354});assert.equal(S.changeRows(s,c).length,1290);assert.equal(c.metrics.changes,1290);
  assert.equal(Object.hasOwn(s,'decisions'),false);
});
test('cycle is one problem; selecting or entering a quantity recomputes the entire group',{skip:!hasFiles},()=>{
  const s=localState();let c=S.calculate(s);const group=c.ctx.groupBySku.get('655-001');assert.equal(group.cyclic,true);assert.equal(group.links.length,2);
  assert.equal(c.results.get('655-001').quantity,null);assert.equal(S.problemItems(s,c).filter(p=>group.members.includes(p.sku)).length,1);
  S.chooseReplacement(s,c,group.id,'655-001');c=S.calculate(s);assert.equal(c.results.get('655-001').quantity,2);assert.equal(c.results.get('655-007').quantity,0);
  S.setQuantity(s,c,'655-007',2);c=S.calculate(s);assert.equal(c.results.get('655-001').quantity,0);assert.equal(c.results.get('655-007').quantity,2);
  const restored=S.restoreSnapshot(S.snapshot(s));assert.equal(restored.replacementChoices[group.id],'655-007');assert.equal(S.calculate(restored).results.get('655-007').quantity,2);
});
test('session backup is detached, validates atomic restore, and contains no approvals',{skip:!hasFiles},()=>{
  const s=localState();S.setQuantity(s,S.calculate(s),'967-001',40);const snap=S.snapshot(s);snap.manualQuantities['967-001']=1;
  assert.equal(s.manualQuantities['967-001'],40);assert.throws(()=>S.restoreSnapshot(snap),/кратно/);
  const valid=S.snapshot(s),restored=S.restoreSnapshot(valid);assert.equal(restored.manualQuantities['967-001'],40);assert.equal(Object.hasOwn(valid,'decisions'),false);
  valid.rows[0].cells.A={bad:true};assert.throws(()=>S.restoreSnapshot(valid),/ячейки/);
});
test('legacy approval sessions migrate to fresh automatic results, preserving forecast inputs',{skip:!hasFiles},()=>{
  const s=localState(),payload=S.snapshot(s);payload.version=1;payload.rulesVersion='sgate-1.1';delete payload.manualQuantities;
  payload.decisions={'967-001':{kind:'keep',quantity:20}};payload.overrides={'967-001':{mode:'hold',percent:0,forecast:2}};
  const restored=S.restoreSnapshot(payload),r=S.calculate(restored).results.get('967-001');assert.equal(r.quantity,0);assert.equal(r.demand,2);assert.equal(Object.hasOwn(restored,'decisions'),false);assert.equal(restored.settings.strategy,'auto');
});
test('old cut without store cube stays unresolved, never silently zeroed',{skip:!fs.existsSync('example-files/order-cut.xlsx')},()=>{
  const o=I.parseWorkbook(XLSX.read(fs.readFileSync('example-files/order-cut.xlsx'),{type:'buffer',nodim:true})),s=S.newSession(o),c=S.calculate(s);
  assert.equal(o.products.length,9);for(const p of o.products){const r=c.results.get(p.sku);assert.equal(r.quantity,r.blocked?0:null);assert.ok(E.validateQuantity(p,r,p.batch));}
});


test('safety stock applies to ordinary goods, has a one-unit floor and no reserve for zero demand',()=>{
  for(const protectedTag of ['', 'И-индикатор']){
    const p=product({stock:0,sales:[0.1,0.1,0.1,0.1],batch:1,commercialA:protectedTag});
    const r=calculate(p).r;assert.equal(r.reserve,1);assert.equal(r.quantity,2);
    const zero=calculate({...p,sales:[0,0,0,0]}).r;assert.equal(zero.reserve,0);assert.equal(zero.quantity,0);
  }
  const r=calculate(product({stock:0,sales:[100,100,100,100],batch:1})).r;
  assert.equal(r.reserve,25);assert.equal(r.quantity,125);assert.equal(r.projection.secondBefore,25);
});
test('global safety percentage changes ordinary goods but never lowers protected goods below 25 percent',()=>{
  const p=product({stock:0,sales:[100,100,100,100],batch:1});
  assert.equal(calculate(p,{}, {safetyStockPercent:10}).r.reserve,10);
  assert.equal(calculate({...p,priceCategory:'ПЦ'}, {},{safetyStockPercent:10}).r.reserve,25);
  assert.equal(calculate({...p,priceCategory:'ПЦ'}, {},{safetyStockPercent:50}).r.reserve,50);
  assert.equal(calculate(p,{}, {safetyStockPercent:0}).r.reserve,1);
  for(const safetyStockPercent of [-1,501,null,'25',NaN]){
    if(safetyStockPercent === null)continue; // null is treated as the default by the pure engine.
    assert.throws(()=>calculate(p,{}, {safetyStockPercent}),/Страховой запас/);
  }
});
test('safety floor remains in every strategy, including an aggressive decrease and low explicit target',()=>{
  const p=product({stock:0,sales:[100,100,100,100],batch:1});
  for(const mode of ['auto','hold','increase','decrease']){
    const r=calculate(p,{mode,percent:mode === 'decrease'?99:0,baseTarget:1}).r;
    assert.equal(r.reserve,25);assert.equal(r.quantity,125);
  }
  for(const patch of [{productCube:'ЗО'},{storeCube:''},{productCube:'Группа-0.8'}])assert.equal(calculate({...p,...patch}).r.quantity,0);
  const capped=calculate({...p,centralStock:100}).r;assert.equal(capped.quantity,100);assert.equal(capped.problem.kind,'supply');
});
test('safety setting is validated atomically and preserves explicit manual quantities',()=>{
  const p=product({stock:1,sales:[2,5,3,6],batch:5}),s=S.newSession({products:[p],metadata:{fingerprint:'t'}},{orderDate:'2026-11-02',incomingDate:'2026-11-05',coverageWeeks:1});
  S.setQuantity(s,S.calculate(s),p.sku,5);
  S.updateSettings(s,{...s.settings,safetyStockPercent:200});const r=S.calculate(s).results.get(p.sku);
  assert.equal(r.autoQuantity,15);assert.equal(r.quantity,5);assert.equal(r.problem.kind,'supply');
  const old=s.settings;assert.throws(()=>S.updateSettings(s,{...old,safetyStockPercent:501}),/Страховой запас/);assert.equal(s.settings,old);
  S.resetQuantity(s,p.sku);assert.equal(S.calculate(s).results.get(p.sku).quantity,15);
});
test('022-344 includes reserve before batch rounding and still identifies shortage before arrival',{skip:!hasFiles},()=>{
  const s=localState(),c=S.calculate(s),r=c.results.get('022-344');
  assert.equal(r.demand,4.5);assert.equal(r.reserve,1.125);assert.equal(r.quantity,10);assert.equal(r.projection.secondBefore,5.5);
  assert.ok(r.projection.lostBefore>0);assert.equal(r.problem.kind,'arrival');
  assert.equal(S.changeRows(s,c).find(row=>row.sku==='022-344').quantity,10);
});
test('2.0 sessions gain the default safety setting, retain manual quantities and recalculate',{skip:!hasFiles},()=>{
  const s=localState();S.setQuantity(s,S.calculate(s),'022-344',5);const payload=S.snapshot(s);
  payload.rulesVersion='sgate-2.0';delete payload.settings.safetyStockPercent;
  const restored=S.restoreSnapshot(payload),r=S.calculate(restored).results.get('022-344');
  assert.equal(restored.settings.safetyStockPercent,25);assert.equal(r.autoQuantity,10);assert.equal(r.quantity,5);assert.equal(r.problem.kind,'supply');
  assert.equal(S.restoreSnapshot(S.snapshot(restored)).settings.safetyStockPercent,25);
});
