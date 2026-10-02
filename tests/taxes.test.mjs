import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {addressProvince,newTax,resolveTax,migrateEditableTax,updateTax,calculateTaxTotals,previewTaxTotals,taxIssue,documentLocation} from '../web/taxes.js';
import {createPdf,calculateTotals} from '../web/pdf.js';
import {renderSavedPaper,documentTotal} from '../web/document-library.js';
import {sampleDraft} from './fixtures.mjs';
const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
const base=()=>({...sampleDraft('facture'),tax:newTax(),items:[{description:'Travail de test',quantity:'1',price:'100'}],payments:[{amount:'20',date:'2026-10-01'}],noteEntries:['Note de test'],notes:'Note de test'});

const verifyEditableMigration = module => {
 for(const province of ['QC','ON'])for(const existing of [undefined,null,{}, {fulfillment:'delivery'}, {fulfillment:'delivery',selection:null}, {fulfillment:'installation',selection:'legacy'}]){
  const draft={...base(),tax:structuredClone(existing),shipTo:province==='ON'?'Ottawa ON K1A 0B1':'Montréal QC H1A 1A1'};
  const before=structuredClone(draft);const resolved=module.migrateEditableTax(draft);
  assert.strictEqual(resolved,draft.tax,'Return the resolved tax stored on the draft');
  assert.equal(resolved.selection,'auto');assert.equal(resolved.province,province);assert.equal(resolved.status,'resolved');assert.equal(resolved.basis,'shipTo');
  assert.equal(resolved.fulfillment,existing?.fulfillment||'installation');
  assert.deepEqual({...draft,tax:before.tax},before,'Migration must change only draft.tax');
  assert.equal(module.calculateTaxTotals(draft).total,province==='ON'?113:114.98);
  const migrated=structuredClone(draft);module.migrateEditableTax(draft);assert.deepEqual(draft,migrated,'Migration is idempotent');
 }
};
test('editable tax migration detects both provinces for absent and legacy selections',()=>verifyEditableMigration({migrateEditableTax,calculateTaxTotals}));

test('editable migration retains pickup/delivery decisions and uses billing fallback only when ship-to is empty',()=>{
 for(const fulfillment of ['pickup','delivery','installation']){
  const draft={...base(),tax:{selection:'legacy',fulfillment},shipTo:'Ottawa ON'};
  migrateEditableTax(draft);assert.equal(draft.tax.fulfillment,fulfillment);
  assert.equal(draft.tax.province,fulfillment==='pickup'?'QC':'ON');
  assert.equal(draft.tax.basis,fulfillment==='pickup'?'shop':'shipTo');
  assert.equal(taxIssue(draft),'');
 }
 const fallback={...base(),address:'Ottawa ON',shipTo:'  '};delete fallback.tax;
 migrateEditableTax(fallback);assert.equal(fallback.tax.province,'ON');assert.equal(fallback.tax.basis,'address');
});

test('explicit QC/ON selections survive migration and are recomputed independently of the address',()=>{
 for(const selection of ['QC','ON']){
  const draft={...base(),shipTo:selection==='QC'?'Ottawa ON':'Montréal QC',tax:{selection,fulfillment:'delivery',province:'outside',status:'unsupported',rates:[]}};
  migrateEditableTax(draft);assert.equal(draft.tax.selection,selection);assert.equal(draft.tax.province,selection);
  assert.equal(draft.tax.fulfillment,'delivery');assert.equal(draft.tax.basis,'manual');assert.equal(draft.tax.status,'resolved');
  assert.equal(calculateTaxTotals(draft).total,selection==='ON'?113:114.98);
 }
 const automatic={...base(),shipTo:'Ottawa ON',tax:{selection:'auto',fulfillment:'installation',province:'QC'}};
 migrateEditableTax(automatic);assert.equal(automatic.tax.selection,'auto');assert.equal(automatic.tax.province,'ON');
 automatic.shipTo='Montréal QC';migrateEditableTax(automatic);assert.equal(automatic.tax.province,'QC');
});

