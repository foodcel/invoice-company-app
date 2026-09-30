// Standalone overlay: the document editor may rerender during PDF export.
// Import email-composer.css from the host entry point.
const remembered = new Map();
let active = null;
const text = value => typeof value === 'string' ? value : '';
const byteLength = value => new TextEncoder().encode(value).length;
const invalidControls = value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
const errorText = error => String(error?.message || error || 'Erreur inconnue');
export const DEFAULT_SIGNATURE = 'Ébénisterie de l’Hermitage inc.\n(819) 428-7690 · Ripon, Québec';

export function validEmail(value) {
  const email = text(value).trim();
  if (email.length > 254 || /[\s\r\n]/.test(email)) return false;
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || !parts[0] || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
  const tld = parts[1].split('.').at(-1);
  return tld.length >= 2 && /[A-Za-z]/.test(tld) && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) &&
    parts[1].split('.').length >= 2 && parts[1].split('.').every(label =>
      label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function initialEmailDraft(draft, language = 'fr', settings = {}) {
  const invoice = draft.kind === 'facture';
  const en = language === 'en';
  const title = invoice ? (en ? 'Invoice' : 'Facture') : (en ? 'Quote' : 'Soumission');
  const number = invoice && draft.invoiceNumber ? ` n° ${draft.invoiceNumber}` : '';
  return {
    to: text(draft.email).trim() ? [text(draft.email)] : [],
    cc: invoice && text(settings.accountantEmail).trim() ? [settings.accountantEmail] : [],
    subject: `${title}${number}${draft.project ? ` — ${draft.project}` : ''}`,
    body: en ? `Hello${draft.client ? ` ${draft.client}` : ''},\n\nPlease find your ${invoice ? 'invoice' : 'quote'} attached.\nPlease contact us if you have any questions.\n\nHave a good day!` :
      `Bonjour${draft.client ? ` ${draft.client}` : ''},\n\nVous trouverez ${invoice ? 'la facture' : 'la soumission'} en pièce jointe.\nN’hésitez pas à me contacter pour toute question.\n\nBonne journée !`,
    ccTouched: false, undo: [], attachment: null, pdfStatus: 'pending', sendState: 'idle', attemptId: null,
  };
}

export function messageIssues(model, connected, signature = '') {
  const issues = [];
  const seen = new Set();
  if (!Array.isArray(model.to) || !model.to.length) issues.push({ field: 'to', message: 'Ajoutez au moins un destinataire.' });
  for (const field of ['to', 'cc']) {
    if (!Array.isArray(model[field])) { issues.push({ field, message: 'Liste de destinataires invalide.' }); continue; }
    model[field].forEach((email, index) => {
      if (!validEmail(email)) issues.push({ field, index, message: `Vérifiez l’adresse ${field === 'to' ? 'du destinataire' : 'en copie'} ${index + 1}, ou retirez-la.` });
      else if (seen.has(email.trim().toLowerCase())) issues.push({ field, index, message: 'Une adresse est présente plusieurs fois dans À ou CC.' });
      else seen.add(email.trim().toLowerCase());
    });
  }
  if ((model.to?.length || 0) + (model.cc?.length || 0) > 100) issues.push({ field: 'to', message: 'Maximum de 100 destinataires.' });
  if (!text(model.subject).trim() || byteLength(model.subject) > 998 || /[\u0000-\u001f\u007f-\u009f]/.test(model.subject)) issues.push({ field: 'subject', message: 'Ajoutez un objet valide (998 octets maximum, une seule ligne).' });
  if (!text(model.body).trim() || byteLength(fullBody(model.body, signature)) > 100000 || invalidControls(fullBody(model.body, signature))) issues.push({ field: 'body', message: 'Ajoutez un message valide (100 000 octets maximum, signature comprise).' });
  if (!connected) issues.push({ field: 'account', message: 'Connectez votre compte Outlook dans les réglages.' });
  return issues;
}

export function fullBody(body, signature) {
  return `${text(body).trim()}${text(signature).trim() ? `\n\n${signature.trim()}` : ''}`;
}

export function applyRewrite(model, result) {
  if (!result || typeof result.body !== 'string' || typeof result.subject !== 'string' || !result.body.trim() || !result.subject.trim()) throw new Error('Réponse IA invalide. Votre texte a été conservé.');
  const next = { ...model, body: result.body, subject: result.subject };
  const issues = messageIssues({ ...next, to: ['validation@example.test'], cc: [] }, true);
  if (issues.length) throw new Error(issues[0].message);
  model.undo.push({ body: model.body, subject: model.subject });
  if (model.undo.length > 20) model.undo.shift();
  model.body = result.body;
  model.subject = result.subject;
}

export function undoRewrite(model) {
  const previous = model.undo.pop();
  if (!previous) return false;
  Object.assign(model, previous);
  return true;
}

export function attachmentMetadata(value) {
  if (!value || !text(value.path).trim() || !text(value.draftId).trim() || !text(value.filename).trim() ||
      !/\.pdf$/i.test(value.filename) || byteLength(value.filename) > 180 || /[<>:"\\/|?*\u0000-\u001f\u007f-\u009f]/.test(value.filename) || value.filename.endsWith(' ') || /[\r\n\0]/.test(value.path)) {
    throw new Error('Le PDF enregistré n’a pas retourné des informations valides.');
  }
  return Object.freeze({ path: value.path, filename: value.filename, draftId: value.draftId });
}

export function pdfPreviewBlob(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 ||
      String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('L’aperçu n’a pas retourné un PDF valide.');
  return new Blob([bytes.slice()], { type: 'application/pdf' });
}

// Uses injected transport only. A submitted attempt is never retried automatically,
// even if the native transport rejects without a conclusive provider receipt.
export function createSendFlow({ model, getSettings, invoke, preparePdf, newAttemptId, onPdfSaved }) {
  let inFlight = null;
  return {
    send() {
      if (inFlight) return inFlight;
      if (model.sendState !== 'idle') return Promise.reject(new Error('Cet envoi a déjà été soumis. Vérifiez Outlook avant tout nouvel envoi.'));
      const settings = getSettings();
      const issues = messageIssues(model, settings.connected, settings.signature);
      if (issues.length) return Promise.reject(Object.assign(new Error(issues[0].message), { issues }));
      // Snapshot before export can rerender/mutate the host's invoice state.
      const request = Object.freeze({
        attemptId: newAttemptId(), to: Object.freeze(model.to.map(email => email.trim())),
        cc: Object.freeze(model.cc.map(email => email.trim())), subject: model.subject.trim(), body: fullBody(model.body, settings.signature),
      });
      model.attemptId = request.attemptId;
      model.sendState = 'preparing';
      model.pdfStatus = model.attachment ? 'saved' : 'preparing';
      inFlight = (async () => {
        try {
          model.attachment = attachmentMetadata(await Promise.resolve().then(preparePdf));
          model.pdfStatus = 'saved';
          onPdfSaved?.(model.attachment);
          model.sendState = 'sending';
          const receipt = await invoke('send_outlook_mail', {
            draftId: model.attachment.draftId, path: model.attachment.path, request,
          });
          if (!receipt || receipt.attemptId !== request.attemptId || !text(receipt.senderEmail) || !text(receipt.acceptedAt)) throw new Error('Confirmation Outlook invalide.');
          model.sendState = 'accepted';
          return receipt;
        } catch (error) {
          if (model.sendState === 'sending') model.sendState = 'uncertain';
          else { model.sendState = 'idle'; model.pdfStatus = model.attachment ? 'saved' : 'failed'; }
          throw error;
        } finally { inFlight = null; }
      })();
      return inFlight;
    },
  };
}

export function prepareAnotherSend(model, confirmed = false) {
  if (!confirmed || !['accepted', 'uncertain'].includes(model.sendState)) return false;
  Object.assign(model, { sendState: 'idle', attemptId: null, attachment: null, pdfStatus: 'pending' });
  return true;
}

export function mailSettingsPayload(values) {
  const clientId = text(values.clientId).trim();
  const accountantEmail = text(values.accountantEmail).trim();
  if (clientId && !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(clientId)) throw new Error('L’identifiant de l’application doit être un GUID valide.');
  if (accountantEmail && !validEmail(accountantEmail)) throw new Error('Vérifiez le courriel du comptable.');
  if (typeof values.signature !== 'string' || byteLength(values.signature) > 16000 || invalidControls(values.signature)) throw new Error('Signature invalide (16 000 octets maximum).');
  return { clientId, accountantEmail, signature: values.signature };
}

const icons = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="m9 5-6 6 6 6M3 11h12a6 6 0 0 1 6 6"/>',
  ai: '<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3zM20 2v4M18 4h4"/>',
  send: '<path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  settings: '<path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 2 3 3 3-2 3 1 1 2 4-1v-3l2-2 3-1-1-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
};
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = icons[name]; // Static paths only; all external text uses textContent/value.
  return node;
}
function button(label, action, symbol, mini = false) {
  const node = el('button', mini ? 'em-icon' : 'em-button');
  node.type = 'button';
  node.setAttribute('aria-label', label);
  if (symbol) node.append(icon(symbol));
  if (mini) { node.title = label; node.dataset.tooltip = label; }
  else node.append(document.createTextNode(label));
  node.addEventListener('click', action);
  return node;
}
function labelledField(label, kind = 'input') {
  const wrapper = el('label', 'em-field', label);
  const input = el(kind);
  wrapper.append(input);
  return { wrapper, input };
}
function checkOptions(options, composer = false) {
  if (typeof options?.invoke !== 'function') throw new TypeError('invoke est requis.');
  if (composer && (!text(options.draft?.id) || typeof options.preparePdf !== 'function')) throw new TypeError('draft.id et preparePdf sont requis.');
}

