import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  noteRows, setNoteRows, normalizeNoteRows, notesMirror, noteIssues,
  MAX_NOTE_ENTRIES, MAX_NOTES_BYTES,
} from '../web/client-notes.js';
import { createVoiceSession, releaseVoiceField, applyVoiceUpdate } from '../web/voice-workflow.js';
import { paymentRows } from '../web/payments.js';
import { updateTax, migrateEditableTax } from '../web/taxes.js';

test('legacy scalar becomes one exact entry, preserving blank lines and whitespace', () => {
  for (const notes of ['', '  ', '\r\n\tÉtage\n\nDeuxième paragraphe\n  ']) {
    for (const draft of [{ notes }, { notes, noteEntries: null }]) {
      assert.deepEqual(noteRows(draft), notes === '' ? [] : [notes]);
      assert.equal(normalizeNoteRows(draft), draft);
      assert.deepEqual(draft.noteEntries, notes === '' ? [] : [notes]);
      assert.equal(draft.notes, notes);
    }
  }
  assert.deepEqual(noteRows({}), []);
});

test('ordered multiline notes mirror exact text; empty placeholders do not change customer text', () => {
  const rows = ['  Première\n\nSuite  ', '', 'Deuxième\r\nligne', '\t '];
  const draft = { notes: 'ancienne', englishCopy: { sourceNotes: 'ancienne' } };
  const copy = structuredClone(rows), translation = draft.englishCopy;
  assert.equal(setNoteRows(draft, rows), draft);
  assert.equal(draft.notes, '  Première\n\nSuite  \n\nDeuxième\r\nligne\n\n\t ');
  assert.deepEqual(rows, copy);
  assert.equal(draft.englishCopy, translation);
  rows[0] = 'external mutation';
  assert.equal(draft.noteEntries[0], copy[0]);
  const fetched = noteRows(draft); fetched.pop();
  assert.equal(draft.noteEntries.length, 4);
  assert.deepEqual(noteIssues(draft), []);
});

test('explicit removal stays empty and never resurrects legacy text', () => {
  const draft = { notes: 'ancienne', noteEntries: [] };
  assert.deepEqual(noteRows(draft), []);
  assert.ok(noteIssues(draft).length);
  normalizeNoteRows(draft);
  assert.deepEqual(draft.noteEntries, []);
  assert.equal(draft.notes, '');
  setNoteRows(draft, ['une', 'deux']);
  setNoteRows(draft, noteRows(draft).filter((_, index) => index !== 0));
  assert.deepEqual(draft.noteEntries, ['deux']);
  assert.equal(draft.notes, 'deux');
  setNoteRows(draft, ['', '']);
  assert.equal(draft.notes, '');
});

test('strict row types and scalar mismatches are visible; rejected sets are atomic', () => {
  for (const noteEntries of ['lost', {}, [1], [null], Array(2)]) {
    const draft = { notes: 'conservée', noteEntries };
    assert.throws(() => noteRows(draft), TypeError);
    assert.ok(noteIssues(draft).length);
  }
  assert.throws(() => noteRows({ notes: 17 }), TypeError);
  const draft = { notes: 'original', noteEntries: ['original'] }, before = structuredClone(draft);
  for (const bad of [[17], ['bad\0'], Array(MAX_NOTE_ENTRIES + 1).fill(''), ['é'.repeat(MAX_NOTES_BYTES / 2 + 1)]]) {
    assert.throws(() => setNoteRows(draft, bad));
    assert.deepEqual(draft, before);
  }
  assert.ok(noteIssues({ notes: 'différent', noteEntries: ['texte réel'] }).some(issue => issue.field === 'notes'));
});

test('UTF-8 byte, aggregate separator, count and control limits match Rust', () => {
  const draft = {};
  setNoteRows(draft, ['é'.repeat(MAX_NOTES_BYTES / 2)]);
  assert.equal(new TextEncoder().encode(draft.notes).length, MAX_NOTES_BYTES);
  assert.throws(() => setNoteRows(draft, ['a'.repeat(25_000), 'b'.repeat(25_000)]));
  setNoteRows(draft, Array(MAX_NOTE_ENTRIES).fill(''));
  assert.equal(draft.notes, '');
  setNoteRows(draft, ['\n\r\t']);
  for (const control of ['\0', '\u000b', '\u001f', '\u007f', '\u0085', '\u009f']) assert.throws(() => setNoteRows(draft, [control]));
});

