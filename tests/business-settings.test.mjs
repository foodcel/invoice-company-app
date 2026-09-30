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
function settings(provider = 'chatgpt', overrides = {}) {
  return { provider, chatgptConfigured: false, businessConfigured: false, authPending: false, ...overrides };
}
function dialog(aiSettings, overrides = {}) {
  const context = { settingsOpen: true, settingsBusy: false, settingsError: '', settingsSuccess: '', aiSettings, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), ...overrides };
  vm.createContext(context);
  vm.runInContext(functionSource('aiSettingsDialog', '    function invoiceNumberControl('), context);
  return context.aiSettingsDialog();
}
// Execute production settings functions and event routing; native commands are mocked.
// These tests do not claim a real subscription login or native WebView acceptance.
function controller(aiSettings = settings()) {
  const calls = [], notices = [], listeners = {};
  const field = { value: '', focus() {} };
  const context = {
    settingsOpen: false, settingsBusy: false, settingsError: '', settingsSuccess: '', aiSettings,
    state: {}, busy: false, mailOpen: false, voiceSession: null, voiceRetryBusy: false, lineAssist: null,
    renders: 0, confirm: () => true, errorText: error => error.message || String(error),
    render: () => context.renders++, notice: message => notices.push(message),
    runCommand: async (name, args) => { calls.push({ name, args }); return await context.respond(name, args); },
    respond: () => context.aiSettings,
    document: {
      getElementById: id => id === 'ai-key' && context.aiSettings?.provider === 'business' ? field : null,
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

test('Business settings show only subscription providers and a private workspace token field', () => {
  const html = dialog(settings('business', { businessConfigured: true, token: 'synthetic-do-not-render' }));
  assert.match(html, /type="password"/);
  assert.match(html, /value="business" checked/);
  assert.match(html, /data-test-ai/);
  assert.match(html, /Enregistrer le jeton/);
  assert.ok(!html.includes('synthetic-do-not-render'));
  assert.deepEqual([...html.matchAll(/name="ai-provider" value="([^"]+)"/g)].map(match => match[1]), ['chatgpt', 'business']);
  assert.doesNotMatch(html, /OpenAI API|clé API|data-start-chatgpt-login/);
  assert.match(html, /<p class="settings-note">Z\.ai et Claude : connexion par abonnement non disponible dans cette version\.<\/p>/);
});
test('ChatGPT settings expose sign-in without any credential field or unsupported login', () => {
  const html = dialog(settings());
  assert.match(html, /value="chatgpt" checked/);
  assert.match(html, /abonnement Pro \/ personnel/);
  assert.match(html, /data-start-chatgpt-login[^>]*>Se connecter à ChatGPT<\/button>/);
  assert.doesNotMatch(html, /ai-key|type="password"|data-save-ai-key|data-remove-ai-key|data-test-ai|data-disconnect-chatgpt|data-cancel-chatgpt-login|data-refresh-ai-settings/);
  assert.doesNotMatch(html, /value="(?:openai|zai|claude)"|<a\b|clé d’API|OpenAI API/);
});
test('pending and connected ChatGPT states expose the correct controls', () => {
  const pending = dialog(settings('chatgpt', { authPending: true }));
  assert.match(pending, /data-start-chatgpt-login disabled/);
  assert.match(pending, /data-cancel-chatgpt-login/);
  assert.match(pending, /data-refresh-ai-settings[^>]*>Actualiser la connexion<\/button>/);
  assert.doesNotMatch(pending, /data-disconnect-chatgpt|data-test-ai/);
  const connected = dialog(settings('chatgpt', { chatgptConfigured: true }));
  assert.match(connected, /data-disconnect-chatgpt/);
  assert.match(connected, /data-test-ai/);
  assert.doesNotMatch(connected, /data-cancel-chatgpt-login|data-refresh-ai-settings/);
  const busy = dialog(settings('chatgpt', { authPending: true, chatgptConfigured: true }), { settingsBusy: true });
  for (const match of busy.matchAll(/<(?:button|input)\b[^>]*>/g)) assert.match(match[0], /disabled/);
});
test('opening settings and choosing ChatGPT never start a login automatically', async () => {
  const probe = controller(settings('business'));
  probe.context.respond = (name, args) => name === 'set_ai_provider' ? settings(args.provider) : settings('business');
  await probe.click('data-ai-settings');
  assert.equal(probe.context.settingsOpen, true);
  await probe.context.changeAiProvider('chatgpt');
  assert.deepEqual(probe.calls.map(call => call.name), ['get_ai_settings', 'set_ai_provider']);
  assert.equal(probe.calls[1].args.provider, 'chatgpt');
  assert.equal(probe.context.aiSettings.provider, 'chatgpt');
  for (const provider of ['openai', 'zai', 'claude', 'unknown']) await probe.context.changeAiProvider(provider);
  assert.equal(probe.calls.length, 2);
});
test('explicit ChatGPT login adopts returned settings and opens the browser through a native opaque attempt', async () => {
  const probe = controller();
  const pending = settings('chatgpt', { authPending: true });
  const attemptId = 'synthetic-attempt';
  probe.context.respond = name => {
    assert.equal(probe.context.settingsBusy, true);
    if (name === 'start_chatgpt_login') return { settings: pending, attemptId };
    assert.equal(name, 'open_chatgpt_login');
    assert.equal(probe.context.aiSettings, pending, 'pending state is adopted before opening the browser');
  };
  await probe.click('data-start-chatgpt-login');
  assert.deepEqual(probe.calls.map(call => call.name), ['start_chatgpt_login', 'open_chatgpt_login']);
  assert.equal(probe.calls[1].args.attempt, attemptId);
  assert.equal(probe.context.aiSettings, pending);
  assert.equal(probe.context.settingsBusy, false);
  assert.equal(probe.context.settingsError, '');
  await probe.context.startChatgptLogin();
  assert.equal(probe.calls.length, 2, 'a pending login cannot be started twice');
});
test('a login result without an attempt ID does not open a browser', async () => {
  const probe = controller();
  const connected = settings('chatgpt', { chatgptConfigured: true });
  probe.context.respond = () => ({ settings: connected, attemptId: null });
  await probe.context.startChatgptLogin();
  assert.deepEqual(probe.calls.map(call => call.name), ['start_chatgpt_login']);
  assert.equal(probe.context.aiSettings, connected);
});
test('refresh, cancellation and disconnect adopt native settings results through production clicks', async () => {
  const probe = controller(settings('chatgpt', { authPending: true }));
  const connected = settings('chatgpt', { chatgptConfigured: true });
  probe.context.respond = () => connected;
  await probe.click('data-refresh-ai-settings');
  assert.equal(probe.context.aiSettings, connected);
  const disconnected = settings();
  probe.context.respond = () => disconnected;
  await probe.click('data-disconnect-chatgpt');
  assert.equal(probe.context.aiSettings, disconnected);
  probe.context.aiSettings = settings('chatgpt', { authPending: true });
  await probe.click('data-cancel-chatgpt-login');
  assert.equal(probe.context.aiSettings, disconnected);
  assert.deepEqual(probe.calls.map(call => call.name), ['get_ai_settings', 'disconnect_chatgpt', 'cancel_chatgpt_login']);
  assert.equal(probe.context.settingsBusy, false);
});
test('login failures and a rejected native URL open recover without losing pending state', async () => {
  for (const failingCommand of ['start_chatgpt_login', 'open_chatgpt_login']) {
    const probe = controller();
    probe.context.settingsSuccess = 'old success';
    probe.context.respond = name => {
      if (name === failingCommand) throw new Error('synthetic rejection');
      return { settings: settings('chatgpt', { authPending: true }), attemptId: 'https://invalid.example/synthetic' };
    };
    await probe.click('data-start-chatgpt-login');
    assert.match(probe.context.settingsError, /synthetic rejection/);
    assert.equal(probe.context.settingsSuccess, '');
    assert.equal(probe.context.settingsBusy, false);
    assert.equal(probe.context.aiSettings.authPending, failingCommand === 'open_chatgpt_login');
    assert.equal(probe.calls.length, failingCommand === 'start_chatgpt_login' ? 1 : 2);
  }
});
test('refresh, cancellation, disconnect and provider failures preserve settings and release busy state', async () => {
  for (const action of ['refreshAiSettings', 'cancelChatgptLogin', 'disconnectChatgpt', 'changeAiProvider']) {
    const initial = settings('chatgpt', { authPending: true, chatgptConfigured: true });
    const probe = controller(initial);
    probe.context.settingsSuccess = 'old success';
    probe.context.respond = () => { throw new Error('synthetic failure'); };
    await probe.context[action]('business');
    assert.equal(probe.context.aiSettings, initial);
    assert.match(probe.context.settingsError, /synthetic failure/);
    assert.equal(probe.context.settingsSuccess, '');
    assert.equal(probe.context.settingsBusy, false);
    assert.equal(probe.calls.length, 1);
  }
});
test('Business readiness requires its own credential, not a ChatGPT subscription', async () => {
  const probe = controller();
  let opened = 0;
  probe.context.openAiSettings = async () => opened++;
  probe.context.respond = () => settings('business', { chatgptConfigured: true });
  assert.equal(await probe.context.aiReady(), false);
  assert.equal(opened, 1);
  probe.context.respond = () => settings('business', { businessConfigured: true });
  assert.equal(await probe.context.aiReady(), true);
  assert.equal(opened, 1);
});
test('ChatGPT readiness requires its own subscription credential and rejects legacy providers', async () => {
  const probe = controller();
  let opened = 0;
  probe.context.openAiSettings = async () => opened++;
  probe.context.respond = () => settings('chatgpt', { businessConfigured: true, authPending: true });
  assert.equal(await probe.context.aiReady(), false);
  probe.context.respond = () => settings('chatgpt', { chatgptConfigured: true });
  assert.equal(await probe.context.aiReady(), true);
  for (const provider of ['openai', 'zai', 'unknown']) {
    probe.context.respond = () => settings(provider, { chatgptConfigured: true, businessConfigured: true, openaiConfigured: true, zaiConfigured: true });
    assert.equal(await probe.context.aiReady(), false);
  }
  assert.equal(opened, 4);
});
test('only Business can save or remove a token, and saved credentials are never rendered', async () => {
  const probe = controller(settings('business'));
  probe.field.value = '  synthetic-business-token  ';
  const saved = settings('business', { businessConfigured: true });
  probe.context.respond = () => saved;
  await probe.click('data-save-ai-key');
  assert.equal(probe.calls[0].name, 'set_ai_key');
  assert.equal(probe.calls[0].args.provider, 'business');
  assert.equal(probe.calls[0].args.key, 'synthetic-business-token');
  assert.equal(probe.context.aiSettings, saved);
  assert.doesNotMatch(dialog(probe.context.aiSettings), /synthetic-business-token/);
  probe.context.respond = () => settings('business');
  await probe.click('data-remove-ai-key');
  assert.equal(probe.calls[1].args.key, null);
  assert.equal(probe.calls[1].args.provider, 'business');
  for (const provider of ['chatgpt', 'openai', 'zai']) {
    probe.context.aiSettings = settings(provider);
    await probe.context.saveAiKey();
    await probe.context.saveAiKey(true);
  }
  assert.equal(probe.calls.length, 2);
});
test('empty, unconfirmed or failed Business token changes keep actionable feedback', async () => {
  const probe = controller(settings('business'));
  await probe.context.saveAiKey();
  assert.equal(probe.calls.length, 0);
  assert.match(probe.context.settingsError, /Entrez le jeton Business/);
  probe.context.confirm = () => false;
  await probe.context.saveAiKey(true);
  assert.equal(probe.calls.length, 0);
  probe.field.value = 'synthetic-replacement';
  probe.context.respond = () => { throw new Error('synthetic storage failure'); };
  await probe.context.saveAiKey();
  assert.match(probe.context.settingsError, /synthetic storage failure/);
  assert.equal(probe.context.settingsBusy, false);
});
test('connection test preserves an unsaved replacement and never tests the previous credential', async () => {
  const probe = controller(settings('business', { businessConfigured: true }));
  probe.field.value = 'synthetic-unsaved-replacement';
  probe.context.respond = () => 'verified';
  await probe.click('data-test-ai');
  assert.equal(probe.calls.length, 0); assert.equal(probe.context.renders, 0); assert.equal(probe.notices.length, 1);
  assert.equal(probe.field.value, 'synthetic-unsaved-replacement');
  probe.field.value = '';
  await probe.click('data-test-ai');
  assert.equal(probe.calls.length, 1); assert.equal(probe.calls[0].name, 'test_ai_connection');
  assert.equal(probe.context.settingsSuccess, 'verified');
  assert.equal(probe.context.settingsError, '');
  assert.equal(probe.context.settingsBusy, false);
});
test('successful connection feedback is escaped and styled separately from red errors', async () => {
  const probe = controller(settings('chatgpt', { chatgptConfigured: true }));
  probe.context.settingsError = 'old failure';
  probe.context.respond = () => 'Connexion vérifiée <synthetic>';
  await probe.click('data-test-ai');
  const visible = dialog(probe.context.aiSettings, { settingsSuccess: probe.context.settingsSuccess });
  assert.match(visible, /class="settings-success" role="status">Connexion vérifiée &lt;synthetic&gt;/);
  assert.doesNotMatch(visible, /class="translation-error"/);
  assert.match(styles, /\.settings-success\s*\{[^}]*color:\s*var\(--accent\)/);
  probe.context.respond = () => { throw new Error('synthetic connection failure'); };
  await probe.click('data-test-ai');
  assert.equal(probe.context.settingsSuccess, '');
  assert.match(probe.context.settingsError, /Connexion non vérifiée : synthetic connection failure/);
  const failure = dialog(probe.context.aiSettings, { settingsError: probe.context.settingsError });
  assert.match(failure, /class="translation-error"/);
  assert.doesNotMatch(failure, /class="settings-success"/);
});
test('busy settings ignore overlapping actions', async () => {
  const probe = controller(settings('chatgpt', { authPending: true, chatgptConfigured: true }));
  probe.context.settingsBusy = true;
  for (const action of ['startChatgptLogin', 'refreshAiSettings', 'cancelChatgptLogin', 'disconnectChatgpt', 'testAiConnection', 'saveAiKey', 'changeAiProvider']) {
    await probe.context[action]('business');
  }
  assert.equal(probe.calls.length, 0);
  assert.equal(probe.context.renders, 0);
});

 test('native authorization errors are visible and escaped when refreshing settings', () => {
  const html = dialog(settings('chatgpt', { authError: 'Subscription denied <unsafe>' }));
  assert.match(html, /Subscription denied &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
});
