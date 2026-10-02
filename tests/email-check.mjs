// Pure product helpers and injected transport. No DOM shim, credentials or provider traffic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_SIGNATURE, validEmail, initialEmailDraft, messageIssues, fullBody,
  applyRewrite, undoRewrite, attachmentMetadata, createSendFlow, mailSettingsPayload, pdfPreviewBlob, prepareAnotherSend,
} from '../web/email-composer.js';

let checks = 0;
async function check(name, run) {
  await run(); checks++;
  console.log(`ok ${checks} - ${name}`);
}
const draft = { id: 'invoice-01', kind: 'facture', client: 'Camille', email: 'camille@example.test', invoiceNumber: 2061, project: 'Escalier' };
const settings = { connected: true, senderEmail: 'sender@example.test', accountantEmail: 'accountant@example.test', signature: 'Entreprise\nTéléphone' };
const fresh = () => initialEmailDraft(draft, 'fr', settings);
const archived = () => ({ draftId: 'final-native-id', path: 'C:\\PDF\\Facture_2061.pdf', filename: 'Facture_2061.pdf' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

await check('invoice-only accountant defaults, no invented recipient, French and English messages', () => {
  assert.deepEqual(fresh().cc, ['accountant@example.test']);
  const quote = initialEmailDraft({ ...draft, kind: 'soumission' }, 'en', settings);
  assert.deepEqual(quote.cc, []); assert.match(quote.subject, /^Quote/); assert.match(quote.body, /quote attached/);
  assert.deepEqual(initialEmailDraft({ ...draft, email: '' }).to, []);
  assert.match(fresh().subject, /2061 — Escalier/);
  assert.equal(initialEmailDraft(draft).attachment, null);
});

await check('multiple recipients validated independently; whitespace trimmed, empty/invalid rows rejected', () => {
  const model = fresh(); model.to.push(' second+tag@example.test '); model.cc.push('third@example.test');
  assert.deepEqual(messageIssues(model, true), []);
  for (const value of ['x', '', 'bad..local@example.test', '.bad@example.test', 'bad.@example.test', 'x@-domain.test', 'x@domain-.test', 'x@domain..test', 'Name <x@example.test>', 'x@example.test\r\nBcc:y@example.test']) {
    assert.equal(validEmail(value), false, value);
    model.to[1] = value;
    assert.ok(messageIssues(model, true).some(issue => issue.field === 'to' && issue.index === 1), value);
  }
  assert.equal(validEmail('first.last+tag@sub.example.test'), true);
  model.to = []; assert.ok(messageIssues(model, true).some(issue => issue.field === 'to'));
  model.to = ['x@example.test']; model.cc = [''];
  assert.ok(messageIssues(model, true).some(issue => issue.field === 'cc'));
  model.cc = []; assert.deepEqual(messageIssues(model, true), []);
});

await check('recipient/message limits and connection are real preflight failures', () => {
  for (const mutation of [m => { m.subject = ' '; }, m => { m.subject = 'x\nBcc:'; }, m => { m.subject = 'x'.repeat(999); },
    m => { m.body = ''; }, m => { m.body = 'x'.repeat(100001); }, m => { m.to = Array(101).fill('x@example.test'); }]) {
    const model = fresh(); mutation(model); assert.ok(messageIssues(model, true).length);
  }
  assert.ok(messageIssues(fresh(), false).some(issue => issue.field === 'account'));
  const model = fresh(); model.body = 'x'.repeat(99999);
  assert.ok(messageIssues(model, true, 'Signature').some(issue => issue.field === 'body'));
  assert.equal(fullBody('  Bonjour\nÀ bientôt  ', ' Entreprise\nTéléphone '), 'Bonjour\nÀ bientôt\n\nEntreprise\nTéléphone');
  assert.equal(fullBody('Bonjour', ''), 'Bonjour');
  const unicode = fresh(); unicode.subject = 'é'.repeat(500);
  assert.ok(messageIssues(unicode, true).some(issue => issue.field === 'subject'));
  unicode.subject = 'valid'; unicode.body = 'é'.repeat(50001);
  assert.ok(messageIssues(unicode, true).some(issue => issue.field === 'body'));
  const duplicate = fresh(); duplicate.cc = [' CAMILLE@example.test '];
  assert.ok(messageIssues(duplicate, true).some(issue => issue.field === 'cc' && issue.index === 0));
  assert.equal(validEmail('x@example.1'), false);
  assert.throws(() => mailSettingsPayload({ signature: 'bad\0signature' }));
});

await check('AI applies supplied subject/body and undo restores both, including stacked rewrites', () => {
  const model = fresh(), before = { body: model.body, subject: model.subject };
  applyRewrite(model, { body: 'First actual result', subject: 'First subject' });
  applyRewrite(model, { body: 'Second actual result', subject: 'Second subject' });
  assert.equal(undoRewrite(model), true); assert.equal(model.body, 'First actual result'); assert.equal(model.subject, 'First subject');
  assert.equal(undoRewrite(model), true); assert.deepEqual({ body: model.body, subject: model.subject }, before);
  assert.equal(undoRewrite(model), false);
  for (const result of [null, { body: ' ' }, { body: 'valid', subject: '' }, { body: 'valid', subject: 'bad\nsubject' }]) {
    assert.throws(() => applyRewrite(model, result));
    assert.deepEqual({ body: model.body, subject: model.subject }, before); assert.deepEqual(model.undo, []);
  }
});

await check('archived PDF metadata is a copied immutable snapshot, invalid paths/filenames fail', () => {
  const source = archived(), metadata = attachmentMetadata(source);
  source.filename = 'changed.pdf'; source.path = 'changed';
  assert.equal(metadata.filename, 'Facture_2061.pdf'); assert.equal(metadata.path, 'C:\\PDF\\Facture_2061.pdf');
  assert.throws(() => { metadata.draftId = 'other'; }, TypeError);
  for (const value of [null, {}, { ...archived(), path: '' }, { ...archived(), filename: 'folder/file.pdf' },
    { ...archived(), filename: 'file.exe' }, { ...archived(), draftId: '' }, { ...archived(), path: 'bad\0path' }]) assert.throws(() => attachmentMetadata(value));
});

await check('PDF preview consumes real immutable bytes and does not accept pretend content', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nexample bytes');
  const blob = pdfPreviewBlob(bytes); bytes.fill(0);
  assert.equal(blob.type, 'application/pdf'); assert.match(await blob.text(), /^%PDF-1.7/);
  for (const value of [null, 'PDF', new Uint8Array(), new TextEncoder().encode('not a PDF')]) assert.throws(() => pdfPreviewBlob(value));
});

await check('one complete settings payload, GUID/email validation, explicit blank signature retained', () => {
  const values = { clientId: ' 12345678-1234-1234-1234-123456789abc ', accountantEmail: ' a@example.test ', signature: '' };
  assert.deepEqual(mailSettingsPayload(values), { clientId: '12345678-1234-1234-1234-123456789abc', accountantEmail: 'a@example.test', signature: '' });
  assert.deepEqual(mailSettingsPayload({ clientId: '', accountantEmail: '', signature: DEFAULT_SIGNATURE }), { clientId: '', accountantEmail: '', signature: DEFAULT_SIGNATURE });
  assert.throws(() => mailSettingsPayload({ ...values, clientId: 'secret/not-a-guid' }));
  assert.throws(() => mailSettingsPayload({ ...values, accountantEmail: 'mistyped' }));
  assert.throws(() => mailSettingsPayload({ ...values, signature: 'x'.repeat(16001) }));
});

await check('preflight prevents export and native send, including disconnected account', async () => {
  for (const connected of [true, false]) {
    const model = fresh(); if (connected) model.to = ['mistyped'];
    let exports = 0, invokes = 0;
    const flow = createSendFlow({ model, getSettings: () => ({ ...settings, connected }), preparePdf: async () => { exports++; return archived(); }, invoke: async () => { invokes++; }, newAttemptId: () => 'invalid' });
    await assert.rejects(flow.send()); assert.equal(exports, 0); assert.equal(invokes, 0); assert.equal(model.sendState, 'idle');
  }
});

await check('final Send archives first, uses final native ID/path, suppresses concurrent submissions, snapshots routing', async () => {
  const model = fresh(), beforeBody = fullBody(model.body, settings.signature), pdf = deferred(), transport = deferred(), events = [];
  let exportCount = 0, sendCount = 0, nativeArgs;
  const flow = createSendFlow({ model, getSettings: () => settings, newAttemptId: () => 'attempt-01',
    preparePdf: () => { exportCount++; events.push('archive'); return pdf.promise; },
    invoke: (name, args) => { sendCount++; events.push('send'); assert.equal(name, 'send_outlook_mail'); nativeArgs = args; return transport.promise; },
  });
  const first = flow.send(), second = flow.send(); assert.equal(first, second);
  model.to[0] = 'edited-later@example.test'; model.subject = 'edited after snapshot';
  assert.equal(sendCount, 0); assert.equal(model.sendState, 'preparing');
  pdf.resolve(archived());
  // Observe the actual causal transition to injected native invocation.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ['archive', 'send']); assert.equal(exportCount, 1); assert.equal(sendCount, 1);
  assert.equal(model.pdfStatus, 'saved'); assert.equal(model.sendState, 'sending');
  assert.equal(nativeArgs.draftId, 'final-native-id'); assert.equal(nativeArgs.path, archived().path);
  assert.deepEqual(nativeArgs.request.to, ['camille@example.test']); assert.equal(nativeArgs.request.body, beforeBody);
  assert.equal(nativeArgs.request.subject, fresh().subject); assert.equal(nativeArgs.request.attemptId, 'attempt-01');
  assert.deepEqual(nativeArgs.request.cc, ['accountant@example.test']);
  const receipt = { attemptId: 'attempt-01', senderEmail: settings.senderEmail, acceptedAt: '2026-09-30T10:00:00Z' };
  transport.resolve(receipt); assert.deepEqual(await first, receipt); assert.equal(model.sendState, 'accepted');
  await assert.rejects(flow.send(), /déjà été soumis/); assert.equal(sendCount, 1);
});

await check('PDF failures never submit; synchronous export failure can be corrected and retried', async () => {
  const model = fresh(); let exports = 0, sends = 0;
  const flow = createSendFlow({ model, getSettings: () => settings, newAttemptId: () => 'pdf-retry',
    preparePdf: () => { exports++; if (exports === 1) throw new Error('disk full'); return archived(); },
    invoke: async () => { sends++; return { attemptId: 'pdf-retry', senderEmail: settings.senderEmail, acceptedAt: 'now' }; },
  });
  await assert.rejects(flow.send(), /disk full/); assert.equal(sends, 0); assert.equal(model.sendState, 'idle'); assert.equal(model.pdfStatus, 'failed');
  await flow.send(); assert.equal(exports, 2); assert.equal(sends, 1); assert.equal(model.pdfStatus, 'saved');
  const bad = fresh();
  const malformed = createSendFlow({ model: bad, getSettings: () => settings, newAttemptId: () => 'bad-pdf', preparePdf: async () => ({ filename: 'invented.pdf' }), invoke: () => { assert.fail('must not submit malformed PDF'); } });
  await assert.rejects(malformed.send(), /informations valides/); assert.equal(bad.sendState, 'idle');
});

await check('ambiguous provider error preserves typed recipients, PDF and attempt, and cannot resubmit after restoring draft', async () => {
  const model = fresh(), original = structuredClone(model); let exports = 0, sends = 0;
  const flow = createSendFlow({ model, getSettings: () => settings, newAttemptId: () => 'ambiguous-01', preparePdf: async () => { exports++; return archived(); }, invoke: async () => { sends++; throw new Error('timeout after submit'); } });
  await assert.rejects(flow.send(), /timeout after submit/);
  assert.deepEqual(model.to, original.to); assert.deepEqual(model.cc, original.cc); assert.equal(model.body, original.body);
  assert.equal(model.pdfStatus, 'saved'); assert.deepEqual(model.attachment, archived()); assert.equal(model.sendState, 'uncertain'); assert.equal(model.attemptId, 'ambiguous-01');
  await assert.rejects(flow.send());
  const restored = structuredClone(model);
  const reopened = createSendFlow({ model: restored, getSettings: () => settings, newAttemptId: () => 'bypass', preparePdf: () => { assert.fail('must not re-export uncertain send'); }, invoke: () => { assert.fail('must not resend'); } });
  await assert.rejects(reopened.send()); assert.equal(exports, 1); assert.equal(sends, 1);
});

await check('a receipt for another attempt is uncertain, never falsely accepted', async () => {
  const model = fresh();
  const flow = createSendFlow({ model, getSettings: () => settings, newAttemptId: () => 'our-attempt', preparePdf: async () => archived(),
    invoke: async () => ({ attemptId: 'other-attempt', senderEmail: settings.senderEmail, acceptedAt: 'now' }),
  });
  await assert.rejects(flow.send(), /Confirmation Outlook invalide/); assert.equal(model.sendState, 'uncertain'); assert.equal(model.pdfStatus, 'saved');
});

await check('a new send intent requires confirmation and never resets an in-flight attempt', async () => {
  for (const state of ['idle', 'preparing', 'sending']) {
    const model = fresh(); model.sendState = state; model.attemptId = 'keep-this'; model.attachment = archived();
    const before = structuredClone(model);
    assert.equal(prepareAnotherSend(model, true), false); assert.deepEqual(model, before);
  }
  for (const state of ['accepted', 'uncertain']) {
    const model = fresh(); model.sendState = state; model.attemptId = 'old-attempt'; model.attachment = archived(); model.pdfStatus = 'saved';
    const before = structuredClone(model);
    assert.equal(prepareAnotherSend(model), false); assert.deepEqual(model, before);
    assert.equal(prepareAnotherSend(model, true), true);
    assert.equal(model.sendState, 'idle'); assert.equal(model.attemptId, null); assert.equal(model.attachment, null); assert.equal(model.pdfStatus, 'pending');
    assert.deepEqual(model.to, before.to); assert.deepEqual(model.cc, before.cc); assert.equal(model.body, before.body); assert.equal(model.subject, before.subject);
    let exports = 0;
    const flow = createSendFlow({ model, getSettings: () => settings, newAttemptId: () => 'explicit-new-attempt',
      preparePdf: async () => { exports++; return archived(); },
      invoke: async (_name, args) => { assert.equal(args.request.attemptId, 'explicit-new-attempt'); return { attemptId: 'explicit-new-attempt', senderEmail: settings.senderEmail, acceptedAt: 'now' }; },
    });
    await flow.send(); assert.equal(exports, 1); assert.equal(model.sendState, 'accepted');
  }
});

// The same behavioral probes run against the product helper and deliberately
// broken, in-memory module copies. No live tree mutation and no provider calls.
async function probePreflight(makeFlow) {
  const model = fresh(); model.to = ['invalid']; let exports = 0, sends = 0;
  const flow = makeFlow({ model, getSettings: () => settings, newAttemptId: () => 'preflight-probe',
    preparePdf: async () => { exports++; return archived(); },
    invoke: async () => { sends++; return { attemptId: 'preflight-probe', senderEmail: settings.senderEmail, acceptedAt: 'now' }; },
  });
  await assert.rejects(flow.send()); assert.equal(exports, 0); assert.equal(sends, 0);
}
async function probeArchiveFailure(makeFlow) {
  let exports = 0, sends = 0;
  const flow = makeFlow({ model: fresh(), getSettings: () => settings, newAttemptId: () => 'archive-probe',
    preparePdf: async () => { exports++; throw new Error('archive unavailable'); },
    invoke: async () => { sends++; return { attemptId: 'archive-probe', senderEmail: settings.senderEmail, acceptedAt: 'now' }; },
  });
  await assert.rejects(flow.send(), /archive unavailable/); assert.equal(exports, 1); assert.equal(sends, 0);
}
await check('negative probes go RED for injected preflight bypass and PDF export bypass', async () => {
  await probePreflight(createSendFlow); await probeArchiveFailure(createSendFlow);
  const source = (await readFile(new URL('../web/email-composer.js', import.meta.url), 'utf8')).replace("from './interactions.js'", `from '${new URL('../web/interactions.js',import.meta.url).href}'`);
  const mutations = [
    { name: 'preflight bypass', anchor: 'if (issues.length) return Promise.reject(Object.assign(new Error(issues[0].message), { issues }));', replacement: '/* injected preflight bypass */', probe: probePreflight },
    { name: 'PDF export bypass', anchor: 'attachmentMetadata(await Promise.resolve().then(preparePdf))', replacement: 'attachmentMetadata({path:"C:\\\\fake.pdf",filename:"fake.pdf",draftId:"fake"})', probe: probeArchiveFailure },
  ];
  for (const mutation of mutations) {
    assert.equal(source.split(mutation.anchor).length - 1, 1, `${mutation.name}: NOT_INJECTED`);
    const changed = source.replace(mutation.anchor, mutation.replacement);
    const broken = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
    await assert.rejects(mutation.probe(broken.createSendFlow), { code: 'ERR_ASSERTION' }, `${mutation.name}: checker failed to go RED`);
    console.log(`mutation caught - ${mutation.name} (helper/transport rung)`);
  }
});

console.log(`email checks passed (${checks} meaningful helper/transport checks; no browser or provider claims)`);
