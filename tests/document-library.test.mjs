import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderSavedPaper, documentTotal, documentMoney, recordStatus,
  filterDocuments, savedDate, libraryRows, libraryDetail, createDocumentLibrary,
} from '../web/document-library.js';

const draft = overrides => ({
  id: 'invoice-a', kind: 'facture', date: '2026-09-30', dueDate: '2026-10-31', validUntil: '',
  project: 'Armoires cuisine', client: 'Alice Tremblay', address: '12, rue du Lac\nRipon',
  shipTo: '14, rue du Lac', contact: '8194287690', email: 'alice@example.test',
  notes: 'Installer après confirmation.', invoiceNumber: 3001, issuedNumber: 3001,
  deposit: '999', payments: [{ amount: '50,25', date: '2026-09-29' }, { amount: '25', date: '' }],
  items: [{ description: 'Armoires\nFinition chêne', quantity: '2', price: '100,50' }],
  ...overrides,
});
const record = (id = 'invoice-a', overrides = {}) => ({
  id, draft: draft({ id }), updatedAt: '2026-09-30T16:00:00Z', exports: [], ...overrides,
});
const button = (name, value = '') => {
  const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return { dataset: { [key]: value }, hasAttribute: attribute => attribute === name, disabled: false };
};
const action = name => button('data-library-action', name);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const pdfBytes = Array.from(new TextEncoder().encode('%PDF-1.7\nfixture\n%%EOF'));
const recovery = (id, changes = {}) => ({
  id, type: 'recovery', createdAt: '2026-09-29T12:00:00Z', draft: draft({ project: 'Ancien projet', ...changes }),
  path: null, filename: null, language: null, restorable: true,
});
const archived = (id = 'pdf-exact', changes = {}) => ({
  id, type: 'export', createdAt: '2026-09-28T12:00:00Z', draft: draft({ project: 'Projet exporté' }),
  path: 'C:\\Archives\\invoice-a.pdf', filename: 'invoice-a.pdf', language: 'fr', restorable: true, ...changes,
});
function harness(options = {}) {
  let records = options.records || [record()], state = draft(), paints = 0;
  const commands = [], transitions = [], notices = [];
  const library = createDocumentLibrary({
    getRecords: () => records, getState: () => state,
    command: async (name, args) => { commands.push([name, args]); return options.command ? options.command(name, args) : []; },
    transition: async (...args) => { transitions.push(args); return options.transition ? options.transition(...args) : true; },
    flush: options.flush || (async () => true), render: () => { paints++; },
    notice: message => notices.push(message), logo: '/company.png',
    // Controller seam only. Production-built browser checks use real PDF.js.
    renderPdf: options.renderPdf || (async bytes => {
      assert.deepEqual(Array.from(bytes), pdfBytes, 'Renderer receives exact archive bytes');
      const url = URL.createObjectURL(new Blob(['rendered-page'],{type:'image/png'}));
      return {pages:[{url,width:612,height:792}],dispose:()=>URL.revokeObjectURL(url)};
    }),
  });
  return { library, commands, transitions, notices, setRecords: next => { records = next; },
    setState: next => { state = next; }, get paints() { return paints; } };
}

test('saved paper renders entered data, dates, all line items, taxes and dated payments without mutating the draft', () => {
  const input = draft(), before = structuredClone(input);
  const html = renderSavedPaper(input, '/brand.png');
  for (const text of ['Alice Tremblay', 'Armoires cuisine', 'Armoires\nFinition chêne', '12, rue du Lac\nRipon',
    '14, rue du Lac', '(819) 428-7690', 'alice@example.test', 'Installer après confirmation.', '30 septembre 2026',
    '31 octobre 2026', '29 septembre 2026', 'Date non précisée', 'Facture n° 3001', 'TPS 848045563', 'TVQ 1212260726']) {
    assert.ok(html.includes(text), `Missing saved field: ${text}`);
  }
  assert.equal(documentTotal(input), 231.1);
  for (const amount of [201, 10.05, 20.05, 231.1, 50.25, 25, 75.25, 155.85]) assert.ok(html.includes(documentMoney(amount)));
  assert.deepEqual(input, before);
  assert.doesNotMatch(html, /\s(?:id|data-preview|data-field|data-item|data-deposit-row)\s*=/);
});

