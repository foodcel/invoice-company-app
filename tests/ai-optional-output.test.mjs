import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PDFDocument} from 'pdf-lib';
import {createPdf} from '../web/pdf.js';
import {createAutomaticCorrections} from '../web/automatic-corrections.js';
import {createImprovementQueue} from '../web/ai-improvement-queue.js';
import {createSendFlow,initialEmailDraft} from '../web/email-composer.js';
import {sampleDraft} from './fixtures.mjs';

const production=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
function section(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function probe({source=production,archiveFailure=false,invalid=false,oversize=false}={}) {
  const draft={...sampleDraft('facture'),items:[{description:'armoir en chene',quantity:'2',price:'100'}]};
  const events=[],notices=[],pending=[];let mode='failed',providerCalls=0,composer;
  const c={state:draft,busy:false,mailOpen:false,englishMode:false,records:[],editRevision:1,savedRevision:0,
    numberEditing:false,numberConfirm:null,numberError:'',outputStatus:'',Uint8Array,
    copy:structuredClone,formatEnteredField(){},readyForOutput:()=>!invalid,
    ensureInvoiceNumberConfirmed:async()=>true,confirm:()=>true,
    setBusy:v=>c.busy=v,flushChanges:async()=>true,render(){},finishMail(){},
    notice:v=>notices.push(v),errorText:e=>e.message,customerDraft:()=>c.state,
    validateDescriptionLimits:async()=>{},writingIds:()=>({items:['line']}),
    descriptionLimits:new Map(oversize?[[`${draft.id}:line`,true]]:[]),
    createPdf:async(...args)=>{events.push('pdf');return createPdf(...args);},
    printPdf:async bytes=>{assert.ok((await PDFDocument.load(bytes)).getPageCount());events.push('print');},
    runCommand:async(name,args)=>{
      if(name==='preview_pdf_filename')return 'Test.pdf';
      if(name==='load_state')return {current:c.state};
      assert.equal(name,'export_pdf');
      assert.ok((await PDFDocument.load(Uint8Array.from(args.pdfBytes))).getPageCount());
      events.push('archive');if(archiveFailure)throw new Error('Archive inaccessible');
      return {snapshot:{...args.draft,issuedNumber:2060},path:'C:/isolated/Test.pdf',filename:'Test.pdf'};
    },applySnapshot:s=>c.state=s.current,
    openEmailComposer:async options=>{composer=options;events.push('composer');}
  };
  const provider=async text=>{providerCalls++;if(mode==='failed')throw new Error('Réponse ChatGPT trop volumineuse.');if(mode==='pending')return new Promise(resolve=>pending.push(resolve));return 'Armoire en chêne.';};
  const automatic=createAutomaticCorrections({getDocumentId:()=>c.state.id,getFields:()=>[{key:'line',text:c.state.items[0].description}],
    write:(_,text)=>c.state.items[0].description=text,proofread:provider});
  const queue=createImprovementQueue({isCurrent:j=>j.documentId===c.state.id&&j.source===c.state.items[0].description,
    run:j=>provider(j.source),onResult:j=>automatic.applyImprovement(j.key,j.source,j.result)});
  Object.assign(c,{automatic,improvements:queue});
  vm.runInNewContext(section(source,'    async function finishWritingForOutput()','    async function correctDocumentWriting()')+
    section(source,'    async function printDocument()','    function finishMail()')+
    section(source,'    async function composeEmail()','    async function loadState()'),c);
  return {c,events,notices,automatic,queue,pending,setMode:v=>mode=v,calls:()=>providerCalls,
    async failBoth(){await automatic.schedule('line');queue.enqueue({documentId:c.state.id,key:'line',source:c.state.items[0].description});await assert.rejects(queue.drain(c.state.id),/échoué/);},
    async send(){await c.composeEmail();assert.ok(composer,'Composer opens despite unavailable AI');
      const model=initialEmailDraft(composer.draft);const flow=createSendFlow({model,getSettings:()=>({connected:true,signature:''}),preparePdf:composer.preparePdf,
        newAttemptId:()=> 'isolated-attempt',invoke:async(name,args)=>{assert.equal(name,'send_outlook_mail');assert.equal(args.path,'C:/isolated/Test.pdf');events.push('send');return {attemptId:args.request.attemptId,senderEmail:'sender@example.test',acceptedAt:'test'};}});
      await flow.send();return model;}
  };
}

test('failed corrections and queued improvements do not block composer, actual PDF attachment or mocked send',async()=>{
  const p=probe();await p.failBoth();const calls=p.calls();const original=structuredClone(p.c.state);
  const model=await p.send();assert.equal(model.sendState,'accepted');
  assert.deepEqual(p.events,['composer','pdf','archive','send']);assert.equal(p.calls(),calls,'Output makes no AI requests');
  assert.deepEqual(p.c.state.items,original.items);assert.deepEqual(p.c.state.payments,original.payments);
});
test('pending AI cannot stall sending or overwrite the sent text when it finishes late',async()=>{
  const p=probe();p.setMode('pending');const running=p.automatic.schedule('line');
  p.queue.enqueue({documentId:p.c.state.id,key:'line',source:p.c.state.items[0].description});await Promise.resolve();
  assert.equal(p.pending.length,2);await p.send();assert.equal(p.events.at(-1),'send');
  for(const resolve of p.pending)resolve('CHANGED LATE');await running;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(p.c.state.items[0].description,'armoir en chene');assert.equal(p.automatic.snapshot().pending,0);
});
test('PDF and Print work without any AI check; accepted corrections retain Undo',async()=>{
  for(const operation of ['exportDocument','printDocument']){
    const p=probe();await p.failBoth();const calls=p.calls();await p.c[operation]();assert.equal(p.calls(),calls);
    assert.ok(p.events.includes(operation==='printDocument'?'print':'archive'));
  }
  const p=probe();p.setMode('success');await p.automatic.schedule('line');await p.c.finishWritingForOutput();
  assert.equal(p.c.state.items[0].description,'Armoire en chêne.');p.automatic.undoAll();assert.equal(p.c.state.items[0].description,'armoir en chene');
});
test('document, page-capacity and archive failures still block email sending',async()=>{
  for(const options of [{invalid:true},{oversize:true},{archiveFailure:true}]){
    const p=probe(options);await p.failBoth();await assert.rejects(p.send());assert.ok(!p.events.includes('send'));
  }
});
test('the former mandatory-AI gate fails the same output assertion in an isolated source copy',async()=>{
  const defective=production.replace(/improvements\.cancel\(id\);\r?\n      automatic\.useCurrentText\(\);/,'await improvements.drain(id);\n      await automatic.ensureAll();');
  assert.ok(defective!==production,'Old defect actually injected');const p=probe({source:defective});await p.failBoth();
  await assert.rejects(p.send(),/Composer opens/);assert.ok(p.notices.some(n=>n.includes('Une amélioration IA a échoué')));assert.deepEqual(p.events,[]);
});