function overlay() {
  const opener = document.activeElement;
  const root = el('div', 'email-overlay');
  // Host document event delegation must not interpret modal edits as invoice edits.
  for (const name of ['click', 'dblclick', 'input', 'change', 'keydown', 'keyup', 'keypress', 'submit', 'pointerdown', 'pointerup']) {
    root.addEventListener(name, event => event.stopPropagation());
  }
  document.body.append(root);
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const inertBefore = new Map();
  const protect = () => {
    for (const node of document.body.children) {
      if (node !== root && !['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName)) {
        if (!inertBefore.has(node)) inertBefore.set(node, node.inert);
        node.inert = true;
      }
    }
    const app = document.querySelector('.app');
    const dark = app ? app.classList.contains('dark') : document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
    root.classList.toggle('em-dark', dark);
    if (app) {
      const computed = getComputedStyle(app);
      for (const name of ['surface', 'panel', 'bg', 'ink', 'muted', 'border', 'accent', 'accent-ink', 'soft']) {
        const value = computed.getPropertyValue(`--${name}`).trim();
        if (value) root.style.setProperty(`--em-${name}`, value);
      }
    }
  };
  protect();
  const observer = new MutationObserver(protect);
  observer.observe(document.body, { childList: true });
  const app = document.querySelector('.app');
  if (app) observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  let scope = null, escape = () => {};
  const focusables = () => [...scope.querySelectorAll('button,input,textarea,a[href],summary,[tabindex="0"]')]
    .filter(node => !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length);
  const focusInside = () => (focusables()[0] || scope).focus({ preventScroll: true });
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); escape(); }
    if (event.key === 'Tab') {
      const nodes = focusables(), first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); scope.focus(); }
      else if (!scope.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
  };
  const focusin = event => { if (scope && !scope.contains(event.target)) focusInside(); };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('focusin', focusin, true);
  return {
    root,
    setScope(node, onEscape) { scope = node; escape = onEscape; focusInside(); },
    focus: focusInside,
    destroy() {
      observer.disconnect();
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin, true);
      root.remove();
      for (const [node, inert] of inertBefore) node.inert = inert;
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
  };
}

