import test from'node:test';import assert from'node:assert/strict';import{createImprovementQueue}from'../web/ai-improvement-queue.js';
test('rapid independent clicks are FIFO, deduplicated and serial',async()=>{
 let active=0,maximum=0;const calls=[],results=[],fields={a:'one',b:'two',c:'three'};
 const q=createImprovementQueue({isCurrent:j=>fields[j.key]===j.source,run:async j=>{active++;maximum=Math.max(active,maximum);calls.push(j.key);await new Promise(r=>setTimeout(r,2));active--;return j.source+'.';},onResult:j=>results.push(j.key)});
 for(const key of['a','b','a','c'])q.enqueue({documentId:'doc',key,source:fields[key]});
 await q.drain('doc');assert.deepEqual(calls,['a','b','c']);assert.deepEqual(results,calls);assert.equal(maximum,1);
});
test('edited, removed, switched and cancelled rows cannot apply late output',async()=>{
 for(const change of['edit','remove','switch','cancel']){
  let doc='doc',text='source',resolve;const applied=[];
  const q=createImprovementQueue({isCurrent:j=>j.documentId===doc&&j.source===text,run:()=>new Promise(r=>resolve=r),onResult:j=>applied.push(j)});
  q.enqueue({documentId:'doc',key:'a',source:text});
  if(change==='edit')text='manual';if(change==='remove')text=null;if(change==='switch')doc='other';if(change==='cancel')q.cancel('doc');
  resolve('Updated.');await q.drain('doc');await new Promise(r=>setImmediate(r));assert.equal(applied.length,0);
 }
});
test('failed jobs do not stop other jobs; output requires retry or cancellation',async()=>{
 let fail=true;const applied=[];
 const q=createImprovementQueue({isCurrent:()=>true,run:async j=>{if(j.key==='a'&&fail)throw new Error('offline');return j.source;},onResult:j=>applied.push(j.key)});
 q.enqueue({documentId:'doc',key:'a',source:'one'});q.enqueue({documentId:'doc',key:'b',source:'two'});
 await assert.rejects(q.drain('doc'),/échoué/);assert.deepEqual(applied,['b']);
 fail=false;q.enqueue({documentId:'doc',key:'a',source:'one'});await q.drain('doc');assert.deepEqual(applied,['b','a']);
});
test('a cancelled provider failure cannot restore an output error barrier',async()=>{
 let reject;
 const q=createImprovementQueue({isCurrent:()=>true,run:()=>new Promise((_,r)=>reject=r),onResult:()=>assert.fail('Cancelled job applied')});
 q.enqueue({documentId:'doc',key:'a',source:'one'});q.cancel('doc');reject(new Error('offline'));
 await new Promise(r=>setImmediate(r));await q.drain('doc');assert.equal(q.snapshot('doc').errors.length,0);
});
