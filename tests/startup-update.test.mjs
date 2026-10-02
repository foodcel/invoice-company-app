import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
function startup(check) {
  let renders = 0, released = 0;
  const context = { startupUpdateChecked: false, updateRequestId: 0, updateOpen: false,
    availableUpdate: null, updateVersion: '', updateStatus: 'idle', updateError: '', startupUpdatePending: false,
    check, render: () => renders++, releaseUpdate: async () => released++, console: { debug() {} } };
  const begin = source.indexOf('    async function checkForStartupUpdate()');
  const end = source.indexOf('    function closeUpdate(', begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInNewContext(source.slice(begin, end), context);
  return { context, renders: () => renders, released: () => released };
}

test('launch check stays silent when current or offline and runs only once', async () => {
  for (const offline of [false, true]) {
    let requests = 0;
    const probe = startup(async () => { requests++; if (offline) throw new Error('offline'); return null; });
    await probe.context.checkForStartupUpdate(); await probe.context.checkForStartupUpdate();
    assert.equal(requests, 1); assert.equal(probe.renders(), 0);
    assert.equal(probe.context.updateOpen, false); assert.equal(probe.context.startupUpdatePending, false);
    assert.equal(probe.context.availableUpdate, null);
  }
});

test('available launch update offers a prompt without downloading and defers to active dialogs', async () => {
  let installs = 0;
  const found = { version: '0.1.20', downloadAndInstall: () => installs++ };
  const probe = startup(async () => found);
  await probe.context.checkForStartupUpdate();
  assert.equal(probe.context.availableUpdate, found); assert.equal(probe.context.updateVersion, '0.1.20');
  assert.equal(probe.context.updateStatus, 'available'); assert.equal(probe.context.startupUpdatePending, true);
  assert.equal(probe.renders(), 1); assert.equal(installs, 0);
  // Execute the actual render admission branch for every blocking editor state.
  const begin = source.indexOf('      if (startupUpdatePending &&');
  const end = source.indexOf('      app.className =', begin);
  assert.ok(begin > 0 && end > begin);
  for (const blocker of ['busy', 'mailOpen', 'recentOpen', 'folderOpen', 'settingsOpen', 'preferencesOpen', 'voiceSession', 'lineAssist']) {
    const admission = { startupUpdatePending: true, updateOpen: false, busy: false, mailOpen: false,
      recentOpen: false, folderOpen: false, settingsOpen: false, preferencesOpen: false, voiceSession: null, lineAssist: null, [blocker]: true };
    vm.runInNewContext(source.slice(begin, end), admission);
    assert.equal(admission.updateOpen, false, blocker); assert.equal(admission.startupUpdatePending, true);
    admission[blocker] = false;
    vm.runInNewContext(source.slice(begin, end), admission);
    assert.equal(admission.updateOpen, true, blocker); assert.equal(admission.startupUpdatePending, false);
  }
});

test('late startup response cannot replace a newer manual update check', async () => {
  let resolve;
  const probe = startup(() => new Promise(done => { resolve = done; }));
  const pending = probe.context.checkForStartupUpdate();
  probe.context.updateRequestId++;
  resolve({ version: '0.1.20' }); await pending;
  assert.equal(probe.released(), 1); assert.equal(probe.renders(), 0);
  assert.equal(probe.context.availableUpdate, null);
});

test('finishing a busy action admits a pending startup prompt', () => {
  const begin = source.indexOf('    function setBusy(active)');
  const end = source.indexOf('    async function nativeTransition(', begin);
  assert.ok(begin > 0 && end > begin);
  let renders = 0;
  const context = { busy: true, startupUpdatePending: true, mailOpen: false, recentOpen: false,
    updateOpen: false, folderOpen: false, settingsOpen: false, preferencesOpen: false, voiceSession: null, lineAssist: null,
    document: { querySelector: () => null }, render: () => renders++ };
  vm.runInNewContext(source.slice(begin, end), context);
  context.setBusy(true);
  assert.equal(renders, 0);
  context.setBusy(false);
  assert.equal(renders, 1);
  context.mailOpen = true;
  context.setBusy(false);
  assert.equal(renders, 1);
});
