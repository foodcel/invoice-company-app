// Installed WebView smoke: real document save/preview/composer and a local
// disconnected-AI failure. Never clicks final Send or creates an archive.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {sampleDraft} from './fixtures.mjs';
import {resolveTax} from '../web/taxes.js';
const require=createRequire('C:/Users/Mathys/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const out=resolve('docs/app-cleanup/ai-email-033'),statePath=resolve(process.env.LOCALAPPDATA,'ca.hermitage.invoice-company-app/state.json');await mkdir(out,{recursive:true});
const fileHash=async path=>{try{return createHash('sha256').update(await readFile(path)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const before=await json(statePath),hashes=[];
for(const record of before.records)for(const pdf of record.exports||[])if(pdf.path)hashes.push({path:pdf.path,hash:await fileHash(pdf.path)});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9226');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));assert.ok(page);
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const ready=()=>page.waitForFunction(()=>document.querySelector('[data-live-pdf]')?.getAttribute('aria-busy')==='false'&&document.querySelector('.letter-pdf-page')?.naturalWidth>0);
let temporaryId;const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await ready();assert.equal(await invoke('plugin:app|version'),'0.1.33');
  const aiSettings=await invoke('get_ai_settings');
  assert.ok(!aiSettings.chatgptConfigured&&!aiSettings.businessConfigured,'Only run with disconnected AI: no live provider calls');
  const created=await invoke('new_draft',{kind:'soumission'});temporaryId=created.current.id;
  const draft={...created.current,...sampleDraft('soumission'),id:temporaryId,invoiceNumber:null,issuedNumber:null,
    project:'Essai technique courriel',items:[{description:'armoir en chene',quantity:'2',price:'100'}],noteEntries:[],notes:'',payments:[],deposit:''};
  draft.tax=resolveTax({...draft,tax:{selection:'QC',fulfillment:'installation'}});
  await invoke('save_draft',{draft});await page.reload();await ready();
  await page.locator('[data-key="description"]').fill('armoir en chene manuel');
  await page.locator('[data-field="client"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-writing-status]')?.textContent.includes('Correction IA indisponible'));
  await page.locator('[data-send-email]').click();
  const composer=page.locator('.em-composer');await composer.waitFor({timeout:10000});
  await composer.getByRole('button',{name:'Envoyer',exact:true}).waitFor();
  const mailSettings=await invoke('get_mail_settings');
  if(!mailSettings.connected)assert.ok((await composer.textContent()).includes('Connexion requise'),'Composer shows the missing Outlook connection');
  await page.screenshot({path:resolve(out,'installed-composer-after-ai-failure.png')});
  await composer.getByRole('button',{name:'Annuler',exact:true}).click();
  assert.equal((await invoke('load_state')).current.items[0].description,'armoir en chene manuel');
} finally {
  if(temporaryId){
    await invoke('open_draft',{id:before.currentId});await page.reload();await ready();
    const record=(await invoke('load_state')).records.find(r=>r.id===temporaryId);
    if(record)await invoke('delete_draft',{id:temporaryId,expectedDraft:record.draft});
    await page.reload();await ready();
  }
  await browser.close();
}
const after=await json(statePath);assert.deepEqual(after.records,before.records);assert.deepEqual(after.versions,before.versions);
assert.equal(after.currentId,before.currentId);assert.equal(after.nextInvoiceNumber,before.nextInvoiceNumber);
for(const pdf of hashes)assert.equal(await fileHash(pdf.path),pdf.hash);
assert.deepEqual(errors,[]);await writeFile(resolve(out,'installed-receipt.json'),JSON.stringify({version:'0.1.33',composerAfterDisconnectedAiFailure:true,outlookConnectionStatusShown:true,externalSends:0,liveAiCalls:0,recordsPreserved:before.records.length,pdfsPreserved:hashes.filter(pdf=>pdf.hash!==null).length,preexistingMissingPdfReferences:hashes.filter(pdf=>pdf.hash===null).length,selectionAndCursorPreserved:true,temporaryDraftRemoved:true,errors},null,2));
console.log('INSTALLED_AI_OPTIONAL_OUTPUT_PASSED');
