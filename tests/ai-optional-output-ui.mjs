import {build,preview} from 'vite';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
const require=createRequire('C:/Users/Mathys/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=require('playwright');
const scratch=await mkdtemp(resolve(tmpdir(),'ai-optional-ui-')),out=resolve('docs/app-cleanup/ai-email-033');
let browser,server,lastPage;const errors=[],results=[];
try {
  await mkdir(out,{recursive:true});
  await build({configFile:false,root:resolve('web'),base:'./',logLevel:'error',build:{outDir:resolve(scratch,'dist'),emptyOutDir:true},resolve:{alias:[{find:/^@tauri-apps\/.*/,replacement:resolve('tests/ai-optional-native-fixture.js')}]}});
  server=await preview({configFile:false,root:resolve('web'),build:{outDir:resolve(scratch,'dist')},preview:{host:'127.0.0.1',port:8793,strictPort:true}});
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const mode of ['failed','pending','disconnected']){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();lastPage=page;
    page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());
    await page.addInitScript(value=>window.__testAiMode=value,mode);
    await page.goto('http://127.0.0.1:8793');await page.locator('[data-send-email]').waitFor();
    if(mode!=='disconnected'){
      await page.locator('[data-line-enhance="0"]').click();
      await page.waitForFunction(m=>document.querySelector('[data-line-enhance="0"]')?.dataset.aiQueueState===(m==='failed'?'error':'running'),mode);
    }
    await page.locator('[data-key="description"]').fill('armoir en chene manuel');
    await page.locator('[data-note="0"]').fill('note manuelle');
    await page.locator('[data-field="client"]').click();
    await page.waitForFunction(()=>window.__testCalls.some(c=>c.name==='ai_proofread_text'));
    if(mode!=='pending')await page.waitForFunction(()=>document.querySelector('[data-writing-status]')?.textContent.includes('indisponible'));
    const aiBefore=await page.evaluate(()=>window.__testCalls.filter(c=>c.name.startsWith('ai_')).length);
    await page.locator('[data-send-email]').click();
    const composer=page.locator('.em-composer');await composer.waitFor({timeout:10000});
    const send=composer.getByRole('button',{name:'Envoyer',exact:true});await send.click();
    await page.waitForFunction(()=>document.querySelector('.em-status')?.textContent.includes('Outlook a accepté le message'));
    if(mode==='pending'){
      await page.evaluate(()=>{for(const resolve of window.__testHeld)resolve('CHANGED LATE');});
      await page.waitForFunction(()=>document.querySelector('[data-line-enhance="0"]')?.getAttribute('aria-busy')==='false');
    }
    const calls=await page.evaluate(()=>window.__testCalls),exports=calls.filter(c=>c.name==='export_pdf'),sends=calls.filter(c=>c.name==='send_outlook_mail');
    assert.equal(exports.length,1);assert.equal(sends.length,1);assert.equal(calls.filter(c=>c.name.startsWith('ai_')).length,aiBefore);
    assert.equal(exports[0].args.draft.items[0].description,'armoir en chene manuel');
    assert.equal((await page.evaluate(()=>window.__testCurrent())).items[0].description,'armoir en chene manuel');
    const pdf=await PDFDocument.load(Uint8Array.from(exports[0].args.pdfBytes));assert.ok(pdf.getPageCount()>0);
    assert.equal(sends[0].args.path,'C:/isolated/Test.pdf');
    await page.screenshot({path:resolve(out,`email-${mode}.png`)});
    results.push({mode,composerOpened:true,actualPdfPages:pdf.getPageCount(),mockedSends:sends.length,outputAiCalls:0});await context.close();
  }
  assert.deepEqual(errors,[]);await writeFile(resolve(out,'browser-receipt.json'),JSON.stringify({results,errors,externalSends:0,providerCalls:0},null,2));
  console.log('AI_OPTIONAL_OUTPUT_UI_PASSED scenarios='+results.length);
}catch(error){
  if(lastPage&&!lastPage.isClosed()){await lastPage.screenshot({path:resolve(out,'failure.png')});console.error(JSON.stringify({errors,diagnostic:await lastPage.evaluate(()=>({calls:window.__testCalls?.map(c=>c.name),status:document.querySelector('[data-writing-status]')?.textContent,toast:document.querySelector('#toast')?.textContent}))}));}throw error;
}finally{
  await browser?.close();await new Promise(resolve=>server?.httpServer?server.httpServer.close(resolve):resolve());
  const owned=resolve(scratch);assert.ok(owned.startsWith(resolve(tmpdir())+sep+'ai-optional-ui-'));
  await rm(scratch,{recursive:true,force:true});
}
