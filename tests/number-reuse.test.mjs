import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function probe(accept = false) {
  const calls = [];
  const context = { state: { id: 'new-invoice', kind: 'facture', invoiceNumber: 2060, manualInvoiceNumber: null },
    records: [{ draft: { issuedNumber: 2060 } }], confirm: text => { calls.push(['warning', text]); return accept; },
    flushChanges: async () => { calls.push(['save']); return true; },
    runCommand: async (command, args) => { calls.push([command, args]); return { current: { ...context.state, manualInvoiceNumber: 2060 } }; },
    applySnapshot: value => { context.state = value.current; }, notice: text => calls.push(['error', text]), errorText: String };
  const begin = source.indexOf('    async function ensureInvoiceNumberConfirmed()');
  const end = source.indexOf('    async function checkForStartupUpdate()', begin);
  assert.ok(begin > 0 && end > begin); vm.runInNewContext(source.slice(begin, end), context);
  return { context, calls };
}

test('automatic reuse warns before PDF/print/email archival and cancellation makes no native call', async () => {
  const p = probe(false);
  assert.equal(await p.context.ensureInvoiceNumberConfirmed(), false);
  assert.equal(p.calls.length, 1); assert.match(p.calls[0][1], /2060.*existe déjà/);
});
test('reuse confirmation saves first, binds to document and number, and does not reset cursor', async () => {
  const p = probe(true);
  assert.equal(await p.context.ensureInvoiceNumberConfirmed(), true);
  assert.deepEqual(p.calls.map(c => c[0]), ['warning', 'save', 'confirm_invoice_number_reuse']);
  assert.equal(p.calls[2][1].draftId, 'new-invoice'); assert.equal(p.calls[2][1].expectedNumber, 2060);
  assert.equal(await p.context.ensureInvoiceNumberConfirmed(), true); assert.equal(p.calls.length, 3);
  const q = probe(true); q.context.state.issuedNumber = 2060;
  assert.equal(await q.context.ensureInvoiceNumberConfirmed(), true); assert.equal(q.calls.length, 0);
  const s = probe(true); s.context.state.kind = 'soumission';
  assert.equal(await s.context.ensureInvoiceNumberConfirmed(), true); assert.equal(s.calls.length, 0);
});
