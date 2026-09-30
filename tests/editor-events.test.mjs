import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { paymentTotal } from '../web/payments.js';

// Execute the production listeners, with native I/O and rendering isolated.
// This checks event routing and state effects, not a native WebView click-through.
function editor(source) {
  const start = source.indexOf("    document.addEventListener('click', async event => {");
  const end = source.indexOf("    document.addEventListener('change', event => {");
  assert.ok(start >= 0 && end > start, 'Production event listeners were not found');
  const listeners = {}, calls = { dirty: 0, saves: 0, render: 0, undo: 0 };
  const state = { id: 'probe', kind: 'facture', client: '', items: [{ description: '', quantity: '1', price: '' }], payments: [{ amount: '', date: '' }] };
  const context = {
    state, busy: false, englishMode: false, voiceSession: null, voiceRecovery: null,
    voiceRetryBusy: false, lineAssist: null, calendarField: null, calendarView: null,
    document: { addEventListener: (name, fn) => listeners[name] = fn, querySelector: () => null },
    rememberUndo: () => calls.undo++, markDirty: () => calls.dirty++,
    saveNow: async () => { calls.saves++; }, render: () => calls.render++,
    releaseVoiceField() {}, releaseVoiceItem() {}, sync() {}, paintValidation() {},
    deposit: () => paymentTotal(state), notice() {}
  };
  vm.runInNewContext(source.slice(start, end), context);
  const input = (dataset, value) => listeners.input({ target: { dataset, value, tagName: 'INPUT', hasAttribute: () => false } });
  const click = async (attribute, dataset = {}) => {
    const button = { dataset, hasAttribute: name => name === attribute };
    await listeners.click({ target: { dataset: {}, closest: () => button } });
  };
  return { state, calls, context, input, click };
}

test('production form listeners preserve typing and route payment Add/Remove clicks', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const probe = editor(source);
  probe.input({ field: 'client' }, 'Peter');
  probe.input({ item: '0', key: 'description' }, 'Escalier en chêne');
  probe.input({ payment: '0' }, '40,25');
  assert.equal(probe.state.client, 'Peter');
  assert.equal(probe.state.items[0].description, 'Escalier en chêne');
  assert.equal(probe.state.payments[0].amount, '40,25');
  assert.equal(probe.calls.dirty, 3);
  assert.equal(probe.calls.undo, 3);
  await probe.click('data-add-payment');
  assert.equal(probe.state.payments.length, 2);
  probe.input({ payment: '1' }, '15,50');
  probe.context.calendarField = 'payment-1';
  await probe.click('', { removePayment: '0' });
  assert.equal(probe.state.payments.length, 1);
  assert.equal(probe.state.payments[0].amount, '15,50');
  assert.equal(probe.state.deposit, '15.50');
  assert.equal(probe.context.calendarField, null);
  assert.equal(probe.calls.saves, 2);
  await probe.click('', { removePayment: '0' });
  assert.equal(probe.state.payments.length, 1);
  assert.equal(probe.state.payments[0].amount, '');
  assert.equal(probe.state.deposit, '');
  assert.equal(probe.calls.saves, 3);
  // Negative control: the old routing bug must fail on ordinary typing.
  const marker = '      if (el.dataset.field) {';
  assert.ok(source.includes(marker));
  const broken = editor(source.replace(marker, "      if (b.hasAttribute('data-add-payment')) return;\n" + marker));
  assert.throws(() => broken.input({ field: 'client' }, 'Peter'), /b is not defined/);
});
