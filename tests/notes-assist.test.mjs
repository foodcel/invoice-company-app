import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { noteRows, setNoteRows } from '../web/client-notes.js';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function section(text, start, end) {
  const from = text.indexOf(start), to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Production section missing: ${start}`);
  return text.slice(from, to);
}
function element(dataset = {}) {
  const attrs = {}, classes = new Set();
  return {
    dataset: { ...dataset }, attrs, value: '', readOnly: false, hidden: false, tagName: 'TEXTAREA',
    classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) {
      delete attrs[name];
      if (name === 'data-item') delete this.dataset.item;
      if (name === 'data-field') delete this.dataset.field;
      if (name === 'data-note') delete this.dataset.note;
      if (name === 'data-remove-note') delete this.dataset.removeNote;
    },
    hasAttribute(name) { return name === 'data-assist-proposal' && this.dataset.assistProposal !== undefined; },
    insertAdjacentElement(position, node) { this.review = node; }
  };
}

// Run actual shared assist functions, painter, and production click/input handlers.
// Only transport, speech hardware, and the surrounding editor are isolated.
function editor(text = source, rows) {
  const listeners = {}, calls = { commands: [], queued:[], saves: 0, dirty: 0, undo: 0, validation: 0, sync: 0, notices: [], stops: 0, cancels: 0, motions: [], saved: [] };
  const state = { id: 'notes-probe', notes: '  Note originale.\nDeuxième ligne.  ', items: [{ description: 'Travaux existants', quantity: '2', price: '75' }] };
  if (rows !== undefined) setNoteRows(state, rows);
  const note = element({ field: 'notes', note: '0' }), line = element({ item: '0', key: 'description' });
  const entry = element(), mic = element(), close = element();
  const notes = [note], noteEntries = [], noteMics = [], noteCloses = [];
  let speech;
  const controller = { stop: async () => { calls.stops++; speech.onFinal('Fin de dictée.'); }, cancel: async () => { calls.cancels++; } };
  const context = {
    automatic: {reconcile() {}, observe() {}, supersede() {}, snapshot:()=>({undoable:false}), schedule:async()=>{}},
    improvements:{enqueue:job=>calls.queued.push(job)},
    writingIds:()=>({items:state.items.map((_,i)=>`item:${i}`),notes:[]}), writingFields:()=>state.items.map((item,i)=>({key:`item:${i}`,text:item.description})), validateDescriptionLimits:async()=>{}, paintWritingStatus() {},
    state, noteRows, setNoteRows, busy: false, rowMotionPending:false, mailOpen: false, englishMode: false, voiceSession: null, voiceRecovery: null,
    voiceRetryBusy: false, lineAssist: null, activeCapture: null, voiceQueue: Promise.resolve(),
    assistMotionIndex:null, openPanelMotion() {}, closePanelMotion() {},
    collapseRowMotion: async row => {
      assert.equal(context.rowMotionPending, true, 'removal holds its busy guard during motion');
      calls.motions.push({ index: Number(row.dataset.noteEntry), rows: noteRows(state) });
    },
    document: {
      addEventListener: (name, fn) => listeners[name] = fn,
      querySelector: selector => {
        if (selector === '#client-notes') return notes[0];
        const match = /^#client-notes-(\d+)$/.exec(selector) || /^\[data-note="(\d+)"\]$/.exec(selector);
        return match ? notes[Number(match[1])] : null;
      },
      querySelectorAll: selector => selector === '.line-entry' ? [{ querySelector: () => line }] : selector === '.notes-entry' ? noteEntries : [],
      createElement: () => element()
    },
    esc: value => String(value), errorText: error => String(error?.message || error),
    aiReady: async () => true,
    runCommand: async (name, args) => {
      calls.commands.push({ name, args });
      if (name === 'start_local_asr') return 'ws://isolated-speech';
      assert.equal(name, 'ai_rewrite_line', 'Unexpected external command');
      if (context.rewriteResponse) return context.rewriteResponse(args);
      return args.style === 'bullets' ? '• Proposition à vérifier' : `Proposition ${args.variation}`;
    },
    startStreamingRecognition: async options => { speech = options; return controller; },
    render() {
      const current = noteRows(state);
      notes.length = current.length; noteEntries.length = current.length; noteMics.length = current.length; noteCloses.length = current.length;
      current.forEach((value, index) => {
        const key = index === 0 ? 'notes' : `notes:${index}`;
        const box = notes[index] ||= index === 0 ? note : element();
        box.dataset = { ...(index === 0 ? { field: 'notes' } : {}), note: String(index) };
        box.value = value; box.readOnly = false; box.review = null;
        box.focus = () => { context.document.activeElement = box; };
        noteMics[index] ||= index === 0 ? mic : element();
        noteMics[index].dataset = { lineDictate: key };
        noteCloses[index] ||= index === 0 ? close : element();
        noteCloses[index].dataset = { removeNote: String(index) };
        noteCloses[index].hidden = true;
        const row = noteEntries[index] ||= index === 0 ? entry : element();
        row.dataset = { noteEntry: String(index) };
        row.querySelector = selector => selector === 'textarea' ? box : selector === '[data-line-dictate]' ? noteMics[index] : selector === '[data-remove-note]' ? noteCloses[index] : null;
      });
      line.dataset = { item: '0', key: 'description' }; line.value = state.items[0]?.description; line.readOnly = false;
      const assist = context.lineAssist;
      if (assist) {
        const index = context.noteIndex(assist.index);
        if (index !== null) context.paintLineAssist(noteEntries[index], assist, notes[index], noteMics[index], noteCloses[index]);
        else context.paintLineAssist(entry, assist, line, mic, close);
      }
    },
    rememberUndo: () => calls.undo++, markDirty: () => calls.dirty++, saveNow: async () => { calls.saves++; calls.saved.push({ notes: state.notes, noteEntries: noteRows(state), items: structuredClone(Array.from(state.items)) }); },
    sync: () => calls.sync++, paintValidation: () => calls.validation++, fitTextareas() {},
    releaseVoiceField() {}, releaseVoiceItem() {}, notice: message => calls.notices.push(message)
  };
  vm.runInNewContext(section(text, '    function paintLineAssist(', '    function folderDialog(')
    + section(text, '    function lineAssistText(', '    async function startDocumentDictation(')
    + section(text, "    document.addEventListener('click', async event => {", "    document.addEventListener('change', event => {"), context);
  context.render();
  return {
    state, calls, context, note, line, entry, mic, close, notes, noteEntries, noteMics, noteCloses,
    speech: () => speech,
    input: (target, value) => { target.value = value; listeners.input({ target }); },
    async click(attribute, dataset = {}) {
      const button = { dataset, hasAttribute: name => name === attribute, closest: () => noteEntries[Number(dataset.removeNote)] };
      await listeners.click({ target: { dataset: {}, closest: () => button } });
    }
  };
}
const enhanceNotes = probe => probe.click('', { lineEnhance: 'notes' });
const micNotes = probe => probe.click('', { lineDictate: 'notes' });
const discard = probe => probe.click('', { closeLineAssist: 'notes' });
const accept = probe => probe.click('data-line-accept');
const assertNotesProposal = probe => assert.equal(probe.note.value, 'Proposition 0');

test('Production Notes card provides labelled entries and per-entry microphone and AI controls', () => {
  const code = section(source, '    function notesControl()', '    function updateDialog(');
  const html = vm.runInNewContext(code + ';notesControl()', { state: { notes: 'Texte conservé' }, noteRows, esc: value => value, smallIcon: () => '<svg></svg>' });
  assert.match(html, /<label class="sr-only" for="client-notes">Note 1/);
  assert.match(html, /data-line-dictate="notes"/);
  assert.match(html, /data-line-enhance="notes"/);
  assert.match(html, /data-remove-note="0"/);
  assert.match(html, /data-add-note/);
  assert.match(html, /<textarea id="client-notes" data-field="notes"[^>]*>Texte conservé<\/textarea>/);
  const multiple = vm.runInNewContext(code + ';notesControl()', {
    state: { noteEntries: ['Première', 'Deuxième\nLigne', 'Troisième'] }, noteRows, esc: value => value, smallIcon: () => '<svg></svg>',
  });
  for (const index of [1, 2]) {
    assert.match(multiple, new RegExp(`data-line-dictate="notes:${index}"`));
    assert.match(multiple, new RegExp(`data-line-enhance="notes:${index}"`));
    assert.match(multiple, new RegExp(`<label class="sr-only" for="client-notes-${index}">Note ${index + 1}`));
    assert.match(multiple, new RegExp(`<textarea id="client-notes-${index}"\\s+data-note="${index}"`));
  }
});

test('Notes proposal uses real command contract, stays inline and editable, and accepts only Notes', async () => {
  const probe = editor(), original = probe.state.notes, work = structuredClone(probe.state.items);
  // Fail immediately if Notes accidentally routes through an invalid work index.
  probe.state.items = new Proxy(probe.state.items, { get(target, key) {
    if (key === 'notes' || key === '-1' || key === 'NaN') throw new Error(`Invalid item routing: ${key}`);
    return Reflect.get(target, key);
  } });
  await enhanceNotes(probe);
  assert.equal(probe.calls.commands[0].name, 'ai_rewrite_line');
  assert.deepEqual({ ...probe.calls.commands[0].args }, { source: original.trim(), style: 'prose', variation: 0 });
  assertNotesProposal(probe);
  assert.equal(probe.note.dataset.field, undefined);
  assert.equal(probe.note.dataset.assistProposal, '');
  assert.equal(probe.note.readOnly, false);
  assert.equal(probe.close.hidden, false);
  assert.match(probe.note.review.innerHTML, /Texte clair.*Liste à puces.*Autre version.*Accepter/s);
  probe.input(probe.note, 'Proposition corrigée à la main');
  assert.equal(probe.state.notes, original);
  assert.equal(probe.calls.dirty, 0);
  await accept(probe);
  assert.equal(probe.state.notes, 'Proposition corrigée à la main');
  assert.deepEqual(Array.from(probe.state.items), work);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.saves, 1);
  assert.equal(probe.context.lineAssist, null);
  assert.equal(probe.note.dataset.field, 'notes');
});

test('Notes styles and another version preserve original source; X restores exact whitespace', async () => {
  const probe = editor(), original = probe.state.notes;
  await enhanceNotes(probe);
  await probe.click('', { lineStyle: 'bullets' });
  assert.equal(probe.note.value, '• Proposition à vérifier');
  await probe.click('data-line-variation');
  const request = probe.calls.commands.at(-1).args;
  assert.equal(request.source, original.trim());
  assert.equal(request.style, 'bullets');
  assert.equal(request.variation, 1);
  await discard(probe);
  assert.equal(probe.state.notes, original);
  assert.equal(probe.note.value, original);
  assert.equal(probe.calls.dirty, 0);
  assert.equal(probe.calls.saves, 0);
});

test('Notes microphone uses local speech, toggles stop, and rewrites original plus final transcript', async () => {
  const probe = editor(), original = probe.state.notes;
  await micNotes(probe);
  assert.equal(probe.calls.commands[0].name, 'start_local_asr');
  assert.equal(probe.speech().url, 'ws://isolated-speech');
  assert.equal(probe.entry.classList.contains('line-recording'), true);
  assert.equal(probe.mic.attrs['aria-pressed'], 'true');
  assert.equal(probe.note.readOnly, true);
  probe.speech().onPartial('Paroles partielles');
  assert.equal(probe.note.value, `${original}\nParoles partielles`);
  probe.speech().onFinal('Installation comprise.');
  assert.equal(probe.note.value, `${original}\nInstallation comprise.`);
  assert.equal(probe.state.notes, original);
  await micNotes(probe);
  assert.equal(probe.calls.stops, 1);
  assert.equal(probe.entry.classList.contains('line-recording'), false);
  assert.equal(probe.mic.attrs['aria-pressed'], 'false');
  assert.equal(probe.calls.commands.at(-1).args.source, `${original}\nInstallation comprise. Fin de dictée.`);
  assert.equal(probe.state.notes, original);
  await accept(probe);
  assert.equal(probe.state.notes, 'Proposition 0');
  assert.equal(probe.state.items[0].description, 'Travaux existants');
});

test('X cancels capture and ignores subsequent speech; manual Notes typing validates and autosaves normally', async () => {
  const probe = editor(), original = probe.state.notes;
  await micNotes(probe);
  probe.speech().onFinal('Texte à supprimer');
  await discard(probe);
  assert.equal(probe.calls.cancels, 1);
  probe.speech().onFinal('Résultat tardif');
  assert.equal(probe.note.value, original);
  probe.input(probe.note, 'Note saisie manuellement');
  assert.equal(probe.state.notes, 'Note saisie manuellement');
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.calls.validation, 1);
  assert.equal(probe.calls.sync, 1);
});

test('AI and microphone failures preserve Notes and expose real failure with recoverable transcript', async () => {
  const probe = editor(), original = probe.state.notes;
  probe.context.runCommand = async () => { throw new Error('Service hors ligne'); };
  await enhanceNotes(probe);
  assert.match(probe.note.review.innerHTML, /IA indisponible.*Service hors ligne/);
  assert.equal(probe.state.notes, original);
  await discard(probe);
  await micNotes(probe);
  assert.match(probe.note.review.innerHTML, /Microphone indisponible.*Service hors ligne/);
  assert.equal(probe.state.notes, original);
  await discard(probe);
  const recovery = editor();
  await micNotes(recovery);
  recovery.speech().onFinal('Paroles conservées.');
  recovery.speech().onError(new Error('Connexion interrompue'));
  assert.equal(recovery.note.value, `${original}\nParoles conservées.`);
  assert.equal(recovery.note.readOnly, false);
  assert.match(recovery.note.review.innerHTML, /Dictée interrompue.*Connexion interrompue/);
  assert.equal(recovery.state.notes, original);
  await discard(recovery);
  assert.equal(recovery.note.value, original);
});

test('Closing pending AI ignores late results and does not overwrite a subsequent manual edit', { timeout: 2000 }, async () => {
  const probe = editor();
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  probe.context.runCommand = () => new Promise(resolve => { finish = resolve; entered(); });
  const pending = enhanceNotes(probe);
  await started;
  assert.equal(typeof finish, 'function');
  assert.equal(probe.note.readOnly, true);
  await discard(probe);
  probe.input(probe.note, 'Nouvelle note');
  finish('Résultat tardif');
  await pending;
  assert.equal(probe.context.lineAssist, null);
  assert.equal(probe.state.notes, 'Nouvelle note');
  assert.equal(probe.note.value, 'Nouvelle note');
});

test('Closing during microphone startup cancels the late controller and prevents a second recording', { timeout: 2000 }, async () => {
  const probe = editor(), original = probe.state.notes;
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  probe.context.startStreamingRecognition = () => new Promise(resolve => { finish = resolve; entered(); });
  const pending = micNotes(probe);
  await started;
  await probe.context.startLineDictation(0);
  assert.equal(probe.context.lineAssist.index, 'notes');
  assert.equal(probe.calls.commands.length, 1);
  await discard(probe);
  finish({ cancel: async () => probe.calls.cancels++ });
  await pending;
  assert.equal(probe.calls.cancels, 1);
  assert.equal(probe.context.activeCapture, null);
  assert.equal(probe.state.notes, original);
});

test('Unavailable AI, empty Notes, and a changed draft never silently accept', async () => {
  const probe = editor(), original = probe.state.notes;
  probe.context.aiReady = async () => false;
  await enhanceNotes(probe);
  await micNotes(probe);
  assert.equal(probe.calls.commands.length, 0);
  probe.context.aiReady = async () => true;
  probe.state.notes = '';
  await enhanceNotes(probe);
  assert.equal(probe.calls.commands.length, 0);
  assert.match(probe.calls.notices.at(-1), /Écrivez d’abord une note/);
  probe.state.notes = original;
  await enhanceNotes(probe);
  probe.state.id = 'other-draft';
  await accept(probe);
  assert.equal(probe.state.notes, original);
  assert.equal(probe.calls.saves, 0);
});

test('Work-line queue captures only its description; microphone remains field-scoped', async () => {
  const probe = editor(), original = probe.state.notes;
  await probe.click('', { lineEnhance: '0' });
  assert.equal(probe.calls.queued[0].source, 'Travaux existants');
  assert.equal(probe.calls.queued[0].key,'item:0');
  probe.input(probe.line, 'Travaux corrigés');
  assert.equal(probe.state.items[0].description, 'Travaux corrigés');
  await probe.click('', { lineDictate: '0' });
  probe.speech().onFinal('Ajout');
  assert.equal(probe.line.value, 'Travaux corrigés\nAjout');
  await probe.click('', { lineDictate: '0' });
  assert.equal(probe.calls.commands.at(-1).args.source, 'Travaux corrigés\nAjout Fin de dictée.');
  await accept(probe);
  assert.equal(probe.state.notes, original);
  assert.equal(probe.state.items[0].quantity, '2');
  assert.equal(probe.state.items[0].price, '75');
});

test('Negative control catches broken Notes routing in an isolated source copy', async () => {
  const marker = 'return note !== null ? noteRows(state)[note] : state.items[index]?.description;';
  assert.ok(source.includes(marker), 'Routing mutation must be injected');
  const broken = editor(source.replace(marker, 'return state.items[index]?.description;'));
  await enhanceNotes(broken);
  assert.throws(() => assertNotesProposal(broken), assert.AssertionError, 'A broken router must fail the same proposal assertion');
  assert.equal(broken.calls.commands.length, 0);
});

const multiNotes = ['  Première note\n\nParagraphe conservé  ', 'Deuxième note\nLigne conservée', '  Troisième note  '];
const keyForNote = index => index === 0 ? 'notes' : `notes:${index}`;
const enhanceNote = (probe, index) => probe.click('', { lineEnhance: keyForNote(index) });
const dictateNote = (probe, index) => probe.click('', { lineDictate: keyForNote(index) });
const discardNote = (probe, index) => probe.click('', { closeLineAssist: keyForNote(index) });

async function verifySecondaryAcceptance(probe, index) {
  const original = noteRows(probe.state), mirror = probe.state.notes, work = structuredClone(probe.state.items);
  await enhanceNote(probe, index);
  assert.equal(probe.context.lineAssist.index, `notes:${index}`);
  assert.deepEqual({ ...probe.calls.commands[0].args }, { source: original[index].trim(), style: 'prose', variation: 0 });
  const target = probe.notes[index];
  assert.equal(target.value, 'Proposition 0');
  assert.equal(target.dataset.note, undefined);
  assert.equal(target.dataset.assistProposal, '');
  assert.equal(target.readOnly, false);
  assert.equal(probe.noteCloses[index].dataset.closeLineAssist, `notes:${index}`);
  assert.equal(probe.noteCloses[index].dataset.removeNote, undefined);
  assert.deepEqual(noteRows(probe.state), original);
  assert.equal(probe.state.notes, mirror);
  assert.equal(probe.calls.saves, 0);
  probe.input(target, 'Proposition secondaire corrigée\nDeuxième ligne');
  assert.deepEqual(noteRows(probe.state), original, 'editing a proposal must not edit any committed note');
  assert.equal(probe.calls.dirty, 0);
  await accept(probe);
  const expected = original.with(index, 'Proposition secondaire corrigée\nDeuxième ligne');
  assert.deepEqual(noteRows(probe.state), expected);
  assert.equal(probe.state.notes, expected.join('\n\n'));
  assert.deepEqual(probe.state.items, work);
  assert.equal(probe.calls.saves, 1);
  assert.deepEqual(probe.calls.saved[0].noteEntries, expected);
  assert.equal(probe.calls.saved[0].notes, expected.join('\n\n'));
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.context.lineAssist, null);
  assert.equal(probe.notes[index].dataset.note, String(index));
  assert.equal(probe.notes[0].dataset.field, 'notes');
  assert.equal(probe.notes[0].dataset.note, '0');
}

test('secondary notes:1 and notes:2 AI accept only their editable proposal and save the full ordered mirror', async () => {
  for (const index of [1, 2]) await verifySecondaryAcceptance(editor(source, multiNotes), index);
});

test('secondary AI cancel restores exact original rows without accepting or saving the proposal', async () => {
  const probe = editor(source, multiNotes), before = structuredClone(probe.state);
  await enhanceNote(probe, 2);
  probe.input(probe.notes[2], 'Proposition à jeter');
  await discardNote(probe, 2);
  assert.deepEqual(probe.state, before);
  assert.equal(probe.notes[2].value, multiNotes[2]);
  assert.equal(probe.notes[2].dataset.note, '2');
  assert.equal(probe.calls.dirty, 0);
  assert.equal(probe.calls.undo, 0);
  assert.equal(probe.calls.saves, 0);
  assert.equal(probe.context.lineAssist, null);
});

test('secondary pending AI cancel ignores late results and preserves a later manual edit only in that row', { timeout: 2000 }, async () => {
  const probe = editor(source, multiNotes);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  probe.context.runCommand = () => new Promise(resolve => { finish = resolve; entered(); });
  const pending = enhanceNote(probe, 1);
  await started;
  assert.equal(probe.context.lineAssist.index, 'notes:1');
  assert.equal(probe.notes[1].readOnly, true);
  await discardNote(probe, 1);
  probe.input(probe.notes[1], 'Correction manuelle\nSeconde ligne');
  finish('Réponse IA tardive à ignorer');
  await pending;
  assert.deepEqual(noteRows(probe.state), multiNotes.with(1, 'Correction manuelle\nSeconde ligne'));
  assert.equal(probe.notes[1].value, 'Correction manuelle\nSeconde ligne');
  assert.equal(probe.context.lineAssist, null);
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.saves, 0);
});

async function verifySecondaryDictation(probe) {
  const original = noteRows(probe.state), work = structuredClone(probe.state.items), index = 1;
  probe.context.rewriteResponse = args => args.source; // Synthetic rewrite retains the dictated append.
  await dictateNote(probe, index);
  assert.equal(probe.context.lineAssist.index, 'notes:1');
  assert.equal(probe.calls.commands[0].name, 'start_local_asr');
  assert.equal(probe.noteEntries[index].classList.contains('line-recording'), true);
  assert.equal(probe.noteMics[index].attrs['aria-pressed'], 'true');
  assert.equal(probe.notes[index].readOnly, true);
  probe.speech().onPartial('Paroles provisoires');
  assert.equal(probe.notes[index].value, original[index] + '\nParoles provisoires');
  assert.equal(probe.notes[0].value, original[0]);
  assert.equal(probe.notes[2].value, original[2]);
  probe.speech().onFinal('Installation comprise.');
  probe.speech().onFinal('Mesures confirmées.');
  assert.equal(probe.notes[index].value, original[index] + '\nInstallation comprise. Mesures confirmées.');
  assert.deepEqual(noteRows(probe.state), original);
  assert.equal(probe.calls.dirty, 0);
  await dictateNote(probe, index);
  const appended = original[index] + '\nInstallation comprise. Mesures confirmées. Fin de dictée.';
  assert.equal(probe.calls.stops, 1);
  assert.deepEqual({ ...probe.calls.commands.at(-1).args }, { source: appended, style: 'prose', variation: 0 });
  assert.equal(probe.notes[index].value, appended);
  assert.deepEqual(noteRows(probe.state), original, 'recognized text stays a proposal until acceptance');
  await accept(probe);
  assert.deepEqual(noteRows(probe.state), original.with(index, appended));
  assert.equal(probe.state.notes, original.with(index, appended).join('\n\n'));
  assert.deepEqual(probe.state.items, work);
  assert.equal(probe.calls.saves, 1);
  assert.deepEqual(probe.calls.saved[0].noteEntries, original.with(index, appended));
}

test('secondary microphone routes partial/final text and appends only to the selected note after acceptance', async () => {
  await verifySecondaryDictation(editor(source, multiNotes));
});

test('secondary microphone cancel discards transcripts and ignores late speech without changing other notes', async () => {
  const probe = editor(source, multiNotes), before = structuredClone(probe.state);
  await dictateNote(probe, 2);
  probe.speech().onFinal('Texte secondaire à jeter');
  assert.equal(probe.notes[2].value, multiNotes[2] + '\nTexte secondaire à jeter');
  await discardNote(probe, 2);
  assert.equal(probe.calls.cancels, 1);
  probe.speech().onPartial('Partiel tardif');
  probe.speech().onFinal('Final tardif');
  assert.deepEqual(probe.state, before);
  assert.equal(probe.notes[2].value, multiNotes[2]);
  assert.equal(probe.notes[2].readOnly, false);
  assert.equal(probe.context.activeCapture, null);
  assert.equal(probe.calls.saves, 0);
  assert.equal(probe.calls.dirty, 0);
});

test('data-note input takes priority over data-field notes and preserves every unrelated entry', () => {
  const probe = editor(source, multiNotes);
  probe.input(probe.notes[0], 'Première modifiée'); // The first textarea has both attributes.
  assert.deepEqual(noteRows(probe.state), multiNotes.with(0, 'Première modifiée'));
  probe.notes[1].dataset.field = 'notes'; // Conflicting attribute proves the priority is causal.
  probe.input(probe.notes[1], 'Deuxième modifiée\nSuite');
  const expected = ['Première modifiée', 'Deuxième modifiée\nSuite', multiNotes[2]];
  assert.deepEqual(noteRows(probe.state), expected);
  assert.equal(probe.state.notes, expected.join('\n\n'));
  assert.equal(probe.calls.dirty, 2);
  assert.equal(probe.calls.validation, 2);
  assert.equal(probe.calls.saves, 0);
});

test('removal ignores invalid indices and removes the last empty note', async () => {
  const probe = editor(source, multiNotes), before = structuredClone(probe.state);
  for (const removeNote of ['-1', '3', 'NaN', '1.5']) await probe.click('', { removeNote });
  assert.deepEqual(probe.state, before);
  assert.equal(probe.calls.undo, 0);
  assert.equal(probe.calls.saves, 0);
  assert.equal(probe.calls.dirty, 0);
  assert.equal(probe.calls.motions.length, 0);
  const last = editor(source, ['']);
  await last.click('', { removeNote: '0' });
  assert.deepEqual(noteRows(last.state), []);
  assert.equal(last.state.notes, '');
  assert.equal(last.calls.undo, 1);
  assert.equal(last.calls.saves, 1);
  assert.equal(last.calls.motions.length, 0);
});

test('removing the last filled note saves an empty list and retains work', async () => {
  const probe = editor(source, ['Note unique\nPlusieurs lignes']), work = structuredClone(probe.state.items);
  await probe.click('', { removeNote: '0' });
  assert.deepEqual(noteRows(probe.state), []);
  assert.equal(probe.state.notes, '');
  assert.deepEqual(probe.state.items, work);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.saves, 1);
  assert.deepEqual(probe.calls.saved[0].noteEntries, []);
  assert.equal(probe.calls.motions.length, 0);
  assert.equal(probe.notes.includes(probe.context.document.activeElement), false);
});

async function verifyMultiRemoval(probe, index = 1) {
  const original = noteRows(probe.state), expected = original.filter((_, i) => i !== index);
  await probe.click('', { removeNote: String(index) });
  assert.deepEqual(noteRows(probe.state), expected);
  assert.equal(probe.state.notes, expected.join('\n\n'));
  assert.deepEqual(probe.calls.motions, [{ index, rows: original }]);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.calls.dirty, 1);
  assert.equal(probe.calls.saves, 1);
  assert.deepEqual(probe.calls.saved[0].noteEntries, expected);
  assert.equal(probe.context.rowMotionPending, false);
  assert.equal(probe.context.document.activeElement, probe.notes[Math.min(index, expected.length - 1)]);
}

test('multi-note removal targets the selected row, saves the mirror, and focuses the surviving neighbor', async () => {
  for (const index of [1, 2]) await verifyMultiRemoval(editor(source, multiNotes), index);
});

test('pending row collapse blocks a concurrent removal until the selected row is removed once', { timeout: 2000 }, async () => {
  const probe = editor(source, multiNotes);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  probe.context.collapseRowMotion = row => {
    assert.equal(row, probe.noteEntries[1]);
    assert.equal(probe.context.rowMotionPending, true);
    entered(); return new Promise(resolve => { finish = resolve; });
  };
  const pending = probe.click('', { removeNote: '1' });
  await started;
  await probe.click('', { removeNote: '0' });
  assert.deepEqual(noteRows(probe.state), multiNotes);
  assert.equal(probe.calls.saves, 0);
  finish(); await pending;
  assert.deepEqual(noteRows(probe.state), [multiNotes[0], multiNotes[2]]);
  assert.equal(probe.calls.saves, 1);
  assert.equal(probe.calls.undo, 1);
  assert.equal(probe.context.rowMotionPending, false);
});

async function verifyEditDuringRemoval(probe) {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  probe.context.collapseRowMotion = () => {
    assert.equal(probe.context.rowMotionPending, true);
    entered(); return new Promise(resolve => { finish = resolve; });
  };
  const pending = probe.click('', { removeNote: '1' });
  await started;
  probe.input(probe.notes[2], 'Troisième modifiée pendant le retrait\nTexte conservé');
  assert.equal(probe.state.noteEntries[2], 'Troisième modifiée pendant le retrait\nTexte conservé');
  finish(); await pending;
  const expected = [multiNotes[0], 'Troisième modifiée pendant le retrait\nTexte conservé'];
  assert.deepEqual(noteRows(probe.state), expected);
  assert.equal(probe.state.notes, expected.join('\n\n'));
  assert.deepEqual(probe.calls.saved[0].noteEntries, expected);
  assert.equal(probe.calls.saves, 1);
  assert.equal(probe.calls.dirty, 2);
  assert.equal(probe.context.rowMotionPending, false);
}

test('removal keeps manual edits to another note made while the selected row collapses', { timeout: 2000 }, async () => {
  await verifyEditDuringRemoval(editor(source, multiNotes));
});

test('removing another row first cancels an open secondary proposal and preserves its unaccepted original', async () => {
  const probe = editor(source, multiNotes);
  await enhanceNote(probe, 1);
  probe.input(probe.notes[1], 'Proposition jamais acceptée');
  await probe.click('', { removeNote: '0' });
  assert.deepEqual(noteRows(probe.state), multiNotes.slice(1));
  assert.equal(probe.state.notes, multiNotes.slice(1).join('\n\n'));
  assert.equal(probe.context.lineAssist, null);
  assert.equal(probe.calls.saves, 1);
  assert.equal(probe.calls.undo, 1);
});

test('secondary routing checks reject wrong source, accept row, microphone textarea, removal row and stale removal data', async () => {
  for (const mutation of [
    { anchor: 'return note !== null ? noteRows(state)[note] : state.items[index]?.description;', replacement: 'return note !== null ? noteRows(state)[0] : state.items[index]?.description;', check: probe => verifySecondaryAcceptance(probe, 2) },
    { anchor: 'entries[noteIndex(lineAssist.index)] = lineAssist.proposal;', replacement: 'entries[0] = lineAssist.proposal;', check: probe => verifySecondaryAcceptance(probe, 2) },
    { anchor: "document.querySelector(note === 0 ? '#client-notes' : `#client-notes-${note}`)", replacement: "document.querySelector('#client-notes')", check: verifySecondaryDictation },
    { anchor: 'latest.splice(index, 1);', replacement: 'latest.splice(0, 1);', check: verifyMultiRemoval },
    { anchor: 'const latest = noteRows(state);', replacement: 'const latest = entries;', check: verifyEditDuringRemoval },
  ]) {
    assert.equal(source.split(mutation.anchor).length - 1, 1, `Mutation must be injected exactly once: ${mutation.anchor}`);
    const broken = editor(source.replace(mutation.anchor, mutation.replacement), multiNotes);
    await assert.rejects(mutation.check(broken), { code: 'ERR_ASSERTION' }, 'The same production-handler assertions must reject the defect');
  }
});