function dialog(title, className) {
  const panel = el('section', `em-dialog ${className}`);
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  return panel;
}

function settingsPanel({ host, invoke, initial, onSettings, onClose }) {
  const panel = dialog('Réglages · Courriel', 'em-settings');
  const layer = el('div', 'em-layer'); layer.append(panel); host.root.append(layer);
  let closed = false, busy = false, settings = initial, timer = null, polling = false, loginRunning = false;
  const head = el('header', 'em-head');
  head.append(el('h2', '', 'Réglages · Courriel'), button('Fermer les réglages', close, 'close', true));
  const content = el('div', 'em-settings-content');
  const account = el('section', 'em-settings-card');
  const accountAddress = el('strong');
  const accountStatus = el('p', 'em-muted'); accountStatus.setAttribute('role', 'status');
  const accountActions = el('div', 'em-settings-actions');
  const connect = button('Connecter Outlook', login);
  const cancelLogin = button('Annuler la connexion', () => command('cancel_outlook_login'));
  const disconnect = button('Déconnecter', () => command('disconnect_outlook'));
  accountActions.append(connect, cancelLogin, disconnect);
  account.append(el('h3', '', 'Compte d’envoi Outlook'), accountAddress, accountStatus, accountActions);
  const accountant = labelledField('Courriel du comptable'); accountant.input.type = 'email';
  accountant.input.autocomplete = 'email';
  const signature = labelledField('Signature de l’entreprise', 'textarea'); signature.input.rows = 3;
  const advanced = el('details', 'em-advanced');
  const client = labelledField('Identifiant public de l’application Microsoft (GUID)');
  client.input.autocomplete = 'off'; client.input.spellcheck = false;
  advanced.append(el('summary', '', 'Configuration avancée · Propriétaire'),
    el('p', 'em-muted', 'L’application Microsoft doit être configurée pour les comptes personnels et la connexion locale. Aucun secret n’est requis.'), client.wrapper);
  const status = el('p', 'em-status'); status.setAttribute('role', 'alert'); status.hidden = true;
  const footer = el('footer', 'em-footer');
  const save = button('Enregistrer', saveSettings); save.classList.add('em-primary');
  footer.append(button('Annuler', close), save);
  content.append(account, accountant.wrapper, el('p', 'em-muted', 'Ajouté en CC aux factures uniquement. Chaque copie peut être retirée de l’envoi.'), signature.wrapper, advanced, status);
  panel.append(head, content, footer);
  function showError(error) { if (!closed) { status.hidden = false; status.textContent = errorText(error); } }
  function renderAccount() {
    if (closed) return;
    accountAddress.textContent = settings?.connected ? settings.senderEmail : 'Connexion requise';
    const pending = settings?.authPending || loginRunning;
    accountStatus.textContent = pending ? 'Terminez la connexion dans votre navigateur…' : settings?.authError || (settings ? (settings.connected ? 'Envoi depuis votre compte Outlook.' : settings.clientId ? 'Connectez votre compte Microsoft personnel dans le navigateur.' : 'Le propriétaire doit configurer l’application Microsoft avant la connexion.') : 'Chargement des réglages…');
    connect.textContent = settings?.connected ? 'Changer de compte' : 'Connecter Outlook';
    connect.disabled = busy || pending || !settings?.clientId;
    cancelLogin.hidden = !pending; cancelLogin.disabled = busy;
    disconnect.hidden = !settings?.connected; disconnect.disabled = busy || pending;
    save.disabled = busy || pending || !settings;
    for (const input of [accountant.input, signature.input, client.input]) input.disabled = busy || pending || !settings;
    panel.setAttribute('aria-busy', String(busy));
  }
  function accept(value, populate = false) {
    if (closed) return;
    settings = value;
    if (populate) {
      accountant.input.value = text(value.accountantEmail);
      signature.input.value = typeof value.signature === 'string' ? value.signature : DEFAULT_SIGNATURE;
      client.input.value = text(value.clientId);
      advanced.open = false;
    }
    onSettings(value);
    renderAccount();
  }
  async function refresh(populate = false) {
    try { accept(await invoke('get_mail_settings'), populate); }
    catch (error) { showError(error); renderAccount(); }
  }
  function schedulePoll() {
    clearTimeout(timer);
    if (!closed && (settings?.authPending || loginRunning)) timer = setTimeout(poll, 1000);
  }
  async function poll() {
    if (closed || polling) return;
    polling = true;
    await refresh(); polling = false; schedulePoll();
  }
  async function command(name) {
    if (busy || closed) return;
    busy = true; renderAccount();
    try { accept(await invoke(name)); }
    catch (error) { showError(error); }
    finally { busy = false; renderAccount(); schedulePoll(); }
  }
  async function login() {
    if (closed || busy || loginRunning || settings?.authPending || !settings?.clientId) return;
    loginRunning = true; status.hidden = true; renderAccount(); schedulePoll();
    try { accept(await invoke('start_outlook_login')); }
    catch (error) { showError(error); }
    finally { loginRunning = false; if (!closed) { await refresh(); renderAccount(); schedulePoll(); } }
  }
  async function saveSettings() {
    if (busy || loginRunning || settings?.authPending || !settings) return;
    let payload;
    try { payload = mailSettingsPayload({ clientId: client.input.value, accountantEmail: accountant.input.value, signature: signature.input.value }); }
    catch (error) { showError(error); return; }
    busy = true; status.hidden = true; renderAccount();
    try {
      accept(await invoke('save_mail_settings', payload), true);
      busy = false; close(); // One native save contains all settings.
    } catch (error) { busy = false; showError(error); renderAccount(); }
  }
  function close() {
    if (closed || busy) return;
    closed = true; clearTimeout(timer); layer.remove();
    // Closing settings leaves browser authentication pending in the native layer.
    // The owner can reopen or explicitly cancel it; no credentials are requested here.
    onClose();
  }
  const retry = button('Recharger les réglages', () => refresh(!settings));
  content.append(retry);
  if (initial) accept(initial, true);
  renderAccount();
  const ready = refresh(!initial).then(schedulePoll);
  host.setScope(panel, close);
  return { close, focus: () => host.setScope(panel, close), ready };
}

