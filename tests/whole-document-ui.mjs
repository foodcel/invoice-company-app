import {build,preview}from'vite';import{createRequire}from'node:module';import{mkdtemp,rm,mkdir,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{resolve}from'node:path';import assert from'node:assert/strict';
const require=createRequire('C:/Users/Mathys/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'),{chromium}=require('playwright');
const scratch=await mkdtemp(resolve(tmpdir(),'whole-document-ui-')),out=resolve('docs/app-cleanup/issued-quote');let server,browser;const errors=[];
try {
 await mkdir(out,{recursive:true});await build({configFile:false,root:resolve('web'),base:'./',logLevel:'error',build:{outDir:resolve(scratch,'dist'),emptyOutDir:true},resolve:{alias:[{find:/^@tauri-apps\/.*/,replacement:resolve('tests/writing-native-fixture.js')}]}});
 server=await preview({configFile:false,root:resolve('web'),build:{outDir:resolve(scratch,'dist')},preview:{host:'127.0.0.1',port:8792,strictPort:true}});
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1700,height:1100}});page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());await page.addInitScript(()=>window.__bulkFixture=true);
 await page.goto('http://127.0.0.1:8792');await page.locator('[data-correct-document]').click();
 await page.waitForFunction(()=>document.querySelector('[data-correct-document]')?.getAttribute('aria-busy')==='false'&&document.querySelector('[data-field="project"]')?.value==='Projet armoire');
 const fields=await page.locator('[data-field],[data-key],[data-note],[data-payment]').evaluateAll(els=>els.map(e=>({data:{...e.dataset},value:e.value})));
 const value=name=>fields.find(f=>f.data.field===name)?.value;
 assert.equal(value('client'),'Client Exemple');assert.equal(value('address'),'100 rue Exemple QC');assert.equal(value('shipTo'),'200 rue Exemple QC');
 assert.equal(await page.locator('[data-key="description"]').inputValue(),'Armoire en chêne 24 pouces.');assert.equal(await page.locator('[data-note="0"]').inputValue(),'Note pour le client.');
 const calls=await page.evaluate(()=>window.__writingCalls.filter(c=>c.name==='ai_proofread_text').map(c=>c.args.field));assert.deepEqual(calls,['project','client','address','shipTo','prose','prose']);
 assert.equal(await page.locator('[data-key="quantity"]').inputValue(),'1');assert.equal(await page.locator('[data-key="price"]').inputValue(),'100');assert.equal(await page.locator('[data-payment="0"]').inputValue(),'25');
 await page.screenshot({path:resolve(out,'whole-document-corrected.png')});
 await page.locator('[data-field="project"]').fill('Projet armoire Manuel');await page.locator('[data-undo]').click();
 assert.equal(await page.locator('[data-field="project"]').inputValue(),'projet armoir Manuel');assert.equal(await page.locator('[data-field="client"]').inputValue(),'client exemple');assert.equal(await page.locator('[data-note="0"]').inputValue(),'note pour le client');
 assert.deepEqual(errors,[]);await writeFile(resolve(out,'whole-document-ui.json'),JSON.stringify({checks:3,entireWritingScope:calls,manualPreservingUndo:true,numericFieldsUnchanged:true,errors,providerCalls:0},null,2));console.log('WHOLE_DOCUMENT_UI_PASSED checks=3');
}finally{await browser?.close();await server?.httpServer.close();await rm(scratch,{recursive:true,force:true});}
