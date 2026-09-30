import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
    },
    hasAttribute(name) { return name === 'data-assist-proposal' && this.dataset.assistProposal !== undefined; },
    insertAdjacentElement(position, node) { this.review = node; }
  };
}

// Run actual shared assist functions, painter, and production click/input handlers.
// Only transport, speech hardware, and the surrounding editor are isolated.
function editor(text = source) {
  const listeners = {}, calls = { commands: [], saves: 0, dirty: 0, undo: 0, validation: 0, sync: 0, notices: [], stops: 0, cancels: 0 };
  const state = { id: 'notes-probe', notes: '  Note originale.\nDeuxième ligne.  ', items: [{ description: 'Travaux existants', quantity: '2', price: '75' }] };
  const note = element({ field: 'notes' }), line = element({ item: '0', key: 'description' });
  const entry = element(), mic = element(), close = element();
  let speech;
  const controller = { stop: async () => { calls.stops++; speech.onFinal('Fin de dictée.'); }, cancel: async () => { calls.cancels++; } };
  const context = {
    state, busy: false, mailOpen: false, englishMode: false, voiceSession: null, voiceRecovery: null,
    voiceRetryBusy: false, lineAssist: null, activeCapture: null, voiceQueue: Promise.resolve(),
    document: {
      addEventListener: (name, fn) => listeners[name] = fn,
      querySelector: selector => selector === '#client-notes' ? note : null,
      querySelectorAll: selector => selector === '.line-entry' ? [{ querySelector: () => line }] : [],
      createElement: () => element()
    },
    esc: value => String(value), errorText: error => String(error?.message || error),
    aiReady: async () => true,
    runCommand: async (name, args) => {
      calls.commands.push({ name, args });
      if (name === 'start_local_asr') return 'ws://isolated-speech';
      assert.equal(name, 'ai_rewrite_line', 'Unexpected external command');
      return args.style === 'bullets' ? '• Proposition à vérifier' : `Proposition ${args.variation}`;
    },
    startStreamingRecognition: async options => { speech = options; return controller; },
    render() {
      note.dataset = { field: 'notes' }; note.value = state.notes; note.readOnly = false;
      line.dataset = { item: '0', key: 'description' }; line.value = state.items[0]?.description; line.readOnly = false;
      const assist = context.lineAssist;
      if (assist) context.paintLineAssist(entry, assist, assist.index === 'notes' ? note : line, mic, close);
    },
    rememberUndo: () => calls.undo++, markDirty: () => calls.dirty++, saveNow: async () => calls.saves++,
    sync: () => calls.sync++, paintValidation: () => calls.validation++, fitTextareas() {},
    releaseVoiceField() {}, releaseVoiceItem() {}, notice: message => calls.notices.push(message)
  };
  vm.runInNewContext(section(text, '    function paintLineAssist(', '    function folderDialog(')
    + section(text, '    function lineAssistText(', '    async function startDocumentDictation(')
    + section(text, "    document.addEventListener('click', async event => {", "    document.addEventListener('change', event => {"), context);
  context.render();
  return {
    state, calls, context, note, line, entry, mic, close,
    speech: () => speech,
    input: (target, value) => { target.value = value; listeners.input({ target }); },
    async click(attribute, dataset = {}) {
      const button = { dataset, hasAttribute: name => name === attribute };
      await listeners.click({ target: { dataset: {}, closest: () => button } });
    }
  };
}
const enhanceNotes = probe => probe.click('', { lineEnhance: 'notes' });
const micNotes = probe => probe.click('', { lineDictate: 'notes' });
const discard = probe => probe.click('', { closeLineAssist: 'notes' });
const accept = probe => probe.click('data-line-accept');
const assertNotesProposal = probe => assert.equal(probe.note.value, 'Proposition 0');

test('Production Notes markup wires discreet controls to the original field with an explicit label', () => {
  const template = section(source, '<div class="notes-entry span2">', '</textarea></div>') + '</textarea></div>';
  const html = vm.runInNewContext('`' + template + '`', { state: { notes: 'Texte conservé' }, esc: value => value });
  assert.match(html, /<label for="client-notes">Note pour le client/);
  assert.match(html, /data-line-dictate="notes"/);
  assert.match(html, /data-line-enhance="notes"/);
  assert.match(html, /data-close-line-assist="notes"[^>]*hidden/);
  assert.match(html, /<textarea id="client-notes" data-field="notes"[^>]*>Texte conservé<\/textarea>/);
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

test('Shared work-line assist still routes only its description for AI and microphone', async () => {
  const probe = editor(), original = probe.state.notes;
  await probe.click('', { lineEnhance: '0' });
  assert.equal(probe.calls.commands[0].args.source, 'Travaux existants');
  probe.input(probe.line, 'Travaux corrigés');
  await accept(probe);
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
  const marker = "return index === 'notes' ? state.notes : state.items[index]?.description;";
  assert.ok(source.includes(marker), 'Routing mutation must be injected');
  const broken = editor(source.replace(marker, 'return state.items[index]?.description;'));
  await enhanceNotes(broken);
  assert.throws(() => assertNotesProposal(broken), assert.AssertionError, 'A broken router must fail the same proposal assertion');
  assert.equal(broken.calls.commands.length, 0);
});