test('migration exposes unresolved/unsupported locations without guessing Québec',()=>{
 for(const [address,status] of [['Adresse inconnue','unresolved'],['Vancouver BC','unsupported']]){
  const draft={...base(),shipTo:address,tax:{selection:'legacy',fulfillment:'delivery'}};
  migrateEditableTax(draft);assert.equal(draft.tax.selection,'auto');assert.equal(draft.tax.province,null);assert.equal(draft.tax.status,status);
  assert.equal(calculateTaxTotals(draft).total,null);assert.match(taxIssue(draft),status==='unresolved'?/Confirmer la province/:/personnalisée/);
  assert.doesNotMatch(taxIssue(draft),/Québec conservé/);
 }
});

test('raw historical resolution is pure and keeps legacy Québec until editable migration is applied',()=>{
 for(const tax of [undefined,null,{}, {selection:'legacy',fulfillment:'delivery',rates:[{code:'GST',rateMillionths:50000}]}]){
  const archived={...base(),shipTo:'Ottawa ON',tax};const snapshot=structuredClone(archived);
  if(tax){if(tax.rates){Object.freeze(tax.rates[0]);Object.freeze(tax.rates);}Object.freeze(tax);}
  Object.freeze(archived);
  const raw=resolveTax(archived);assert.equal(raw.selection,'legacy');assert.equal(raw.province,'QC');assert.equal(raw.basis,'legacy');
  assert.equal(calculateTaxTotals(archived).total,114.98);assert.match(taxIssue(archived),/Québec conservé/);
  assert.deepEqual(archived,snapshot,'Historical caller must not be mutated');
  const editable=structuredClone(archived);migrateEditableTax(editable);assert.equal(editable.tax.province,'ON');
  assert.deepEqual(archived,snapshot,'Migrating an editable copy must not alter its archive');
 }
});

