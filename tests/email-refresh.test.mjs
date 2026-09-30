import test from 'node:test';
import assert from 'node:assert/strict';
import { initialEmailDraft, restoreEmailDraft, createSendFlow, prepareAnotherSend } from '../web/email-composer.js';

const source = { id: 'refresh-test', kind: 'facture', client: 'Camille', email: 'old@example.test', project: 'Escalier', invoiceNumber: 2060, notes: 'Initial note' };
const changed = { ...source, email: 'new@example.test', client: 'Alex', project: 'Armoire', notes: 'Changed note' };
const oldPdf = { path: 'C:\\PDF\\old.pdf', filename: 'old.pdf', draftId: source.id };

test('document edits refresh default recipient, greeting and subject while preserving additional recipients and CC', () => {
  const previous = initialEmailDraft(source);
  previous.to.push('extra@example.test'); previous.cc = ['accountant@example.test']; previous.ccTouched = true;
  previous.attachment = oldPdf; previous.pdfStatus = 'saved';
  const next = restoreEmailDraft(previous, changed);
  assert.deepEqual(next.to, ['new@example.test', 'extra@example.test']);
  assert.deepEqual(next.cc, previous.cc);
  assert.match(next.body, /^Bonjour Alex,/);
  assert.match(next.subject, /Armoire/);
  assert.equal(next.attachment, null);
  assert.equal(next.pdfStatus, 'pending');
  assert.deepEqual(previous.to, ['old@example.test', 'extra@example.test'], 'Restoration must not mutate history');
  const again = restoreEmailDraft(next, { ...changed, email: 'third@example.test' });
  assert.deepEqual(again.to, ['third@example.test', 'extra@example.test']);
});

test('custom email text survives source changes, stale defaults do not return through Undo, and duplicate recipient is avoided', () => {
  const previous = initialEmailDraft(source);
  previous.undo.push({ subject: previous.subject, body: previous.body });
  previous.subject = 'Personal subject'; previous.body = 'Personal message';
  previous.to.push('NEW@example.test');
  const next = restoreEmailDraft(previous, changed);
  assert.equal(next.subject, 'Personal subject'); assert.equal(next.body, 'Personal message');
  assert.deepEqual(next.to, ['NEW@example.test']); assert.deepEqual(next.undo, []);
  assert.deepEqual(restoreEmailDraft(initialEmailDraft(source), { ...source, email: '' }).to, []);
  const unchanged = restoreEmailDraft(previous, source);
  assert.deepEqual(unchanged.to, previous.to);
  assert.deepEqual(unchanged.undo, previous.undo, 'Unchanged document keeps its rewrite history');
});

test('selected English PDF changes invalidate an unsent archive even if French source stays unchanged', () => {
  const previous = restoreEmailDraft(null, source, 'en', { ...source, notes: 'English note one' });
  previous.attachment = oldPdf;
  assert.equal(restoreEmailDraft(previous, source, 'en', { ...source, notes: 'English note two' }).attachment, null);
});

test('source edits preserve accepted/uncertain attempts until an explicitly confirmed new send', async () => {
  for (const sendState of ['accepted', 'uncertain']) {
    const previous = initialEmailDraft(source);
    Object.assign(previous, { sendState, attemptId: 'original-attempt', attachment: oldPdf, pdfStatus: 'saved' });
    const next = restoreEmailDraft(previous, changed);
    assert.equal(next.sendState, sendState); assert.equal(next.attemptId, 'original-attempt');
    assert.deepEqual(next.attachment, oldPdf); assert.equal(next.documentChanged, true);
    let exports = 0, sends = 0;
    const flow = createSendFlow({ model: next, getSettings: () => ({ connected: true, signature: '' }),
      invoke: async (_, args) => { sends++; return { attemptId: args.request.attemptId, senderEmail: 'sender@example.test', acceptedAt: 'now' }; },
      preparePdf: async () => { exports++; return { ...oldPdf, path: 'C:\\PDF\\new.pdf', filename: 'new.pdf' }; }, newAttemptId: () => 'new-attempt' });
    await assert.rejects(flow.send(), /déjà été soumis/); assert.equal(exports, 0); assert.equal(sends, 0);
    assert.equal(prepareAnotherSend(next, false), false);
    assert.equal(prepareAnotherSend(next, true), true);
    await flow.send();
    assert.equal(exports, 1); assert.equal(sends, 1); assert.equal(next.attachment.filename, 'new.pdf');
    assert.equal(next.attemptId, 'new-attempt'); assert.equal(next.documentChanged, false);
  }
});
