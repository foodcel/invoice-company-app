// Browser-only transport. No native bridge, credentials, filesystem or mail access.
import {sampleDraft} from './fixtures.mjs';
import {resolveTax} from '../web/taxes.js';
let current={...sampleDraft('facture'),id:'optional-ai-test',project:'Essai courriel',notes:'Note du client.',noteEntries:['Note du client.'],payments:[],deposit:'',items:[{description:'armoir en chene',quantity:'2',price:'100'}]};
current.tax=resolveTax({...current,tax:{selection:'QC',fulfillment:'installation'}});
const clone=structuredClone;
const snapshot=()=>clone({current,records:[{id:current.id,draft:current,exports:[],updatedAt:'2026-10-22'}],nextInvoiceNumber:2060,pdfDirectory:'C:/isolated',invoicePdfDirectory:'C:/isolated',quotePdfDirectory:'C:/isolated',usingDefaultDirectory:true});
window.__testCalls=[];window.__testHeld=[];window.__testCurrent=()=>clone(current);
export async function invoke(name,args={}) {
  window.__testCalls.push({name,args:clone(args)});
  if(name==='load_state')return snapshot();
  if(name==='save_draft'){current=clone(args.draft);return snapshot();}
  if(name==='get_ai_settings')return {provider:'chatgpt',chatgptConfigured:window.__testAiMode!=='disconnected',businessConfigured:false};
  if(name.startsWith('ai_')){
    if(window.__testAiMode==='pending')return new Promise(resolve=>window.__testHeld.push(resolve));
    throw new Error('Réponse ChatGPT trop volumineuse.');
  }
  if(name==='get_mail_settings')return {connected:true,senderEmail:'sender@example.test',signature:'Entreprise fictive',accountantEmail:'',authPending:false};
  if(name==='preview_pdf_filename')return 'Test.pdf';
  if(name==='export_pdf'){
    if(String.fromCharCode(...args.pdfBytes.slice(0,5))!=='%PDF-')throw new Error('Invalid test PDF');
    current={...clone(args.draft),issuedNumber:2060};
    return {snapshot:clone(current),path:'C:/isolated/Test.pdf',filename:'Test.pdf'};
  }
  if(name==='send_outlook_mail')return {attemptId:args.request.attemptId,senderEmail:'sender@example.test',acceptedAt:'2026-10-22T12:00:00Z'};
  throw new Error('Unexpected test command: '+name);
}
export const check=async()=>null;
export const relaunch=async()=>{throw new Error('Test must not relaunch');};
export const open=async()=>null;
export const getCurrentWindow=()=>({setTheme:async()=>{}});