test('saved previews do not show live-editor placeholders or leak an issued number into a quote', () => {
  const html = renderSavedPaper(draft({ kind: 'soumission', project: '', client: '', address: '', contact: '', email: '',
    shipTo: '', notes: '', payments: [], validUntil: '2026-11-01', dueDate: '2027-01-01' }));
  assert.match(html, /Soumission/);
  assert.match(html, /1 novembre 2026/);
  assert.doesNotMatch(html, /Facture n°|Nom du projet|Nom du client|Adresse de facturation|Livrer à|Courriel :|Date limite|Paiements reçus|Total reçu|Balance/);
});

test('customer data and logo attributes are escaped in every repeated saved preview', () => {
  const input = draft({ client: '<img src=x onerror="attack()">', project: 'A&B', notes: "<script>'x'</script>",
    items: [{ description: '<svg onload="attack()">', quantity: '2', price: '1' }] });
  const html = renderSavedPaper(input, 'logo" onerror="attack()');
  assert.match(html, /&lt;img/);
  assert.match(html, /A&amp;B/);
  assert.match(html, /&lt;script&gt;&#39;x&#39;&lt;\/script&gt;/);
  assert.match(html, /src="logo&quot; onerror=&quot;attack\(\)"/);
  assert.doesNotMatch(html, /<script|<svg|\sonerror="/);
  const rows = libraryRows([record('a', { draft: input }), record('b')], 'a', data => renderSavedPaper(data));
  assert.doesNotMatch(rows, /\sid\s*=|data-preview=/);
});

test('payment arrays are authoritative, legacy deposits migrate, and cent rounding is consistent', () => {
  const empty = renderSavedPaper(draft({ payments: [] }));
  assert.doesNotMatch(empty, /Total reçu|Balance/);
  const legacy = draft({ payments: undefined, deposit: '100,25' });
  assert.match(renderSavedPaper(legacy), /Date non précisée/);
  assert.ok(renderSavedPaper(legacy).includes(documentMoney(130.85)));
  assert.equal(documentTotal(draft({ items: [{ quantity: '1', price: '0,10' }] })), .12);
  assert.equal(documentTotal(draft({ items: [{ quantity: 'Infinity', price: '1' }] })), 0);
});

test('badges require a confirmed backend send timestamp or archive receipt, not attempted sends', () => {
  assert.equal(recordStatus(record()).label, 'Brouillon');
  assert.equal(recordStatus(record('a', { lastSentAt: '2026-09-30T12:00:00Z', sentAt: 'bad', sendPending: true })).label, 'Brouillon');
  assert.equal(recordStatus(record('a', { exports: [{ path: '/one.pdf', sentReceipts: [] }] })).label, 'PDF créé');
  assert.equal(recordStatus(record('a', { sentAt: '2026-09-30T12:00:00Z' })).label, 'Brouillon');
  assert.equal(recordStatus(record('a', { exports: [{ path: '/one.pdf', sentReceipts: [{ acceptedAt: '2026-09-30T12:00:00Z' }] }] })).label, 'Envoyé');
  const sent = record('a', { exports: [
    { path: '/two.pdf', sentReceipts: [{ acceptedAt: '2026-09-30T14:00:00Z' }, { acceptedAt: 'invalid' }] },
    { path: '/one.pdf', sentReceipts: [{ acceptedAt: '2026-09-29T12:00:00Z' }] },
  ] });
  const detail = libraryDetail(sent, renderSavedPaper);
  assert.ok(detail.includes(savedDate('2026-09-30T14:00:00Z')));
  assert.match(detail, /brouillon actuel peut différer du PDF envoyé/);
});

test('search matches client, project and number across words and respects kind without mutating records', () => {
  const records = [record(), record('quote', { draft: draft({ kind: 'soumission', client: 'Bob Roy', project: 'Bibliothèque', issuedNumber: null, invoiceNumber: null }) })];
  const before = structuredClone(records);
  assert.deepEqual(filterDocuments(records, 'facture', ' ALICE cuisine 3001 ').map(entry => entry.id), ['invoice-a']);
  assert.deepEqual(filterDocuments(records, 'all', 'bIBLIothèque').map(entry => entry.id), ['quote']);
  assert.deepEqual(filterDocuments(records, 'soumission', 'Alice'), []);
  assert.deepEqual(records, before);
  assert.equal(savedDate(null), '');
  assert.equal(savedDate('nonsense'), '');
});

test('document rows keep type in the text and place each authoritative status above its amount in one summary column', () => {
  const records = [record(), record('pdf', { exports: [{ path: '/one.pdf' }] }),
    record('sent', { exports: [{ path: '/sent.pdf', sentReceipts: [{ acceptedAt: '2026-09-30T12:00:00Z' }] }] }),
    record('quote', { draft: draft({ kind: 'soumission', issuedNumber: null }) })];
  const before = structuredClone(records);
  for (const entry of records) {
    const html = libraryRows([entry], entry.id, () => 'thumbnail');
    const text = html.match(/<div class="library-row-text">([\s\S]*?)<div class="library-row-summary">/)[1];
    assert.match(text, /document-badge/);
    assert.ok(text.includes(entry.draft.kind === 'facture' ? 'Facture n° 3001' : 'Soumission'));
    assert.doesNotMatch(text, /document-status/);
    const summary = html.match(/<div class="library-row-summary">([\s\S]*?)<\/div>/)[1];
    assert.match(summary, /^<span class="document-status [^"]+">[^<]+<\/span><b>[^<]+<\/b>$/);
    assert.ok(summary.includes(recordStatus(entry).label));
    assert.ok(summary.includes(documentMoney(documentTotal(entry.draft))));
    assert.equal((html.match(/document-status/g) || []).length, 1);
    assert.match(html, /aria-pressed="true"/);
    assert.match(libraryDetail(entry, () => 'paper'), /class="library-badges"><span class="document-badge [^"]*">[^<]+<\/span><span class="document-status /);
  }
  assert.deepEqual(records, before);
});

test('controller starts closed, renders only real records, delegates unrelated events, filters and repaints', async () => {
  const h = harness();
  assert.equal(h.library.isOpen, false);
  assert.equal(h.library.html(), '');
  assert.equal(await h.library.handleClick(action('close')), false);
  assert.equal(h.library.open(), true);
  assert.equal(h.library.isOpen, true);
  assert.match(h.library.html(), /Documents récents/);
  assert.match(h.library.html(), /Alice Tremblay/);
  assert.equal(h.library.handleInput(button('data-field', 'client')), false);
  assert.equal(await h.library.handleClick(button('data-save')), false);
  await h.library.handleClick(action('open-search'));
  assert.equal(h.library.handleInput({ ...button('data-library-search'), value: 'absent' }), true);
  assert.match(h.library.html(), /Aucun document trouvé/);
  assert.doesNotMatch(h.library.html(), /data-review-record/);
  assert.equal(h.library.close(), true);
  assert.equal(h.library.isOpen, false);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.transitions, []);
  assert.ok(h.paints >= 3);
  h.setRecords([]); h.library.open();
  assert.match(h.library.html(), /Aucun document enregistré/);
  assert.doesNotMatch(h.library.html(), /Alice|3001/);
});

