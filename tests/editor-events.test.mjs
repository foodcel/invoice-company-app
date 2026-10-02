import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { paymentTotal } from '../web/payments.js';
import { formatPhoneInput } from '../web/phone.js';

// Execute the production listeners, with native I/O and rendering isolated.
// This checks event routing and state effects, not a native WebView click-through.
function editor(source) {
  const start = source.indexOf("    document.addEventListener('click', async event => {");
  const end = source.indexOf("    document.addEventListener('change', event => {");
  assert.ok(start >= 0 && end > start, 'Production event listeners were not found');
  const listeners = {}, calls = { dirty: 0, saves: 0, render: 0, undo: 0, mail: 0, mailSettings: 0, transitions: [] };
  const state = { id: 'probe', kind: 'facture', client: '', items: [{ description: '', quantity: '1', price: '' }], payments: [{ amount: '', date: '' }] };
  const context = {
    undoStack:[],undoGroup:null,
    flushChanges:async()=>true,
    nativeTransition:async(name,args)=>{calls.transitions.push({name,args});return true;},
    automatic: {reconcile() {}, observe() {}, snapshot:()=>({undoable:false}), schedule:async()=>{}},
    writingIds:()=>({items:[],notes:[]}), validateDescriptionLimits:async()=>{}, paintWritingStatus() {},
    state, busy: false, rowMotionPending:false, mailOpen: false, englishMode: false, voiceSession: null, voiceRecovery: null,
    voiceRetryBusy: false, lineAssist: null, calendarField: null, calendarView: null,
    closePanelMotion() {},
    async collapseRowMotion() {},
    document: { addEventListener: (name, fn) => listeners[name] = fn, querySelector: () => null },
    rememberUndo: () => calls.undo++, markDirty: () => calls.dirty++,
    saveNow: async () => { calls.saves++; }, render: () => calls.render++,
    releaseVoiceField() {}, releaseVoiceItem() {}, sync() {}, paintValidation() {},
    deposit: () => paymentTotal(state), notice() {},
    composeEmail: async () => calls.mail++, showMailSettings: async () => calls.mailSettings++,
    formatPhoneInput, Event: class { constructor(type) { this.type = type; } }
  };
  const dateStart = source.indexOf('    const pad2 =');
  const dateEnd = source.indexOf('    const monthNames =', dateStart);
  assert.ok(dateStart >= 0 && dateEnd > dateStart, 'Production date helpers were not found');
  vm.runInNewContext(source.slice(dateStart, dateEnd) + source.slice(start, end), context);
  const input = (dataset, value) => listeners.input({ target: { dataset, value, tagName: 'INPUT', hasAttribute: () => false } });
  const click = async (attribute, dataset = {}) => {
    const button = { dataset, hasAttribute: name => name === attribute, closest: () => null };
    await listeners.click({ target: { dataset: {}, closest: () => button } });
  };
  return { state, calls, context, input, click };
}

test('type switch initializes absent quote validity from original date and preserves a custom date', async () => {
  const probe = editor(await readFile(new URL('../web/app.js', import.meta.url), 'utf8'));
  Object.assign(probe.state, { date: '2026-12-20', validUntil: '', dueDate: '' });
  await probe.click('', { kind: 'soumission' });
  assert.equal(probe.state.validUntil, '2027-01-19');
  assert.equal(probe.state.dueDate, '');
  assert.equal(probe.calls.saves, 1);
  await probe.click('', { kind: 'facture' });
  probe.state.validUntil = '2027-02-10';
  await probe.click('', { kind: 'soumission' });
  assert.equal(probe.state.validUntil, '2027-02-10');
});

test('issued invoice Soumission click opens a native quote copy and Undo retains original identity', async () => {
  const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  async function exercise(code) {
    const probe=editor(code);probe.state.issuedNumber=2060;
    await probe.click('',{kind:'soumission'});
    assert.deepEqual(probe.calls.transitions.map(t=>[t.name,t.args.id]),[['create_quote_from_invoice','probe']]);
    assert.equal(probe.context.undoStack[0].openId,'probe');
    assert.equal(probe.calls.dirty,0,'Original invoice is not converted in place');
  }
  await exercise(source);
  const start=source.indexOf('        if (state.issuedNumber) {',source.indexOf('      if (b.dataset.kind) {'));
  const end=source.indexOf('        rememberUndo();',start);assert.ok(start>=0&&end>start);
  await assert.rejects(exercise(source.slice(0,start)+"        if (state.issuedNumber) return;\n"+source.slice(end)),/deep-equal/);
  const failed=editor(source);failed.state.issuedNumber=2060;failed.context.flushChanges=async()=>false;
  await failed.click('',{kind:'soumission'});assert.equal(failed.calls.transitions.length,0);
});

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
  const marker = '      } else if (el.dataset.field) {';
  assert.ok(source.includes(marker));
  const broken = editor(source.replace(marker, marker + "\n        if (b.hasAttribute('data-add-payment')) return;"));
  assert.throws(() => broken.input({ field: 'client' }, 'Peter'), /b is not defined/);
});

test('production Send and Outlook settings route once and respect active voice/editor overlays', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const probe = editor(source);
  await probe.click('data-send-email');
  await probe.click('data-mail-settings');
  assert.equal(probe.calls.mail, 1);
  assert.equal(probe.calls.mailSettings, 1);
  probe.context.mailOpen = true;
  await probe.click('data-send-email');
  assert.equal(probe.calls.mail, 1);
  probe.context.mailOpen = false;
  probe.context.voiceSession = { stopping: false };
  await probe.click('data-send-email');
  assert.equal(probe.calls.mail, 1);
});

test('quantity arrows update totals through normal input routing and remain undoable and dirty', async () => {
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const probe = editor(source);
  const control = { value: '1', dataset: { item: '0', key: 'quantity' }, tagName: 'INPUT', hasAttribute: () => false,
    dispatchEvent: () => probe.input(control.dataset, control.value) };
  probe.context.document.querySelector = selector => selector.includes('quantity') ? control : null;
  await probe.click('', { quantityStep: '1', line: '0' });
  assert.equal(probe.state.items[0].quantity, '2');
  await probe.click('', { quantityStep: '-1', line: '0' });
  assert.equal(probe.state.items[0].quantity, '1');
  await probe.click('', { quantityStep: '-1', line: '0' });
  assert.equal(probe.state.items[0].quantity, '1', 'Quantity never becomes zero');
  control.value = '1,5';
  await probe.click('', { quantityStep: '-1', line: '0' });
  assert.equal(probe.state.items[0].quantity, '0,5', 'Manual fractional quantity stays supported');
  assert.equal(probe.calls.undo, 4);
  assert.equal(probe.calls.dirty, 4);
});