test('exact aggregate byte boundary succeeds; an over-limit update cannot partially change a draft', () => {
  const draft = { englishCopy: { notes: 'English remains intact' } };
  setNoteRows(draft, ['é'.repeat(12_500), 'b'.repeat(24_998)]);
  assert.equal(new TextEncoder().encode(draft.notes).length, 50_000);
  const before = structuredClone(draft);
  const changed = noteRows(draft); changed[1] += 'b';
  assert.throws(() => setNoteRows(draft, changed), RangeError);
  assert.deepEqual(draft, before);
  assert.ok(noteIssues({ noteEntries: changed, notes: notesMirror(changed) }).some(issue => issue.field === 'notes'));
  setNoteRows(draft, ['', ...noteRows(draft), '']);
  assert.equal(draft.notes, before.notes);
  assert.equal(new TextEncoder().encode(draft.notes).length, 50_000);
});

test('English source comparison changes only with the compatibility mirror', () => {
  const draft = { englishCopy: { sourceNotes: 'Première\n\nDeuxième', notes: 'Translation' } };
  setNoteRows(draft, ['Première', 'Deuxième']);
  assert.equal(draft.notes, draft.englishCopy.sourceNotes);
  setNoteRows(draft, ['Première', '', 'Deuxième']);
  assert.equal(draft.notes, draft.englishCopy.sourceNotes);
  setNoteRows(draft, ['Deuxième', 'Première']);
  assert.notEqual(draft.notes, draft.englishCopy.sourceNotes);
  assert.equal(draft.englishCopy.notes, 'Translation');
});

const voiceDraft = () => ({ id: 'voice-notes', kind: 'soumission', notes: '', noteEntries: ['', ''], items: [{ description: '', quantity: '1', price: '' }] });
test('accepted document voice notes replace eligible placeholders with one synchronized multiline entry', () => {
  const draft = voiceDraft(), session = createVoiceSession(draft);
  assert.ok(applyVoiceUpdate(draft, { notes: ' Première ligne\n\nDeuxième ligne ' }, session));
  assert.deepEqual(draft.noteEntries, ['Première ligne\n\nDeuxième ligne']);
  assert.equal(draft.notes, draft.noteEntries[0]);
  assert.ok(applyVoiceUpdate(draft, { notes: 'Texte cumulé\nSuite' }, session));
  assert.deepEqual(draft.noteEntries, ['Texte cumulé\nSuite']);
  releaseVoiceField(session, 'notes');
  setNoteRows(draft, ['Correction', 'Note manuelle']);
  assert.equal(applyVoiceUpdate(draft, { notes: 'Écrasement' }, session), false);
  assert.deepEqual(draft.noteEntries, ['Correction', 'Note manuelle']);
});

test('voice protects pre-existing authoritative notes and rejects invalid/wrong-document proposals', () => {
  const draft = voiceDraft(); draft.noteEntries = ['Note manuelle', 'Autre note'];
  const session = createVoiceSession(draft); // Even a stale empty mirror cannot expose entered rows.
  assert.equal(applyVoiceUpdate(draft, { notes: 'Écrasement' }, session), false);
  assert.deepEqual(draft.noteEntries, ['Note manuelle', 'Autre note']);
  const empty = voiceDraft(), emptySession = createVoiceSession(empty);
  for (const notes of ['', '  ', 'a'.repeat(5001), 'bad\0']) assert.equal(applyVoiceUpdate(empty, { notes }, emptySession), false);
  assert.equal(applyVoiceUpdate({ ...empty, id: 'other' }, { notes: 'Texte' }, emptySession), false);
  assert.deepEqual(empty.noteEntries, ['', '']);
});

