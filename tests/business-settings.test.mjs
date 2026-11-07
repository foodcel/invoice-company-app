import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');
function functionSource(name, next) {
  const start = source.indexOf(`    function ${name}(`) >= 0 ? source.indexOf(`    function ${name}(`) : source.indexOf(`    async function ${name}(`);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function settings(provider = 'openai', overrides = {}) {
  return { provider, openaiConfigured: false, claudeConfigured: false, ...overrides };
}
function dialog(aiSettings, overrides = {}) {
  const context = { settingsOpen: true, settingsBusy: false, settingsStatus: '', settingsError: '', settingsSuccess: '', aiSettings, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), ...overrides };
  vm.createContext(context);
  vm.runInContext(functionSource('settingsHeader', '    function preferencesDialog('), context);
  vm.runInContext(functionSource('aiSettingsDialog', '    function invoiceNumberControl('), context);
  return context.aiSettingsDialog();
}
// Execute production settings functions and event routing; native commands are mocked.
// These tests do not claim a live OpenAI or Anthropic request.
function controller(aiSettings = settings()) {
  const calls = [], notices = [], listeners = {};
  const field = { value: '', focus() {} };
  const context = {
    settingsOpen: false, settingsBusy: false, settingsStatus: '', settingsError: '', settingsSuccess: '', aiSettings,
    state: {}, busy: false, rowMotionPending:false, mailOpen: false, voiceSession: null, voiceRetryBusy: false, lineAssist: null,
    renders: 0, confirm: () => true, errorText: error => error.message || String(error),
    render: () => context.renders++, notice: message => notices.push(message),
    runCommand: async (name, args) => { calls.push({ name, args }); return await context.respond(name, args); },
    respond: () => context.aiSettings,
    document: {
      getElementById: id => id === 'ai-key' ? field : null,
      querySelector: () => null,
      addEventListener: (name, listener) => listeners[name] = listener
    }
  };
  vm.createContext(context);
  vm.runInContext(functionSource('openAiSettings', '    const queueVoiceWork'), context);
  const start = source.indexOf("    document.addEventListener('click', async event => {");
  const end = source.indexOf("    document.addEventListener('input', event => {", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const click = attribute => listeners.click({ target: { dataset: {}, closest: () => ({ dataset: {}, hasAttribute: name => name === attribute }) } });
  return { context, calls, notices, field, click };
}

test('settings offer exactly ChatGPT and Claude, each with a private API key field', () => {
  for (const provider of ['openai', 'claude']) {
    const html = dialog(settings(provider, { openaiConfigured: true, claudeConfigured: true, key: 'synthetic-do-not-render' }));
    assert.match(html, /type="password"/);
    assert.match(html, new RegExp(`value="${provider}" checked`));
    assert.match(html, /data-save-ai-key/);
    assert.match(html, /Enregistrer et tester/);
    assert.match(html, /data-test-ai/);
    assert.ok(!html.includes('synthetic-do-not-render'));
    assert.deepEqual([...html.matchAll(/name="ai-provider" value="([^"]+)"/g)].map(match => match[1]), ['openai', 'claude']);
  }
});

test('no login, subscription, workspace-token or Codex wording remains in settings', () => {
  for (const html of [dialog(settings('openai')), dialog(settings('claude', { claudeConfigured: true }))]) {
    assert.doesNotMatch(html, /abonnement|Business|Codex|Se connecter|data-start-chatgpt-login|data-disconnect|Actualiser la connexion|Z\.ai/i);
  }
  assert.doesNotMatch(source, /start_chatgpt_login|open_chatgpt_login|cancel_chatgpt_login|disconnect_chatgpt/);
});

test('an unconfigured provider has no test or delete button; a configured one does', () => {
  const empty = dialog(settings('claude'));
  assert.match(empty, /Aucune clé/);
  assert.doesNotMatch(empty, /data-test-ai|data-remove-ai-key/);
  const ready = dialog(settings('claude', { claudeConfigured: true }));
  assert.match(ready, /Clé enregistrée/);
  assert.match(ready, /data-test-ai/);
  assert.match(ready, /data-remove-ai-key/);
  assert.match(ready, /Remplacer la clé API Claude/);
  // The other provider's saved key does not make this one look configured.
  assert.match(dialog(settings('openai', { claudeConfigured: true })), /Aucune clé/);
});

test('opening settings and choosing a provider never contact a service', async () => {
  const probe = controller(settings('openai'));
  await probe.context.openAiSettings();
  assert.deepEqual(probe.calls.map(call => call.name), ['get_ai_settings']);
  probe.context.respond = (name, args) => settings(args.provider);
  await probe.context.changeAiProvider('claude');
  assert.deepEqual(probe.calls.map(call => call.name), ['get_ai_settings', 'set_ai_provider']);
  assert.equal(probe.calls[1].args.provider, 'claude');
  await probe.context.changeAiProvider('chatgpt');
  await probe.context.changeAiProvider('business');
  assert.equal(probe.calls.length, 2);
});

test('saving a key stores it for the selected provider, tests it at once and clears the field', async () => {
  for (const provider of ['openai', 'claude']) {
    const probe = controller(settings(provider));
    probe.field.value = '  synthetic-key  ';
    const seen = [];
    probe.context.respond = name => {
      seen.push([name, probe.context.settingsStatus]);
      return name === 'set_ai_key' ? settings(provider, { [`${provider}Configured`]: true }) : 'Connexion vérifiée';
    };
    await probe.click('data-save-ai-key');
    assert.deepEqual(JSON.parse(JSON.stringify(probe.calls)), [{ name: 'set_ai_key', args: { provider, key: 'synthetic-key' } }, { name: 'test_ai_connection' }]);
    assert.match(seen[0][1], /Enregistrement de la clé/);
    assert.match(seen[1][1], /Test en cours/);
    assert.equal(probe.context.aiSettings[`${provider}Configured`], true);
    assert.equal(probe.context.settingsSuccess, 'Connexion vérifiée');
    assert.equal(probe.context.settingsStatus, '');
    assert.equal(probe.field.value, '', 'the pasted key never stays in the field');
    assert.equal(probe.context.settingsBusy, false);
  }
});

test('switching service clears a pasted key so it cannot look like the other service key', async () => {
  const probe = controller(settings('claude', { claudeConfigured: true }));
  probe.field.value = 'synthetic-claude-key';
  probe.context.respond = (name, args) => settings(args.provider, { claudeConfigured: true });
  await probe.context.changeAiProvider('openai');
  assert.equal(probe.field.value, '');
  assert.equal(probe.context.aiSettings.provider, 'openai');
});

test('an empty key is rejected locally, naming the selected service', async () => {
  const probe = controller(settings('claude'));
  probe.field.value = '   ';
  await probe.click('data-save-ai-key');
  assert.equal(probe.calls.length, 0);
  assert.match(probe.context.settingsError, /clé API Claude/);
  assert.equal(probe.context.settingsBusy, false);
});

test('removing a key needs confirmation and a failed save keeps actionable feedback', async () => {
  const probe = controller(settings('openai', { openaiConfigured: true }));
  probe.context.confirm = () => false;
  await probe.click('data-remove-ai-key');
  assert.equal(probe.calls.length, 0);
  probe.context.confirm = () => true;
  probe.context.respond = () => settings('openai');
  await probe.click('data-remove-ai-key');
  assert.deepEqual(JSON.parse(JSON.stringify(probe.calls)), [{ name: 'set_ai_key', args: { provider: 'openai', key: null } }]);
  assert.match(probe.notices[0], /Clé supprimée/);
  probe.field.value = 'synthetic-key';
  probe.context.respond = () => { throw new Error('coffre Windows indisponible'); };
  await probe.click('data-save-ai-key');
  assert.match(probe.context.settingsError, /Enregistrement indisponible : coffre Windows indisponible/);
  assert.equal(probe.context.settingsBusy, false);
});

test('AI readiness follows the selected provider key only', async () => {
  for (const [provider, field, other] of [['openai', 'openaiConfigured', 'claudeConfigured'], ['claude', 'claudeConfigured', 'openaiConfigured']]) {
    const ready = controller(settings(provider, { [field]: true }));
    assert.equal(await ready.context.aiReady(), true);
    assert.equal(ready.notices.length, 0);
    const missing = controller(settings(provider, { [other]: true }));
    assert.equal(await missing.context.aiReady(), false);
    assert.match(missing.notices[0], provider === 'claude' ? /clé API Claude/ : /clé API ChatGPT/);
    assert.equal(missing.context.settingsOpen, true);
  }
});

test('testing with a pasted key saves it first; testing a saved key only tests', async () => {
  const probe = controller(settings('claude', { claudeConfigured: true }));
  probe.field.value = 'synthetic-new-key';
  probe.context.respond = name => name === 'set_ai_key' ? settings('claude', { claudeConfigured: true }) : 'verified';
  await probe.click('data-test-ai');
  assert.deepEqual(probe.calls.map(call => call.name), ['set_ai_key', 'test_ai_connection']);
  assert.equal(probe.calls[0].args.key, 'synthetic-new-key');
  assert.equal(probe.field.value, '');
  probe.calls.length = 0;
  await probe.click('data-test-ai');
  assert.deepEqual(probe.calls.map(call => call.name), ['test_ai_connection']);
  assert.equal(probe.context.settingsSuccess, 'verified');
  assert.equal(probe.context.settingsError, '');
  assert.equal(probe.context.settingsBusy, false);
});

test('the test shows progress while running and clears it afterwards', async () => {
  const probe = controller(settings('openai', { openaiConfigured: true }));
  let during = '';
  probe.context.respond = () => { during = probe.context.settingsStatus; return 'ok'; };
  await probe.click('data-test-ai');
  assert.match(during, /Test en cours/);
  assert.equal(probe.context.settingsStatus, '');
  const running = dialog(settings('openai', { openaiConfigured: true }), { settingsBusy: true, settingsStatus: 'Test en cours : <x>' });
  assert.match(running, /class="ai-status" role="status"><span class="ai-spinner"/);
  assert.match(running, /Test en cours : &lt;x&gt;/);
  assert.doesNotMatch(dialog(settings('openai', { openaiConfigured: true })), /ai-status/);
});

test('successful connection feedback is escaped and styled separately from red errors', async () => {
  const probe = controller(settings('openai', { openaiConfigured: true }));
  probe.context.settingsError = 'old failure';
  probe.context.respond = () => 'Connexion vérifiée <synthetic>';
  await probe.click('data-test-ai');
  const visible = dialog(probe.context.aiSettings, { settingsSuccess: probe.context.settingsSuccess });
  assert.match(visible, /class="ai-result ok" role="status">Connexion vérifiée &lt;synthetic&gt;/);
  assert.doesNotMatch(visible, /ai-result error/);
  assert.match(await readFile(new URL('../web/cleanup.css', import.meta.url), 'utf8'), /\.ai-result\.ok\s*\{[^}]*color:\s*var\(--accent\)/);
  probe.context.respond = () => { throw new Error('synthetic connection failure <b>'); };
  await probe.click('data-test-ai');
  assert.equal(probe.context.settingsSuccess, '');
  assert.match(probe.context.settingsError, /Connexion non vérifiée : synthetic connection failure/);
  const failure = dialog(probe.context.aiSettings, { settingsError: probe.context.settingsError });
  assert.match(failure, /class="ai-result error" role="alert"/);
  assert.match(failure, /&lt;b&gt;/);
  assert.doesNotMatch(failure, /ai-result ok/);
});

test('busy settings ignore overlapping actions', async () => {
  const probe = controller(settings('openai', { openaiConfigured: true }));
  probe.context.settingsBusy = true;
  probe.field.value = 'synthetic-key';
  for (const attribute of ['data-save-ai-key', 'data-remove-ai-key', 'data-test-ai']) await probe.click(attribute);
  await probe.context.changeAiProvider('claude');
  assert.equal(probe.calls.length, 0);
  const html = dialog(settings('openai', { openaiConfigured: true }), { settingsBusy: true });
  assert.match(html, /data-save-ai-key disabled/);
});

test('project is entered after client in the editor, and validation lists client first', () => {
  const fields = source.indexOf("${input('client'");
  assert.ok(fields > 0 && fields < source.indexOf("${input('project'"));
  assert.ok(source.indexOf("add('[data-field=\"client\"]'") < source.indexOf("add('[data-field=\"project\"]'"));
});