test('row selection only selects; both preview and Open lead to explicit confirmation before native opening', async () => {
  const h = harness({ records: [record(), record('other', { draft: draft({ id: 'other', client: 'Bob' }) })] });
  h.library.open();
  await h.library.handleClick(button('data-select-record', 'other'));
  assert.deepEqual(h.transitions, []);
  await h.library.handleClick(button('data-review-record'));
  assert.match(h.library.html(), /Vérifier le document/);
  assert.match(h.library.html(), /Bob/);
  assert.equal((h.library.html().match(/role="dialog"/g) || []).length, 1);
  assert.deepEqual(h.transitions, []);
  await h.library.handleClick(action('confirm-open'));
  assert.deepEqual(h.transitions[0].slice(0, 2), ['open_draft', { id: 'other' }]);
  assert.equal(h.library.isOpen, false);
});

test('failed save prevents native open and failed transitions leave the reviewed document available', async () => {
  for (const options of [{ flush: async () => false }, { transition: async () => false }, { transition: async () => { throw new Error('Disque inaccessible'); } }]) {
    const h = harness(options); h.library.open(); await h.library.handleClick(button('data-review-record'));
    await h.library.handleClick(action('confirm-open'));
    assert.equal(h.library.isOpen, true);
    assert.match(h.library.html(), /Confirmer et ouvrir/);
    assert.equal(h.transitions.length, options.flush ? 0 : 1);
    if (options.transition) assert.equal(await h.library.handleClick(action('close-preview')), true);
  }
});

