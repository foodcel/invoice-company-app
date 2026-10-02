import test from 'node:test';import assert from 'node:assert/strict';
import {createAutomaticCorrections,textEdits} from '../web/automatic-corrections.js';
test('queued improvements belong to top Undo and cannot overwrite a newer edit',()=>{
 let text='armoir en chene avec 2 portes';const m=createAutomaticCorrections({getDocumentId:()=> 'doc',getFields:()=>[{key:'a',text}],write:(_,value)=>text=value,proofread:async s=>s});
 assert.equal(m.applyImprovement('a',text,'Armoire en chêne avec 2 portes.'),true);
 text+=' Travail manuel';m.reconcile();m.undoAll();assert.equal(text,'armoir en chene avec 2 portes Travail manuel');
 assert.equal(m.applyImprovement('a','old','Different.'),false);
 assert.throws(()=>m.applyImprovement('a',text,'Armoire avec 3 portes.'),/nombre/);
});
function setup(proofread){let doc='one',fields=[{key:'a',text:'armoir en chene 24 pouces'},{key:'b',text:'livraison incluse'}];let changes=0;
 const manager=createAutomaticCorrections({getDocumentId:()=>doc,getFields:()=>fields,write:(key,text)=>{fields.find(f=>f.key===key).text=text;},proofread,onChange:()=>changes++,timeoutMs:100});
 return {manager,fields,setDoc:id=>doc=id,setFields:f=>fields=f,changes:()=>changes};}
test('diff roundtrips and top Undo removes all AI edits but retains appended manual words',async()=>{
 for(const [a,b]of [['','Armoire.'],['Bonjour.','bonjour'],['armoir en chene','Armoire en chêne.'],['A B C','A C'],['A','B'],['abc xyz','abc xyz suite']]){
  let value=a;for(const e of textEdits(a,b).reverse())value=value.slice(0,e.start)+e.after+value.slice(e.end);assert.equal(value,b);
 }
 const p=setup(async source=>source==='livraison incluse'?'Livraison incluse.':'Armoire en chêne 24 pouces.');
 await p.manager.ensureAll();p.fields[0].text+=' Avec portes';p.manager.observe('a',p.fields[0].text);
 assert.equal(p.manager.undoAll(),2);assert.equal(p.fields[0].text,'armoir en chene 24 pouces Avec portes');assert.equal(p.fields[1].text,'livraison incluse');
 let called=false;const count=p.changes();await p.manager.ensureAll();assert.equal(p.changes(),count);assert.equal(called,false);
});
test('manual replacement of a corrected word remains while other AI patches undo',async()=>{
 const p=setup(async()=> 'Armoire en chêne 24 pouces.');await p.manager.schedule('a');
 p.fields[0].text='Meuble en chêne 24 pouces. Avec tablettes';p.manager.observe('a',p.fields[0].text);p.manager.undoAll();
 assert.equal(p.fields[0].text,'Meuble en chene 24 pouces Avec tablettes');
});
test('late responses cannot modify edited, removed or switched-document fields',async()=>{
 for(const mutation of ['edit','remove','switch']){
  let resolve;const p=setup(()=>new Promise(r=>resolve=r));const work=p.manager.schedule('a');await Promise.resolve();
  if(mutation==='edit'){p.fields[0].text='Texte manuel';p.manager.observe('a','Texte manuel');}
  if(mutation==='remove')p.fields.splice(0,1);if(mutation==='switch')p.setDoc('two');
  resolve('Armoire en chêne 24 pouces.');await work;assert.equal(p.changes(),0);
 }
});
test('failed or numerically changed corrections block output; retry succeeds',async()=>{
 let fail=true;const p=setup(async s=>{if(fail)throw new Error('offline');return s+'.';});
 await assert.rejects(p.manager.ensureAll(),/offline/);assert.equal(p.fields[0].text,'armoir en chene 24 pouces');fail=false;await p.manager.ensureAll();
 const bad=setup(async()=> 'Armoire 25 pouces.');await assert.rejects(bad.manager.ensureAll(),/nombre/);
});
test('Undo cancels pending results and accepts deliberately reverted text without recorrection',async()=>{
 let resolve;let calls=0;const p=setup(()=>{calls++;return new Promise(r=>resolve=r);});const work=p.manager.schedule('a');await Promise.resolve();
 p.manager.undoAll();resolve('Armoire en chêne 24 pouces.');await work;await p.manager.ensureAll();assert.equal(calls,1);assert.equal(p.changes(),0);
});
test('explicit whole-document correction includes names and addresses; ordinary output stays prose-only',async()=>{
 const fields=[{key:'field:project',text:'projet armoir',automatic:false},{key:'field:client',text:'client exemple',automatic:false},{key:'field:address',text:'100 rue exemple QC',automatic:false},{key:'line',text:'armoir 24 pouces'}];
 const calls=[];
 const m=createAutomaticCorrections({getDocumentId:()=> 'doc',getFields:()=>fields,write:(key,text)=>fields.find(f=>f.key===key).text=text,proofread:async(s,key)=>{calls.push(key);return s.replace('armoir','armoire').replace(/^projet/,'Projet').replace(/^client exemple/,'Client Exemple').replace('rue exemple','rue Exemple');}});
 await m.ensureAll();assert.deepEqual(calls,['line']);calls.length=0;
 await m.ensureAll({includeManual:true,force:true});assert.deepEqual(calls,fields.map(f=>f.key));
 assert.equal(fields[0].text,'Projet armoire');assert.equal(fields[1].text,'Client Exemple');assert.equal(fields[2].text,'100 rue Exemple QC');
 fields[0].text+=' Manuel';m.undoAll();assert.equal(fields[0].text,'projet armoir Manuel');assert.equal(fields[1].text,'client exemple');assert.equal(fields[2].text,'100 rue exemple QC');
});
