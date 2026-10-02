import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PDFDocument} from 'pdf-lib';
import {createPdf} from '../web/pdf.js';
import {sampleDraft} from './fixtures.mjs';

const production = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function probe({issued = false, failure = false, ready = true, mutated = false} = {}) {
  const nativeCalls = [], printCalls = [], notices = [], listeners = {};
  const initial = {...sampleDraft('facture'), issuedNumber: issued ? 2060 : null};
  const native = {current: structuredClone(initial), nextInvoiceNumber: issued ? 2061 : 2060,
    records: [{id: initial.id, draft: structuredClone(initial), exports: issued ? [{path:'existing.pdf'}] : []}]};
  const context = {
    finishWritingForOutput:async()=>{},
    Uint8Array, state: structuredClone(initial), busy: false, englishMode: false,
    editRevision: 1, savedRevision: 0, saveTimer: null, lastSavedAt: null,
    outputStatus: '', clearTimeout, Date,
    copy: structuredClone, createPdf, readyForOutput: () => ready,
    setBusy: value => { context.busy = value; }, setSaveStatus() {}, sync() {}, render() {},
    applySnapshot: response => {context.state = structuredClone(response.current);},
    notice: text => notices.push(text), errorText: error => error.message,
    customerDraft: () => ({...context.state, project: 'Reviewed English project'}),
    runCommand: async (name, args) => {
      nativeCalls.push(name);
      if (name !== 'save_draft') throw new Error('Print attempted native archive or numbering');
      native.current = structuredClone(args.draft); native.records[0].draft = structuredClone(args.draft);
      return structuredClone(native);
    },
    printPdf: async bytes => {
      const pdf = await PDFDocument.load(bytes);
      printCalls.push({pages: pdf.getPageCount(), size: pdf.getPage(0).getSize()});
      if (failure) throw new Error('Synthetic print-dialog failure');
      // Returning also models cancel: there is no reliable physical-print receipt.
    },
    document: {addEventListener: (name, listener) => {listeners[name] = listener;}, querySelector: () => null},
    rowMotionPending: false, mailOpen: false, voiceSession: null, voiceRecovery: null,
    voiceRetryBusy: false, lineAssist: null, showValidation: false, numberEditing: false,
    numberConfirm: null, numberError: '', closePanelMotion() {}, rememberUndo() {},
    markDirty: () => context.editRevision++
  };
  const saveStart = production.indexOf('    async function saveNow(');
  const saveEnd = production.indexOf('    function rememberUndo(', saveStart);
  const printStart = production.indexOf('    async function printDocument(');
  const printEnd = production.indexOf('    async function exportDocument(', printStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart && printStart >= 0 && printEnd > printStart);
  let printSource = production.slice(printStart, printEnd);
  if (mutated) {
    const bad = printSource.replace('await printPdf(bytes);', "await runCommand('export_pdf', {draft, pdfBytes:Array.from(bytes)}); await printPdf(bytes);");
    assert.notEqual(bad, printSource, 'Mutation actually injected'); printSource = bad;
  }
  vm.runInNewContext(production.slice(saveStart, saveEnd) + printSource, context);
  const eventStart = production.indexOf("    document.addEventListener('click', async event => {");
  const eventEnd = production.indexOf("    document.addEventListener('change', event => {");
  assert.ok(eventStart > 0 && eventEnd > eventStart);
  vm.runInNewContext(production.slice(eventStart, eventEnd), context);
  return {context, native, nativeCalls, printCalls, notices,
    click: (attribute, dataset = {}) => listeners.click({target: {dataset:{}, closest: () => ({dataset,hasAttribute: name => name === attribute,closest: () => null})}})};
}

function unchangedIssuance(p, before) {
  assert.equal(p.native.nextInvoiceNumber, before.nextInvoiceNumber);
  assert.equal(p.context.state.issuedNumber, before.current.issuedNumber);
  assert.deepEqual(p.native.records[0].exports, before.records[0].exports);
  assert.ok(p.nativeCalls.every(name => name === 'save_draft'), 'Only ordinary draft persistence is permitted');
}
test('Print and cancellation preserve numbering/history and allow an unissued invoice to become a quote', async () => {
  const p = probe(), before = structuredClone(p.native);
  for (let i = 0; i < 2; i++) await p.click('data-print');
  assert.equal(p.printCalls.length, 2, 'Production Print click actually reaches the printer');
  assert.deepEqual(p.printCalls[0], {pages:1,size:{width:612,height:792}});
  unchangedIssuance(p, before);
  assert.equal(p.context.busy, false);
  await p.click('', {kind:'soumission'});
  assert.equal(p.context.state.kind, 'soumission');
  assert.equal(p.native.current.kind, 'soumission');
});
test('printing an already issued invoice adds no archived version and failures consume no number', async () => {
  for (const issued of [false,true]) for (const failure of [false,true]) {
    const p = probe({issued,failure}), before = structuredClone(p.native);
    await p.click('data-print'); assert.equal(p.printCalls.length, 1);
    unchangedIssuance(p, before); assert.equal(p.context.busy, false);
    if (failure) assert.ok(p.notices.some(text => text.includes('Synthetic print-dialog failure')));
  }
});
test('Save Draft persists edits without a PDF; invalid documents cannot print', async () => {
  const p = probe(), before = structuredClone(p.native);
  p.context.state.client = 'Edited test client';
  await p.context.saveNow(true);
  assert.equal(p.native.current.client, 'Edited test client');
  unchangedIssuance(p,before); assert.equal(p.printCalls.length,0);
  const invalid = probe({ready:false}); await invalid.click('data-print');
  assert.deepEqual(invalid.nativeCalls, []); assert.deepEqual(invalid.printCalls, []);
});
test('print side-effect observer rejects injected export-before-print defect', async () => {
  const p = probe({mutated:true}), before = structuredClone(p.native);
  await p.click('data-print');
  assert.ok(p.nativeCalls.includes('export_pdf'), 'Known defect was exercised');
  assert.throws(() => unchangedIssuance(p,before), /Only ordinary draft persistence/);
});