// Evaluate the actual production snapshot and English-source functions. Storage,
// DOM, provider calls and the rest of app.js are excluded from this data check.
const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Production function missing: ${start}`);
  return source.slice(from, to);
}
function snapshotProbe(source = appSource) {
  const context = vm.createContext({
    state: null, records: [], englishMode: false, translationError: '', lastSavedAt: null,
    nextInvoiceNumber: null, pdfDirectory: '', usingDefaultDirectory: true, pdfDirectories: {},
    copy: structuredClone, noteRows, setNoteRows, paymentRows, updateTax, migrateEditableTax,
  });
  vm.runInContext(section(source, '    function applySnapshot(', '    function runCommand(')
    + section(source, '    const englishCurrent =', '    const englishComplete =')
    + '\nglobalThis.isEnglishCurrent = englishCurrent;', context);
  return context;
}
function translatedDraft(notes, noteEntries) {
  const draft = {
    id: 'snapshot-notes', notes, project: 'Projet', invoiceNumber: 2060, issuedNumber: null,
    items: [{ description: 'Travail', quantity: '1', price: '100' }], payments: [],
    englishCopy: {
      sourceProject: 'Projet', sourceNotes: notes, sourceDescriptions: ['Travail'],
      project: 'Project', notes: 'English customer text', descriptions: ['Work'],
    },
  };
  if (noteEntries !== undefined) draft.noteEntries = noteEntries;
  return draft;
}
const snapshotOf = draft => ({ current: structuredClone(draft), records: [{ id: draft.id, draft: structuredClone(draft) }], nextInvoiceNumber: 2060, pdfDirectory: 'fixture', usingDefaultDirectory: true });

function verifySnapshotNormalization(probe) {
  const legacy = translatedDraft('  Première\r\n\nDeuxième\n  '), snapshot = snapshotOf(legacy);
  const original = structuredClone(snapshot);
  probe.applySnapshot(snapshot);
  assert.deepEqual(probe.state.noteEntries, [legacy.notes]);
  assert.equal(probe.state.notes, legacy.notes);
  assert.equal(probe.isEnglishCurrent(), true);
  assert.deepEqual(snapshot, original, 'normalizing the editor must not mutate the transport snapshot');
  const normalized = structuredClone(probe.state);
  probe.applySnapshot(snapshotOf(normalized));
  assert.deepEqual(probe.state, normalized, 'repeated snapshot normalization is idempotent');
  probe.applySnapshot(snapshotOf(translatedDraft('', [])));
  assert.deepEqual(probe.state.noteEntries, [], 'Empty notes show only Add a note');
  assert.equal(probe.state.notes, '');
  assert.equal(probe.isEnglishCurrent(), true);
}

test('production snapshot normalization preserves exact legacy text, English freshness and transport input', () => {
  verifySnapshotNormalization(snapshotProbe());
});

function verifyEnglishStaleness(probe) {
  probe.applySnapshot(snapshotOf(translatedDraft('Première\n\nDeuxième', ['Première', 'Deuxième'])));
  assert.equal(probe.isEnglishCurrent(), true);
  setNoteRows(probe.state, ['Première', '', 'Deuxième']);
  assert.equal(probe.isEnglishCurrent(), true, 'empty placeholders do not stale translation');
  setNoteRows(probe.state, ['Deuxième', 'Première']);
  assert.equal(probe.isEnglishCurrent(), false, 'editing/reordering customer text must stale translation');
  assert.equal(probe.state.englishCopy.notes, 'English customer text');
}

test('production englishCurrent follows the exact notes mirror, including an older in-flight save snapshot', () => {
  const probe = snapshotProbe();
  verifyEnglishStaleness(probe);
  const edited = structuredClone(probe.state);
  const older = snapshotOf(translatedDraft('Première\n\nDeuxième', ['Première', 'Deuxième']));
  older.current.invoiceNumber = 2061;
  probe.applySnapshot(older, false);
  assert.deepEqual(probe.state.noteEntries, edited.noteEntries);
  assert.equal(probe.state.notes, edited.notes);
  assert.equal(probe.state.invoiceNumber, 2061);
  assert.equal(probe.isEnglishCurrent(), false);
});

test('production-function checks detect isolated snapshot-normalization and English-staleness defects', () => {
  for (const mutation of [
    { anchor: "setNoteRows(state, loadingDocument && entries.length === 1 && entries[0] === '' ? [] : entries);", replacement: '/* isolated normalization defect */', probe: verifySnapshotNormalization },
    { anchor: 'en.sourceNotes === state.notes', replacement: 'true /* isolated English-staleness defect */', probe: verifyEnglishStaleness },
  ]) {
    assert.equal(appSource.split(mutation.anchor).length - 1, 1, 'mutation must be injected exactly once');
    const changed = appSource.replace(mutation.anchor, mutation.replacement);
    assert.throws(() => mutation.probe(snapshotProbe(changed)), { code: 'ERR_ASSERTION' });
  }
});