test('changed snapshots require renewed review, and removed records cannot be opened', async () => {
  const h = harness(); h.library.open(); await h.library.handleClick(button('data-review-record'));
  h.setRecords([record('invoice-a', { draft: draft({ project: 'Modification récente' }) })]);
  await h.library.handleClick(action('confirm-open'));
  assert.deepEqual(h.transitions, []);
  assert.match(h.library.html(), /Modification récente/);
  assert.match(h.notices[0], /a changé/);
  h.setRecords([]); await h.library.handleClick(action('confirm-open'));
  assert.deepEqual(h.transitions, []);
  assert.match(h.notices[1], /plus disponible/);
});

test('new document buttons use the real new_draft command, save first and suppress duplicate clicks', async () => {
  const saving = deferred(), h = harness({ flush: () => saving.promise });
  h.library.open();
  const pending = h.library.handleClick(button('data-library-new', 'soumission'));
  assert.equal(await h.library.handleClick(button('data-library-new', 'soumission')), true);
  assert.equal(h.library.close(), false);
  assert.deepEqual(h.transitions, []);
  saving.resolve(true); await pending;
  assert.deepEqual(h.transitions.map(call => call.slice(0, 2)), [['new_draft', { kind: 'soumission' }]]);
  assert.equal(h.library.isOpen, false);
});

test('history loads actual versions, shows exact selected snapshot, and restores exact ID only after confirmation', async () => {
  const versions = [recovery('saved-first'), recovery('saved-exact', { project: 'Projet exact', client: 'Client historique', items: [{ description: 'Travail historique', quantity: '3', price: '25' }] })];
  const h = harness({ command: () => versions }); h.library.open();
  await h.library.handleClick(button('data-record-history'));
  assert.deepEqual(h.commands, [['load_document_versions', { id: 'invoice-a' }]]);
  await h.library.handleClick(button('data-library-version', 'saved-exact'));
  assert.match(h.library.html(), /Projet exact/);
  assert.match(h.library.html(), /Travail historique/);
  await h.library.handleClick(action('request-restore'));
  assert.match(h.library.html(), /brouillon de récupération/);
  assert.match(h.library.html(), /même numéro de facture, 3001/);
  assert.deepEqual(h.transitions, []);
  await h.library.handleClick(action('confirm-restore'));
  assert.deepEqual(h.transitions[0].slice(0, 2), ['restore_document_version', { id: 'invoice-a', versionId: 'saved-exact' }]);
  assert.equal(h.library.isOpen, false);
});

test('history shows the selected paper without duplicate metadata or enlargement controls', async () => {
  const entry = recovery('selected-preview', { project: 'Version choisie', client: 'Client choisi' });
  const h = harness({ command: () => [recovery('first-preview'), entry] });
  h.library.open(); await h.library.handleClick(button('data-record-history'));
  await h.library.handleClick(button('data-library-version', entry.id));
  const html = h.library.html();
  const list = html.slice(html.indexOf('<div class="version-list">'), html.indexOf('<div class="version-detail">'));
  assert.equal((list.match(/Brouillon de récupération/g) || []).length, 2);
  const detail = html.slice(html.indexOf('<div class="version-detail">'), html.indexOf('<footer>'));
  assert.match(detail, /Version choisie/);
  assert.doesNotMatch(detail, /Brouillon de récupération|library-magnify|<button/);
  assert.ok(!detail.includes(savedDate(entry.createdAt)));
  assert.doesNotMatch(html, /see-version|Voir en grand/);
  await h.library.handleClick(action('see-version'));
  assert.equal(h.library.html(), html, 'A stale enlargement action cannot open a removed view.');
  assert.deepEqual(h.transitions, []);
  h.library.close();
});

