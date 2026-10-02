import {sampleDraft} from './fixtures.mjs';
import {invoke as originalInvoke,check,relaunch,open,getCurrentWindow} from './cleanup-native-fixture.js';
import {resolveTax} from '../web/taxes.js';
const clone=structuredClone;
let current={...sampleDraft('facture'),id:'writing-app-probe',validUntil:'',notes:'',noteEntries:[],payments:[],deposit:'',shipTo:'',items:[{description:'armoir en chene 24 pouces',quantity:'1',price:'100'}]};
current.tax=resolveTax({...current,tax:{selection:'auto',fulfillment:'installation'}});
if(window.__bulkFixture){Object.assign(current,{project:'projet armoir',client:'client exemple',address:'100 rue exemple QC',shipTo:'200 rue exemple QC',notes:'note pour le client',noteEntries:['note pour le client'],payments:[{amount:'25',date:'2026-10-01'}]});current.tax=resolveTax({...current,tax:{selection:'QC',fulfillment:'installation'}});}
const snapshot=()=>clone({current,records:[{id:current.id,draft:current,updatedAt:'2026-10-01',exports:[]}],nextInvoiceNumber:2060,pdfDirectory:'C:/isolated',invoicePdfDirectory:'C:/isolated',quotePdfDirectory:'C:/isolated',usingDefaultDirectory:true});
export async function invoke(name,args={}) {
 window.__writingCalls ||= [];window.__writingCalls.push({name,args:clone(args)});
 if(name==='get_ai_settings')return {provider:'chatgpt',chatgptConfigured:true,businessConfigured:false};
 if(name==='load_state')return snapshot();
 if(name==='save_draft'){current=clone(args.draft);current.invoiceNumber=current.kind==='facture'?2060:null;return snapshot();}
 if(name==='ai_proofread_text'){
   if(window.__writingWait)await new Promise(resolve=>window.__writingResolve=resolve);
   if(window.__writingFail)throw new Error('Synthetic AI unavailable');
   const s=args.source;
   if(args.field==='project')return s.replace(/^projet/,'Projet').replace(/armoir\b/,'armoire');
   if(args.field==='client')return s.replace('client exemple','Client Exemple');
   if(['address','shipTo'].includes(args.field))return s.replace('rue exemple','rue Exemple');
   return s.replace(/^armoir/,'Armoire').replace(/\bchene\b/g,'chêne').replace(/^note/,'Note').replace(/(?<![.!?])$/u,'.');
 }
 if(name==='ai_rewrite_line'){
   window.__queueOrder ||= [];window.__queueOrder.push(args.source);
   if(window.__queueHold)await new Promise(resolve=>window.__queueRelease=resolve);
   if(window.__queueFail)throw new Error('Synthetic queue failure');
   return args.source.replace(/^armoir/,'Armoire').replace(/\bchene\b/g,'chêne').replace(/(?<![.!?])$/u,'.');
 }
 if(name==='export_pdf'){window.__writingExports=(window.__writingExports||0)+1;return {snapshot:clone(current),path:'C:/isolated/probe.pdf',filename:'probe.pdf'};}
 if(name==='preview_pdf_filename')return 'Probe.pdf';
 return originalInvoke(name,args);
}
export {check,relaunch,open,getCurrentWindow};