let checks=0;
for(const [address,province] of [['Ottawa, ON K1A 0B1','ON'],['Toronto, Ontario, Canada','ON'],['Ripon (Qc) J0V 1V0','QC'],['Québec, Québec G1A 0A1','QC'],['123 rue Ontario, Montréal QC H1A 1A1','QC'],['123 rue Ontario',null],['Ontario, California, USA','outside'],['Vancouver BC V1A 1A1','outside'],['Ottawa ON, Quebec',null],['Ottawa',null],['',null]]){assert.equal(addressProvince(address),province,address);checks++;}
for(const [address,shipTo,fulfillment,profile] of [['Montréal QC','Ottawa ON','installation','ON'],['Ottawa ON','Montréal QC','installation','QC'],['Ottawa ON','Vancouver BC','pickup','QC'],['Montréal QC','Ottawa Ontario','delivery','ON'],['Ottawa ON','','installation','ON'],['Ottawa ON','Adresse inconnue','installation',null]]){
 const d={...base(),address,shipTo};updateTax(d,{fulfillment});assert.equal(resolveTax(d).province,profile);const totals=calculateTaxTotals(d,20);
 assert.equal(totals.total,profile==='ON'?113:profile==='QC'?114.98:null);assert.equal(totals.balance,profile==='ON'?93:profile==='QC'?94.98:null);checks++;
}
const manual=base();manual.shipTo='Ottawa ON';updateTax(manual,{selection:'QC'});manual.shipTo='Toronto ON';updateTax(manual);assert.equal(manual.tax.province,'QC');assert.equal(JSON.parse(JSON.stringify(manual)).tax.selection,'QC');updateTax(manual,{selection:'auto'});assert.equal(manual.tax.province,'ON');checks++;
const legacy=base();delete legacy.tax;legacy.shipTo='Ottawa ON';assert.equal(calculateTaxTotals(legacy).total,114.98);assert.match(taxIssue(legacy),/Québec conservé/);await assert.rejects(createPdf(legacy,{invoiceNumber:2060}),/Québec conservé/);checks++;
const unknown={...base(),shipTo:'Ontario, California, USA'};updateTax(unknown);assert.equal(unknown.tax.status,'unsupported');await assert.rejects(createPdf(unknown,{invoiceNumber:2060}),/personnalisée/);checks++;
for(const province of ['ON','QC'])for(const kind of ['facture','soumission'])for(const language of ['fr','en']){
 const d={...base(),kind,shipTo:province==='ON'?'Ottawa ON':'Montréal QC'};updateTax(d);const totals=calculateTotals(d);assert.equal(documentTotal(d),totals.total);assert.deepEqual(totals,calculateTaxTotals(d,20));
 const saved=renderSavedPaper(d);assert.match(saved,province==='ON'?/TVH \(13 %\)/:/TVQ \(9,975 %\)/);if(province==='ON')assert.doesNotMatch(saved,/TVQ/);
 const bytes=await createPdf(d,{invoiceNumber:2060,language});
 const task=getDocument({data:bytes.slice(),useSystemFonts:true});const pdf=await task.promise;let text='';for(let i=1;i<=pdf.numPages;i++)text+=(await (await pdf.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await task.destroy();
 assert.match(text,province==='ON'?(language==='en'?/HST \(13%\)/:/TVH \(13 %\)/):(language==='en'?/QST \(9.975%\)/:/TVQ \(9,975 %\)/));if(province==='ON')assert.doesNotMatch(text,/(?:QST|TVQ) \(/);assert.match(text,/848045563 RT0001/);assert.match(text,/1212260726 TQ0001/);checks++;
}
const fractional={...base(),items:[{description:'Fraction',quantity:'1.25',price:'10.01'}]};updateTax(fractional,{selection:'ON'});assert.equal(calculateTotals(fractional).subtotal,12.51);assert.equal(calculateTotals(fractional).hst,1.63);checks++;
const tooLarge={...base(),items:[{description:'Limite',quantity:'1000000000',price:'1000000000'}]};assert.equal(previewTaxTotals(tooLarge).total,null);assert.match(taxIssue(tooLarge),/trop élevé/);await assert.rejects(createPdf(tooLarge,{invoiceNumber:2060}),/trop élevé/);checks++;
const pickup={...base(),shipTo:'99 Toronto ON'};updateTax(pickup,{fulfillment:'pickup'});
for(const language of ['fr','en']){assert.match(documentLocation(pickup,language).address,/Ripon/);assert.match(renderSavedPaper(pickup),/Retrait à l’atelier/);const bytes=await createPdf(pickup,{invoiceNumber:2060,language});const task=getDocument({data:bytes.slice(),useSystemFonts:true});const pdf=await task.promise;let text='';for(let i=1;i<=pdf.numPages;i++)text+=(await (await pdf.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');await task.destroy();assert.match(text,language==='fr'?/RETRAIT À L’ATELIER/i:/PICKUP AT THE WORKSHOP/i);assert.doesNotMatch(text,/99 Toronto/);assert.equal(pickup.shipTo,'99 Toronto ON');checks++;}
// Mutate only isolated module copies; the same Ontario oracle must go RED.
const verifyOntario = module => {const draft={...base(),shipTo:'Ottawa ON'};assert.equal(module.resolveTax(draft).province,'ON');assert.equal(module.calculateTaxTotals(draft).total,113);};
verifyOntario({resolveTax,calculateTaxTotals});
const source=await readFile(new URL('../web/taxes.js',import.meta.url),'utf8');
for(const [anchor,replacement] of [["basis=String(draft.shipTo||'').trim()?'shipTo':'address'","basis='address'"],["ON: [{code:'HST',rateMillionths:130000}]","ON: [{code:'HST',rateMillionths:150000}]"]]){
 assert.equal(source.split(anchor).length-1,1,'Mutation must inject once');
 const broken=await import('data:text/javascript;base64,'+Buffer.from(source.replace(anchor,replacement)).toString('base64'));
 assert.throws(()=>verifyOntario(broken),assert.AssertionError);checks++;
}
test('migration oracle rejects legacy retention and lost fulfillment in isolated module copies',async()=>{
 for(const [anchor,replacement] of [["selection:'auto'};","selection:'legacy'};"],["draft.tax={...newTax(),...draft.tax,selection:'auto'};","draft.tax={...newTax(),selection:'auto'};"]]){
  assert.equal(source.split(anchor).length-1,1,'Mutation must inject exactly once');
  const broken=await import('data:text/javascript;base64,'+Buffer.from(source.replace(anchor,replacement)).toString('base64'));
  assert.throws(()=>verifyEditableMigration(broken),assert.AssertionError);
 }
});
console.log(`TAX_TESTS_PASSED checks=${checks} inMemoryPdfs=10 negativeControls=2`);