test('archived previews render exact PDF bytes, preserve language, and release page images when closed', async () => {
  const entry = archived('english-exact', { language: 'en' });
  const h = harness({ command: name => name === 'load_document_versions' ? [entry] : pdfBytes });
  h.library.open(); await h.library.handleClick(button('data-record-history'));
  assert.deepEqual(h.commands[1], ['read_document_pdf', { id: 'invoice-a', path: entry.path }]);
  assert.match(h.library.html(), /Anglais/);
  assert.doesNotMatch(h.library.html(), /Projet exporté/); // Real PDF, not a French reconstruction.
  const detail = h.library.html().slice(h.library.html().indexOf('<div class="version-detail">'), h.library.html().indexOf('<footer>'));
  assert.doesNotMatch(detail, /library-magnify|<button[^>]*class="history-paper|library-detail-paper|Anglais|<strong>PDF créé/);
  assert.match(detail, /<div class="history-paper"><div class="saved-pdf-pages"/);
  assert.doesNotMatch(detail, /<object|<iframe|application\/pdf/);
  const url = h.library.html().match(/src="(blob:[^"]+)"/)[1];
  assert.equal(await (await fetch(url)).text(), 'rendered-page');
  assert.deepEqual(h.commands, [['load_document_versions', { id: 'invoice-a' }],
    ['read_document_pdf', { id: 'invoice-a', path: entry.path }]]);
  assert.deepEqual(h.transitions, []);
  h.library.close();
  await assert.rejects(fetch(url));
});

test('legacy PDFs without snapshots are view-only even if a stale backend flag says restorable', async () => {
  const h = harness({ command: name => name === 'load_document_versions' ? [archived('legacy', { draft: null, restorable: true })] : pdfBytes });
  h.library.open(); await h.library.handleClick(button('data-record-history'));
  assert.match(h.library.html(), /Consultation seulement/);
  assert.match(h.library.html(), /<button[^>]*data-library-action="request-restore"[^>]* disabled/);
  await h.library.handleClick(action('request-restore'));
  await h.library.handleClick(action('confirm-restore'));
  assert.deepEqual(h.transitions, []);
});

test('missing or corrupt PDFs report errors and never substitute the current draft; retry reads the selected path', async () => {
  for (const result of [() => { throw new Error('PDF absent'); }, () => [1, 2, 3], () => [37, 80, 68, 70, 45, -1]]) {
    let attempt = 0;
    const h = harness({ command: name => name === 'load_document_versions' ? [archived()] : (++attempt === 1 ? result() : pdfBytes) });
    h.library.open(); await h.library.handleClick(button('data-record-history'));
    assert.match(h.library.html(), /role="alert"/);
    assert.doesNotMatch(h.library.html(), /Projet exporté|<object/);
    await h.library.handleClick(action('retry-pdf'));
    assert.match(h.library.html(), /saved-pdf-page/);
    assert.equal(h.commands.filter(([name]) => name === 'read_document_pdf').length, 2);
    h.library.close();
  }
});

test('late history and PDF responses cannot replace a newer selection or reopen a closed library', async () => {
  const loading = deferred(), h = harness({ command: () => loading.promise });
  h.library.open(); const pending = h.library.handleClick(button('data-record-history'));
  h.library.close(); loading.resolve([recovery('late')]); await pending;
  assert.equal(h.library.html(), '');
  const pdf = deferred(), second = harness({ command: name => name === 'load_document_versions' ? [archived(), recovery('safe')] : pdf.promise });
  second.library.open(); const firstLoad = second.library.handleClick(button('data-record-history'));
  await Promise.resolve(); await Promise.resolve();
  await second.library.handleClick(button('data-library-version', 'safe'));
  pdf.resolve(pdfBytes); await firstLoad;
  assert.match(second.library.html(), /Ancien projet/);
  assert.doesNotMatch(second.library.html(), /<object/);
  second.library.close();
});

