import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import { createPdf } from '../web/pdf.js';
import { sampleDraft } from './fixtures.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function exportProbe({ fail = false, prior = false, production = source } = {}) {
  const begin = production.indexOf('    async function exportDocument(');
  const end = production.indexOf('    function finishMail()', begin);
  assert.ok(begin > 0 && end > begin);
  const events = [];
  const draft = { ...sampleDraft(), id: 'isolated-email', kind: 'facture', invoiceNumber: 2060, issuedNumber: null };
  const context = {
    busy: false, state: draft, records: prior ? [{ id: draft.id, exports: [{}] }] : [],
    pdfDirectory: 'isolated/output', englishMode: false, editRevision: 1, savedRevision: 0,
    numberEditing: false, numberConfirm: null, numberError: '', outputStatus: '', Uint8Array,
    copy: value => structuredClone(value), readyForOutput: () => true,
    confirm: () => { throw new Error('Unexpected confirmation during reviewed email send'); },
    setBusy: value => { context.busy = value; }, flushChanges: async () => { events.push('draft-saved'); return true; },
    createPdf: async (...args) => { events.push('pdf-generated'); return createPdf(...args); },
    runCommand: async (command, args) => {
      if (command === 'load_state') return { current: context.state };
      assert.equal(command, 'export_pdf');
      assert.equal(args.expectedInvoiceNumber, 2060);
      const pdf = await PDFDocument.load(Uint8Array.from(args.pdfBytes));
      assert.ok(pdf.getPageCount() > 0);
      events.push('native-export');
      if (fail) throw new Error('Synthetic archive failure');
      return { path: 'isolated/output/Facture_2060_Client.pdf', filename: 'Facture_2060_Client.pdf',
        nameCollision: prior, snapshot: { ...args.draft, issuedNumber: 2060 } };
    },
    applySnapshot: value => { context.state = value.current; }, render: () => events.push('render'),
    notice: () => {}, errorText: error => error.message, customerDraft: () => context.state,
    window: { print: () => { throw new Error('Email must not print'); } }
  };
  vm.runInNewContext(production.slice(begin, end), context);
  return { context, events };
}

test('email export creates a real durable PDF receipt before mail can use it, including prior-copy case', async () => {
  for (const prior of [false, true]) {
    const { context, events } = exportProbe({ prior });
    const saved = await context.exportDocument(false, true);
    assert.equal(saved.draftId, 'isolated-email');
    assert.equal(saved.filename, 'Facture_2060_Client.pdf');
    assert.equal(saved.path, 'isolated/output/Facture_2060_Client.pdf');
    assert.deepEqual(events.slice(0, 3), ['draft-saved', 'pdf-generated', 'native-export']);
    assert.equal(context.state.issuedNumber, 2060);
    assert.equal(context.busy, false);
  }
});

test('failed PDF export rejects email preparation and leaves invoice unissued', async () => {
  const probe = exportProbe({ fail: true });
  await assert.rejects(probe.context.exportDocument(false, true), /Synthetic archive failure/);
  assert.equal(probe.context.state.issuedNumber, null);
  assert.equal(probe.context.busy, false);
  // Calibrate: swallowing the export error reproduces the unsafe mail-attachment behavior.
  const defective = source.replace('if (forEmail) throw error;', '/* injected swallowed export error */');
  assert.notEqual(defective, source);
  const broken = exportProbe({ fail: true, production: defective });
  await assert.rejects(async () => assert.ok(await broken.context.exportDocument(false, true)), /falsy|false/i);
});

test('incomplete documents cannot produce email attachments', async () => {
  const probe = exportProbe();
  probe.context.readyForOutput = () => false;
  await assert.rejects(probe.context.exportDocument(false, true), /n’est pas prêt/);
  assert.deepEqual(probe.events, []);
});