export function openMailSettings({ invoke, onClose } = {}) {
  checkOptions({ invoke });
  if (active) { if (active.settings) return active.settings(); active.focus(); return active; }
  const host = overlay();
  let value = null;
  const controller = { close: () => view.close(), focus: () => view.focus(), snapshot: () => value, ready: null };
  active = controller;
  const view = settingsPanel({ host, invoke, initial: null, onSettings: settings => { value = settings; }, onClose: () => {
    active = null; host.destroy(); onClose?.(value);
  } });
  controller.ready = view.ready;
  return controller;
}

export function openEmailComposer(options) {
  checkOptions(options, true);
  if (active) { active.focus(); return active; }
  const { invoke, draft, preparePdf, rewrite, onClose, onSent } = options;
  const language = options.language === 'en' ? 'en' : 'fr';
  const key = JSON.stringify([draft.id, draft.kind, language]);
  const restored = remembered.has(key);
  const model = structuredClone(remembered.get(key) || initialEmailDraft(draft, language));
  if (model.attachment) model.attachment = attachmentMetadata(model.attachment);
  let settings = { connected: false, signature: DEFAULT_SIGNATURE }, closed = false, sending = false, rewriting = false, nested = null, pollTimer = null;
  const host = overlay();
  const title = draft.kind === 'facture' ? 'Envoyer la facture' : 'Envoyer la soumission';
  const panel = dialog(title, 'em-composer'); host.root.append(panel);
  const head = el('header', 'em-head');
  const mark = el('span', 'em-symbol'); mark.append(icon('mail'));
  const heading = el('div', 'em-heading');
  heading.append(el('h2', '', title), el('p', '', `${draft.client || 'Client'} · ${draft.kind === 'facture' ? `Facture${draft.invoiceNumber ? ` n° ${draft.invoiceNumber}` : ''}` : 'Soumission'}`));
  const sender = el('div', 'em-sender');
  const senderAddress = el('span', 'em-sender-address', 'Chargement du compte…'); senderAddress.setAttribute('role', 'status');
  sender.append(el('span', 'em-outlook', 'O'), senderAddress, button('Réglages du courriel', showSettings, 'settings', true));
  const closeButton = button('Fermer le courriel', close, 'close', true);
  head.append(mark, heading, sender, closeButton);
  const scroll = el('div', 'em-content');
  const routing = el('div', 'em-routing');
  const recipientInputs = { to: [], cc: [] };
  const rows = {};
  for (const field of ['to', 'cc']) {
    const row = el('div', 'em-row'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', field === 'to' ? 'Destinataires' : 'Copies');
    const list = el('div', 'em-recipients');
    const add = button(field === 'to' ? 'Ajouter un destinataire' : 'Ajouter une copie CC', () => {
      if (sending) return;
      model[field].push(''); if (field === 'cc') model.ccTouched = true;
      renderRecipients(field); recipientInputs[field].at(-1).focus();
    }, 'plus', true);
    row.append(el('span', 'em-row-label', field === 'to' ? 'À' : 'CC'), list, add);
    routing.append(row); rows[field] = { list, add };
  }
  function renderRecipients(field) {
    rows[field].list.replaceChildren(); recipientInputs[field] = [];
    model[field].forEach((value, index) => {
      const chip = el('span', 'em-recipient');
      const input = el('input'); input.type = 'email'; input.autocomplete = 'email'; input.spellcheck = false; input.value = value;
      input.setAttribute('aria-label', `${field === 'to' ? 'Courriel du destinataire' : 'Courriel en copie'} ${index + 1}`);
      input.addEventListener('input', () => { model[field][index] = input.value; if (field === 'cc') model.ccTouched = true; input.removeAttribute('aria-invalid'); });
      const remove = button(`${field === 'to' ? 'Retirer le destinataire' : 'Retirer la copie'} ${index + 1}`, () => {
        if (sending) return;
        model[field].splice(index, 1); if (field === 'cc') model.ccTouched = true;
        renderRecipients(field); (recipientInputs[field][index] || recipientInputs[field].at(-1) || rows[field].add).focus();
      }, 'close', true);
      chip.append(input, remove); rows[field].list.append(chip); recipientInputs[field].push(input);
    });
  }
  renderRecipients('to'); renderRecipients('cc');
  const workspace = el('div', 'em-workspace');
  const subjectRow = el('div', 'em-row em-subject-row');
  const subjectLabel = el('label', 'em-subject-label'); subjectLabel.append(el('span', 'em-row-label', 'Objet'));
  const subject = el('input'); subject.value = model.subject; subject.maxLength = 998; subjectLabel.append(subject);
  const aiTools = el('div', 'em-ai-tools');
  const undo = button('Revenir au texte avant l’IA', () => {
    if (!sending && !rewriting && undoRewrite(model)) {
      syncText(); status.hidden = true; sync(); body.focus();
    }
  }, 'undo', true);
  const ai = button('Rédiger avec l’IA', rewriteMessage, 'ai', true);
  aiTools.append(undo, ai); subjectRow.append(subjectLabel, aiTools);
  const body = el('textarea', 'em-body'); body.value = model.body; body.setAttribute('aria-label', 'Message au client'); body.spellcheck = true;
  subject.addEventListener('input', () => { model.subject = subject.value; subject.removeAttribute('aria-invalid'); });
  body.addEventListener('input', () => { model.body = body.value; body.removeAttribute('aria-invalid'); });
  const signature = el('div', 'em-signature'); signature.setAttribute('aria-label', 'Signature enregistrée');
  workspace.append(subjectRow, body, signature);
  const attachment = el('div', 'em-attachment');
  const fileCopy = el('div', 'em-file-copy');
  const fileName = el('strong'); const pdfStatus = el('small'); pdfStatus.setAttribute('role', 'status');
  fileCopy.append(fileName, pdfStatus); attachment.append(el('span', 'em-pdf-tag', 'PDF'), fileCopy);
  const viewPdf = button('Voir', showPreview, 'eye'); viewPdf.classList.add('em-preview');
  viewPdf.disabled = typeof options.previewPdf !== 'function' && !(options.pdfBlob instanceof Blob);
  attachment.append(viewPdf);
  scroll.append(routing, workspace, attachment);
  const status = el('p', 'em-status'); status.setAttribute('role', 'alert'); status.hidden = true;
  const footer = el('footer', 'em-footer');
  const hint = el('span', 'em-footer-hint', 'Envoi depuis votre Outlook');
  const cancel = button('Annuler', close);
  const send = button('Envoyer', sendMessage, 'send'); send.classList.add('em-primary');
  const another = button('Préparer un autre envoi', confirmAnother);
  another.classList.add('em-another'); another.hidden = true;
  footer.append(hint, another, cancel, send); panel.append(head, scroll, status, footer);
  const flow = createSendFlow({ model, getSettings: () => settings, invoke, preparePdf, newAttemptId: () => crypto.randomUUID(), onPdfSaved: () => {
    status.textContent = 'PDF enregistré. Envoi à Outlook…'; sync();
  } });
  const snapshot = () => structuredClone({ ...model, language, draftId: draft.id });
  const controller = { close, focus: () => nested ? nested.focus() : host.setScope(panel, close), snapshot, settings: showSettings, ready: null };
  active = controller;
  function syncText() { subject.value = model.subject; body.value = model.body; }
  function showError(error) { if (!closed) { status.hidden = false; status.textContent = errorText(error); } }
  function sync() {
    if (closed) return;
    senderAddress.textContent = settings.connected && settings.senderEmail ? settings.senderEmail : settings.authPending ? 'Connexion en cours…' : 'Connexion requise';
    signature.textContent = settings.signature; signature.hidden = !settings.signature;
    fileName.textContent = model.attachment?.filename || options.filename || 'Document PDF';
    fileName.title = fileName.textContent;
    pdfStatus.textContent = model.pdfStatus === 'saved' ? 'PDF enregistré sur cet ordinateur' : model.pdfStatus === 'failed' ? 'PDF non enregistré · nouvel essai possible' : sending ? 'Enregistrement du PDF…' : 'Sera enregistré avant l’envoi';
    const blocked = sending || rewriting;
    for (const node of panel.querySelectorAll('button,input,textarea,a')) {
      if (node.tagName === 'A') { node.tabIndex = blocked ? -1 : 0; node.style.pointerEvents = blocked ? 'none' : ''; }
      else node.disabled = sending;
    }
    subject.readOnly = rewriting; body.readOnly = rewriting;
    undo.disabled = blocked || !model.undo.length;
    ai.disabled = blocked || typeof rewrite !== 'function'; ai.setAttribute('aria-busy', String(rewriting));
    viewPdf.disabled = blocked || (typeof options.previewPdf !== 'function' && !(options.pdfBlob instanceof Blob));
    if (typeof rewrite !== 'function') { ai.title = 'Rédaction IA indisponible'; ai.dataset.tooltip = ai.title; }
    send.disabled = blocked || model.sendState !== 'idle';
    another.hidden = !['accepted', 'uncertain'].includes(model.sendState);
    another.textContent = model.sendState === 'uncertain' ? 'J’ai vérifié Outlook — préparer un autre envoi' : 'Préparer un autre envoi';
    another.setAttribute('aria-label', another.textContent); another.disabled = blocked;
    send.replaceChildren(icon('send'), document.createTextNode(sending ? 'Envoi…' : model.sendState === 'accepted' ? 'Accepté par Outlook' : model.sendState === 'uncertain' ? 'Envoi non confirmé' : 'Envoyer'));
    panel.setAttribute('aria-busy', String(blocked));
  }
  function updateSettings(value) {
    if (closed) return;
    settings = { ...value, signature: typeof value.signature === 'string' ? value.signature : DEFAULT_SIGNATURE };
    if (!restored && !model.ccTouched && draft.kind === 'facture') {
      model.cc = text(value.accountantEmail).trim() ? [value.accountantEmail] : []; renderRecipients('cc');
    }
    sync();
  }
  function pollSettings() {
    clearTimeout(pollTimer);
    if (!closed && !nested && settings.authPending) pollTimer = setTimeout(async () => {
      try { updateSettings(await invoke('get_mail_settings')); } catch (error) { showError(error); }
      pollSettings();
    }, 1000);
  }
  function showSettings() {
    if (closed || sending) return controller;
    if (nested) { nested.focus(); return nested; }
    if (rewriting) return controller;
    clearTimeout(pollTimer); panel.inert = true;
    nested = settingsPanel({ host, invoke, initial: settingsLoaded ? settings : null, onSettings: updateSettings, onClose: () => {
      nested = null; panel.inert = false; host.setScope(panel, close); sender.querySelector('button').focus(); pollSettings();
    } });
    return nested;
  }
  function showPreview() {
    if (closed || sending || rewriting) return;
    if (nested) { nested.focus(); return; }
    panel.inert = true;
    clearTimeout(pollTimer);
    const layer = el('div', 'em-layer');
    const viewer = dialog('Aperçu du PDF', 'em-pdf-viewer');
    let previewClosed = false, objectUrl = null;
    const previewHead = el('header', 'em-head');
    previewHead.append(el('h2', '', 'Aperçu du PDF'), button('Fermer l’aperçu', closePreview, 'close', true));
    const previewContent = el('div', 'em-preview-content');
    const previewStatus = el('p', 'em-muted', 'Préparation de l’aperçu…'); previewStatus.setAttribute('role', 'status');
    previewContent.append(previewStatus); viewer.append(previewHead, previewContent); layer.append(viewer); host.root.append(layer);
    function closePreview() {
      if (previewClosed) return;
      previewClosed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      layer.remove(); nested = null; panel.inert = false;
      host.setScope(panel, close); viewPdf.focus(); pollSettings();
    }
    const previewController = { close: closePreview, focus: () => host.setScope(viewer, closePreview), ready: null };
    nested = previewController;
    previewController.focus();
    previewController.ready = (async () => {
      try {
        const blob = typeof options.previewPdf === 'function' ? pdfPreviewBlob(await options.previewPdf()) : options.pdfBlob;
        if (previewClosed || closed) return;
        objectUrl = URL.createObjectURL(blob);
        const embedded = el('object', 'em-pdf-object'); embedded.type = 'application/pdf'; embedded.data = objectUrl;
        embedded.setAttribute('aria-label', 'Aperçu du document PDF');
        embedded.append(el('p', 'em-muted', 'Ce lecteur ne prend pas en charge l’affichage intégré du PDF.'));
        const fallback = el('div', 'em-pdf-fallback');
        const open = el('a', 'em-button', 'Ouvrir le PDF'); open.href = objectUrl; open.target = '_blank'; open.rel = 'noopener';
        const download = el('a', 'em-button', 'Télécharger le PDF'); download.href = objectUrl; download.download = options.filename || 'Document.pdf';
        fallback.append(el('p', 'em-muted', 'Si l’aperçu ne s’affiche pas dans cette fenêtre, ouvrez ou téléchargez le PDF.'), open, download);
        previewStatus.textContent = 'Aperçu du document · le PDF à envoyer sera enregistré lors de l’envoi.';
        previewContent.append(embedded, fallback);
      } catch (error) { if (!previewClosed && !closed) previewStatus.textContent = errorText(error); }
    })();
    return previewController;
  }
  function confirmAnother() {
    if (closed || sending || rewriting || nested || !['accepted', 'uncertain'].includes(model.sendState)) return;
    panel.inert = true;
    const layer = el('div', 'em-layer');
    const confirmation = dialog('Préparer un autre envoi', 'em-confirmation');
    const head = el('header', 'em-head'); head.append(el('h2', '', 'Préparer un autre envoi'));
    const warning = model.sendState === 'uncertain' ? 'Un message peut déjà avoir été envoyé. Un nouvel envoi peut créer un doublon. Confirmez uniquement après avoir vérifié Outlook.' : 'Outlook a déjà accepté le précédent message. Vous préparez un autre envoi avec un nouveau PDF et un nouvel identifiant.';
    const content = el('p', 'em-confirmation-copy', warning);
    const footer = el('footer', 'em-footer');
    const confirm = button('Confirmer un nouvel envoi', () => {
      if (sending || !prepareAnotherSend(model, true)) return;
      remembered.set(key, snapshot()); status.hidden = true; sync(); closeConfirmation();
    }); confirm.classList.add('em-primary');
    footer.append(button('Annuler', closeConfirmation), confirm);
    confirmation.append(head, content, footer); layer.append(confirmation); host.root.append(layer);
    function closeConfirmation() {
      layer.remove(); nested = null; panel.inert = false; host.setScope(panel, close); (another.hidden ? send : another).focus();
    }
    nested = { close: closeConfirmation, focus: () => host.setScope(confirmation, closeConfirmation) };
    nested.focus();
  }
  async function rewriteMessage() {
    if (closed || sending || rewriting || typeof rewrite !== 'function') return;
    rewriting = true; status.hidden = true; sync();
    try {
      const result = await rewrite({ body: model.body, subject: model.subject, language });
      if (!closed) { applyRewrite(model, result); syncText(); status.hidden = false; status.textContent = 'Proposition IA · relisez le message avant l’envoi.'; }
    } catch (error) { showError(error); }
    finally { rewriting = false; sync(); }
  }
  async function sendMessage() {
    if (closed || sending || rewriting || nested || model.sendState !== 'idle') return;
    const issues = messageIssues(model, settings.connected, settings.signature);
    if (issues.length) {
      showError(issues.map(issue => issue.message).join(' '));
      for (const issue of issues) {
        const node = issue.field === 'subject' ? subject : issue.field === 'body' ? body : recipientInputs[issue.field]?.[issue.index];
        node?.setAttribute('aria-invalid', 'true');
      }
      const first = issues[0];
      const target = first.field === 'subject' ? subject : first.field === 'body' ? body : first.field === 'account' ? sender.querySelector('button') : recipientInputs[first.field]?.[first.index] || rows[first.field]?.add;
      target?.focus(); return;
    }
    sending = true; status.hidden = false; status.textContent = 'Enregistrement du PDF, puis envoi à Outlook…'; sync();
    let receipt;
    try {
      receipt = await flow.send();
      status.textContent = 'Outlook a accepté le message. La livraison n’est pas encore confirmée.';
    } catch (error) {
      showError(`${errorText(error)}${model.sendState === 'uncertain' ? ' Envoi non confirmé : vérifiez Outlook avant tout nouvel envoi. Aucun renvoi automatique.' : ''}`);
    } finally { sending = false; sync(); }
    if (receipt) {
      remembered.set(key, snapshot());
      try { await onSent?.(receipt, model.attachment); }
      catch (error) { showError(`Message accepté par Outlook. ${errorText(error)}`); }
    }
  }
  function close() {
    if (closed) return false;
    if (sending) { showError('L’envoi est en cours. Attendez le résultat avant de fermer.'); return false; }
    if (nested) { nested.close(); return false; }
    closed = true; clearTimeout(pollTimer);
    const saved = snapshot(); remembered.set(key, saved);
    host.destroy(); active = null; onClose?.(saved); return true;
  }
  let settingsLoaded = false;
  controller.ready = Promise.resolve().then(() => invoke('get_mail_settings')).then(value => { settingsLoaded = true; updateSettings(value); pollSettings(); }).catch(showError);
  host.setScope(panel, close); sync();
  if (model.sendState === 'uncertain') showError('Envoi non confirmé : vérifiez Outlook avant tout nouvel envoi. Le PDF enregistré a été conservé.');
  if (model.sendState === 'accepted') { status.hidden = false; status.textContent = 'Outlook a déjà accepté ce message.'; }
  return controller;
}