test('history rejects malformed responses, exposes retry and accepts genuinely empty histories', async () => {
  let response = [{ id: 'same', type: 'recovery' }, { id: 'same', type: 'recovery' }];
  const h = harness({ command: () => response }); h.library.open(); await h.library.handleClick(button('data-record-history'));
  assert.match(h.library.html(), /Réponse des versions invalide/);
  assert.deepEqual(h.transitions, []);
  response = []; await h.library.handleClick(action('retry-history'));
  assert.match(h.library.html(), /Aucune version précédente enregistrée/);
  assert.match(h.library.html(), /<button[^>]*data-library-action="request-restore"[^>]* disabled/);
  h.library.close();
});

test('stable browser-probe classes and confirmation attributes route to the same exact native commands', async () => {
  const h = harness({ command: () => [recovery('selected-exact')] });
  h.library.open(); assert.match(h.library.html(), /class="[^"]*library-dialog/);
  await h.library.handleClick(button('data-review-record'));
  assert.match(h.library.html(), /class="[^"]*library-review/);
  assert.match(h.library.html(), /class="library-full-paper"/);
  assert.match(h.library.html(), /data-confirm-open-record/);
  assert.equal(await h.library.handleClick(button('data-confirm-open-record')), true);
  assert.deepEqual(h.transitions[0].slice(0, 2), ['open_draft', { id: 'invoice-a' }]);
  h.library.open(); await h.library.handleClick(button('data-record-history'));
  assert.match(h.library.html(), /class="[^"]*library-history/);
  assert.match(h.library.html(), /data-restore-selected/);
  assert.match(h.library.html(), /class="library-detail-paper"/);
  await h.library.handleClick(button('data-restore-selected'));
  assert.match(h.library.html(), /class="[^"]*library-restore-confirm/);
  assert.match(h.library.html(), /data-confirm-restore/);
  await h.library.handleClick(button('data-confirm-restore'));
  assert.deepEqual(h.transitions[1].slice(0, 2), ['restore_document_version', { id: 'invoice-a', versionId: 'selected-exact' }]);
});

test('search opens explicitly, retains filters and counts, and closing clears only the query', async () => {
  const records = Array.from({length:123}, (_, i) => record('many-'+i, {draft:draft({id:'many-'+i, kind:i < 101 ? 'facture' : 'soumission', project:'Projet '+i})}));
  const h = harness({records}); h.library.open();
  assert.match(h.library.html(), /library-search-toggle/);
  assert.doesNotMatch(h.library.html(), /<input/);
  assert.match(h.library.html(), /aria-label="Tous : 123"/);
  assert.match(h.library.html(), /aria-label="Factures : 101"/);
  await h.library.handleClick(button('data-library-filter','soumission'));
  await h.library.handleClick(action('open-search'));
  assert.match(h.library.html(), /library-toolbar search-expanded/);
  h.library.handleInput({...button('data-library-search'),value:'Projet 122'});
  assert.match(h.library.html(), /aria-label="Soumissions : 1"/);
  await h.library.handleClick(action('close-search'));
  assert.doesNotMatch(h.library.html(), /<input/);
  assert.match(h.library.html(), /aria-label="Soumissions : 22"/);
  assert.match(h.library.html(), /data-library-filter="soumission" class="selected"/);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.transitions, []);
});

test('Documents has no footer and New keeps both draft types accessible in the header', async () => {
  const h=harness(); h.library.open();
  assert.doesNotMatch(h.library.html(), /library-footer|data-library-new/);
  await h.library.handleClick(action('toggle-new'));
  const header=h.library.html().slice(0,h.library.html().indexOf('<div class="split-library'));
  assert.match(header, /data-library-new="facture"/);
  assert.match(header, /data-library-new="soumission"/);
  await h.library.handleClick(action('toggle-new'));
  assert.doesNotMatch(h.library.html(), /data-library-new/);
});
