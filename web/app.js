    import { invoke } from '@tauri-apps/api/core';
    import { check } from '@tauri-apps/plugin-updater';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { open as pickFolder } from '@tauri-apps/plugin-dialog';
    import { createPdf } from './pdf.js';
    import { startCapture } from './voice-capture.js';
    import { createVoiceSession, releaseVoiceField, releaseVoiceItem, applyVoiceUpdate } from './voice-workflow.js';
    import businessCardImage from './assets/business-card-image.png';

    const design = { title: 'Accueil calme', subtitle: 'Un choix clair, puis le document à remplir.' };
    const today = () => isoDate(new Date());
    let state = null;
    const themeStorageKey = 'hermitage-theme';
    let theme = (() => {
      try { return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light'; }
      catch { return 'light'; }
    })();
    let calendarField = null;
    let calendarView = null;
    let recentOpen = false;
    let recentQuery = '';
    let showValidation = false;
    let saveTimer;
    let editRevision = 0;
    let savedRevision = 0;
    let commandQueue = Promise.resolve();
    let busy = false;
    let undoStack = [];
    let undoGroup = null;
    let records = [];
    let nextInvoiceNumber = null;
    let pdfDirectory = '';
    let usingDefaultDirectory = true;
    let folderOpen = false;
    let folderBusy = false;
    let folderError = '';
    let englishMode = false;
    let translationError = '';
    let settingsOpen = false;
    let settingsBusy = false;
    let settingsError = '';
    let aiSettings = null;
    let lineAssist = null;
    let activeCapture = null;
    let voiceSession = null;
    let voiceRecovery = null;
    let voiceRetryBusy = false;
    let voiceQueue = Promise.resolve();
    let voiceStatus = '';
    let loadError = null;
    let recentOpener = null;
    let updateOpen = false;
    let updateStatus = 'idle';
    let updateError = '';
    let availableUpdate = null;
    let updateVersion = '';
    let updateDownloaded = 0;
    let updateTotal = null;
    let updateDraftSaved = false;
    let updateRequestId = 0;
    let numberConfirm = null;
    let numberEditing = false;
    let numberError = '';
    let saveStatus = 'Brouillon chargé';
    let outputStatus = '';
    const copy = value => JSON.parse(JSON.stringify(value));
    const errorText = error => String(error?.message || error || 'Erreur inconnue');
    function applySnapshot(snapshot, replaceCurrent = true) {
      if (!snapshot?.current || !Array.isArray(snapshot.records)) throw new Error('Réponse de stockage invalide.');
      if (state?.id !== snapshot.current.id) { englishMode = false; translationError = ''; }
      records = snapshot.records;
      nextInvoiceNumber = snapshot.nextInvoiceNumber;
      pdfDirectory = snapshot.pdfDirectory;
      usingDefaultDirectory = snapshot.usingDefaultDirectory;
      if (replaceCurrent) state = copy(snapshot.current);
      else if (state?.id === snapshot.current.id) {
        state.invoiceNumber = snapshot.current.invoiceNumber;
        state.issuedNumber = snapshot.current.issuedNumber;
      }
      if (state && (!Array.isArray(state.items) || !state.items.length)) state.items = [{ description: '', quantity: '1', price: '' }];
    }
    function runCommand(name, args) {
      const task = commandQueue.catch(() => {}).then(() => invoke(name, args));
      commandQueue = task.catch(() => {});
      return task;
    }
    function markDirty() {
      if (!voiceSession) voiceStatus = '';
      editRevision++;
      outputStatus = '';
      const output = document.querySelector('.output-status');
      if (output) output.textContent = '';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void saveNow(); }, 500);
      setSaveStatus('Modifications en attente…');
    }
    function setSaveStatus(message) {
      saveStatus = message;
      const el = document.getElementById('save-status');
      if (el) el.textContent = message;
    }
    async function saveNow(force = false) {
      clearTimeout(saveTimer);
      if (!state || (!force && editRevision === savedRevision)) return true;
      const revision = editRevision;
      const id = state.id;
      const draft = copy(state);
      setSaveStatus('Enregistrement…');
      try {
        const snapshot = await runCommand('save_draft', { draft });
        const beforeNumber = state?.invoiceNumber;
        const beforeIssued = state?.issuedNumber;
        applySnapshot(snapshot, state?.id === id && editRevision === revision);
        savedRevision = revision;
        if (editRevision > revision) { setSaveStatus('Modifications en attente…'); clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveNow(); }, 500); }
        else setSaveStatus('Brouillon enregistré');
        if (state?.id === id && (beforeNumber !== state.invoiceNumber || beforeIssued !== state.issuedNumber)) render();
        else sync();
        return true;
      } catch (error) {
        setSaveStatus('Échec de l’enregistrement');
        notice(`Brouillon non enregistré : ${errorText(error)}`);
        return false;
      }
    }
    async function flushChanges() { return saveNow(); }
    function rememberUndo(group = null) {
      if (group && undoGroup === group) return;
      undoStack.push({ draft: copy(state) });
      if (undoStack.length > 20) undoStack.shift();
      undoGroup = group;
      const button = document.querySelector('[data-undo]'); if (button) button.disabled = false;
    }
    async function undo() {
      if (!undoStack.length || busy) return;
      const previous = undoStack.pop(); undoGroup = null; showValidation = false;
      if (previous.openId) {
        if (!await flushChanges()) { undoStack.push(previous); return; }
        await nativeTransition('open_draft', { id: previous.openId }, 'Dernière modification annulée.');
      } else {
        state = previous.draft;
        markDirty(); render();
        if (await saveNow()) notice('Dernière modification annulée.');
      }
    }
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
    const money = n => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(Number.isFinite(n) ? n : 0);
    const value = x => Math.max(0, Number(String(x ?? '').trim().replace(',', '.')) || 0);
    const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;
    const total = () => cents(state.items.reduce((sum, item) => sum + value(item.quantity) * value(item.price), 0));
    const tps = () => cents(total() * 0.05);
    const tvq = () => cents(total() * 0.09975);
    const gross = () => cents(total() + tps() + tvq());
    const deposit = () => cents(value(state.deposit));
    const balance = () => Math.max(0, cents(gross() - deposit()));
    const kindTitle = () => state.kind === 'facture' ? 'Facture' : 'Soumission';
    const englishCurrent = () => {
      const en = state?.englishCopy;
      return Boolean(en && en.sourceProject === state.project && en.sourceNotes === state.notes &&
        Array.isArray(en.sourceDescriptions) && en.sourceDescriptions.length === state.items.length &&
        en.sourceDescriptions.every((value, index) => value === state.items[index].description) &&
        Array.isArray(en.descriptions) && en.descriptions.length === state.items.length);
    };
    const customerDraft = () => {
      if (!englishMode || !state.englishCopy) return state;
      const en = state.englishCopy;
      return { ...state, project: en.project, notes: en.notes,
        items: state.items.map((item, index) => ({ ...item, description: en.descriptions[index] ?? '' })) };
    };
    const taxIds = '<span>TPS 848045563 RT0001</span><span>TVQ 1212260726 TQ0001</span>';
    const pad2 = number => String(number).padStart(2, '0');
    const isoDate = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const parseDate = iso => {
      const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
      if (!parts) return null;
      const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
      return isoDate(date) === iso ? date : null;
    };
    const displayDate = iso => { const date = parseDate(iso); return date ? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}` : ''; };
    const monthNames = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dateNames = { date: 'la date du document', validUntil: 'la date de validité', dueDate: 'la date limite de paiement' };
    function calendarPopover(field) {
      const view = calendarView || parseDate(state[field]) || new Date();
      const year = view.year ?? view.getFullYear();
      const month = view.month ?? view.getMonth();
      const offset = (new Date(year, month, 1).getDay() + 6) % 7;
      const count = new Date(year, month + 1, 0).getDate();
      const days = Array.from({ length: count }, (_, index) => {
        const day = index + 1;
        const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
        const spoken = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'full' }).format(new Date(year, month, day));
        return `<button type="button" data-calendar-day="${iso}" aria-label="${esc(spoken)}" aria-selected="${state[field] === iso}" data-today="${today() === iso}">${day}</button>`;
      }).join('');
      const months = monthNames.map((name, index) => `<option value="${index}" ${index === month ? 'selected' : ''}>${name}</option>`).join('');
      const years = Array.from({ length: 201 }, (_, index) => 1900 + index).map(option => `<option value="${option}" ${option === year ? 'selected' : ''}>${option}</option>`).join('');
      return `<div class="date-popover" role="dialog" aria-label="Choisir ${dateNames[field]}"><div class="calendar-toolbar"><button type="button" data-calendar-prev aria-label="Mois précédent">‹</button><select data-calendar-month aria-label="Mois">${months}</select><select data-calendar-year aria-label="Année">${years}</select><button type="button" data-calendar-next aria-label="Mois suivant">›</button></div><div class="calendar-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(day => `<b aria-hidden="true">${day}</b>`).join('')}${'<span aria-hidden="true"></span>'.repeat(offset)}${days}</div><div class="calendar-actions"><button type="button" data-calendar-today>Aujourd’hui</button>${field === 'dueDate' ? '<button type="button" data-calendar-clear>Aucune date</button>' : ''}</div></div>`;
    }
    function dateControl(field, label, span = '') {
      const open = calendarField === field;
      return `<div class="${span} date-wrap" data-date-wrap="${field}"><label for="date-${field}">${label}</label><div class="date-shell"><input id="date-${field}" data-field="${field}" data-date-display="${field}" type="text" readonly value="${esc(displayDate(state[field]))}" placeholder="Choisir une date" aria-haspopup="dialog" aria-expanded="${open}"><button type="button" class="date-trigger" data-calendar="${field}" aria-label="Choisir ${dateNames[field]}" title="Ouvrir le calendrier" aria-expanded="${open}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 18h2"></path></svg></button></div>${open ? calendarPopover(field) : ''}</div>`;
    }
    function toggleCalendar(field) {
      if (calendarField === field) { calendarField = null; calendarView = null; render(); return; }
      const initial = parseDate(state[field]) || new Date();
      calendarField = field;
      calendarView = { year: initial.getFullYear(), month: initial.getMonth() };
      render();
      document.querySelector(`[data-calendar="${field}"]`)?.focus();
    }
    function shiftCalendar(months) {
      const next = new Date(calendarView.year, calendarView.month + months, 1);
      if (next.getFullYear() < 1900 || next.getFullYear() > 2100) return;
      calendarView = { year: next.getFullYear(), month: next.getMonth() };
      render();
      document.querySelector(months < 0 ? '[data-calendar-prev]' : '[data-calendar-next]')?.focus();
    }
    function chooseDate(iso) {
      const field = calendarField;
      if (!field || (iso && !parseDate(iso))) return;
      if (state[field] !== iso) { rememberUndo(); state[field] = iso; }
      calendarField = null; calendarView = null;
      render(); markDirty(); void saveNow();
      document.querySelector(`[data-date-display="${field}"]`)?.focus();
    }
    const input = (field, label, placeholder = '', type = 'text', span = '') => type === 'date' ? dateControl(field, label, span) : `<label class="${span}">${label}<input data-field="${field}" type="${type}" value="${esc(state[field])}" placeholder="${esc(placeholder)}" ${field === 'client' ? 'required' : ''}></label>`;
    const textArea = (field, label, placeholder = '', span = '', rows = 2) => `<label class="${span}">${label}<textarea data-field="${field}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(state[field] || '')}</textarea></label>`;
    const row = (item, i) => `<div class="line-entry"><div class="line-header"><div class="line-title"><strong>Ligne ${i + 1}</strong><span>Description</span></div><div class="line-header-actions"><button type="button" class="line-dictate" aria-label="Dicter cette ligne" title="Dicter cette ligne"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg></button><button type="button" class="line-enhance" aria-label="Améliorer cette ligne" title="Améliorer cette ligne"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2ZM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></svg></button></div><button type="button" class="remove-line" data-remove="${i}" aria-label="Retirer la ligne ${i + 1}" title="Retirer la ligne ${i + 1}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5 19 19M19 5 5 19"/></svg></button></div><div class="line-body"><label for="line-description-${i}" class="sr-only">Description de la ligne ${i + 1}</label><textarea id="line-description-${i}" data-item="${i}" data-key="description" rows="2" placeholder="Décrivez les travaux, matériaux ou étapes en détail">${esc(item.description)}</textarea><div class="line-details"><label>Qté<input data-item="${i}" data-key="quantity" value="${esc(item.quantity)}" inputmode="decimal" placeholder="1"></label><label>Prix unitaire<input data-item="${i}" data-key="price" value="${esc(item.price)}" inputmode="decimal" placeholder="0,00"></label><div class="line-amount-wrap"><span>Montant</span><strong class="line-amount" data-row-total="${i}">${money(value(item.quantity) * value(item.price))}</strong></div></div></div></div>`;
    function fitTextareas(root = document) {
      root.querySelectorAll('textarea').forEach(el => {
        el.style.height = 'auto';
        el.style.height = Math.max(el.scrollHeight + 2, el.dataset.key === 'description' ? 68 : 45) + 'px';
      });
    }
    function preview() {
      const view = customerDraft();
      const en = englishMode && Boolean(state.englishCopy);
      const footerIds = en ? '<span>GST 848045563 RT0001</span><span>QST 1212260726 TQ0001</span>' : taxIds;
      const invoice = state.kind === 'facture';
      const number = invoice ? `<small>${en ? 'Invoice no.' : 'Facture n°'} <span data-preview="invoiceNumber">${state.invoiceNumber ?? '—'}</span>${state.issuedNumber ? '' : `<span class="preview-only"> · ${en ? 'proposed number' : 'numéro proposé'}</span>`}</small>` : '';
      const dateLabel = invoice ? (en ? 'Payment due' : 'Date limite de paiement') : (en ? 'Valid until' : 'Valide jusqu’au');
      const dateField = invoice ? 'dueDate' : 'validUntil';
      const hasDeposit = deposit() > 0;
      const totals = `<div class="paper-totals">
        <div><span>${en ? 'Subtotal' : 'Sous-total'}</span><span data-preview="subtotal">${money(total())}</span></div>
        <div><span>${en ? 'GST (5%)' : 'TPS (5 %)'}</span><span data-preview="tps">${money(tps())}</span></div>
        <div><span>${en ? 'QST (9.975%)' : 'TVQ (9,975 %)'}</span><span data-preview="tvq">${money(tvq())}</span></div>
        <div class="grand"><span>${en ? 'Total including taxes' : 'Total avec taxes'}</span><span data-preview="gross">${money(gross())}</span></div>
        <div data-deposit-row ${hasDeposit ? '' : 'hidden'}><span>${en ? (invoice ? 'Deposit received' : 'Deposit requested') : (invoice ? 'Dépôt reçu' : 'Dépôt demandé')}</span><span data-preview="deposit">${money(deposit())}</span></div>
        <div class="balance" data-deposit-row ${hasDeposit ? '' : 'hidden'}><span>${en ? (invoice ? 'Balance due' : 'Balance after deposit') : (invoice ? 'Solde à payer' : 'Solde après dépôt')}</span><span data-preview="balance">${money(balance())}</span></div>
      </div>`;
      return `<div class="paper doc1">
        <div class="paper-top"><div class="paper-logo"><div class="paper-mark" aria-hidden="true"><img src="${businessCardImage}" alt="" width="374" height="339"></div><div class="paper-name"><strong>ÉBÉNISTERIE</strong><small>DE L'HERMITAGE INC.</small></div></div><div class="paper-type">${en ? (invoice ? 'Invoice' : 'Quote') : kindTitle()}${number}</div></div>
        <div class="doc1-summary"><div><b>${en ? 'Project' : 'Projet'}</b><strong class="project-name" data-preview="project">${esc(view.project || (en ? 'Project name' : 'Nom du projet'))}</strong></div><div><b>${en ? 'Document date' : 'Date du document'}</b><span data-preview="date">${esc(displayDate(state.date))}</span></div><div><b>${dateLabel}</b><span data-preview="${dateField}">${esc(displayDate(state[dateField]) || (invoice ? (en ? 'None' : 'Aucune') : ''))}</span></div></div>
        <div class="doc1-parties"><div class="doc1-party"><b>${en ? (invoice ? 'Bill to' : 'Prepared for') : (invoice ? 'Facturé à' : 'Proposition pour')}</b><strong data-preview="client">${esc(state.client || (en ? 'Client name' : 'Nom du client'))}</strong><p><span data-preview="address">${esc(state.address || (en ? 'Billing address' : 'Adresse de facturation'))}</span><span data-phone-block ${state.contact?.trim() ? '' : 'hidden'}><br>${en ? 'Tel.' : 'Tél.'} <span data-preview="contact">${esc(state.contact || '')}</span></span><span data-email-block ${state.email?.trim() ? '' : 'hidden'}><br>${en ? 'Email' : 'Courriel'} : <span data-preview="email">${esc(state.email || '')}</span></span></p><div class="doc1-ship" data-shipping-block ${state.shipTo?.trim() ? '' : 'hidden'}><b>${en ? 'Deliver to' : 'Livrer à'}</b><span data-preview="shipTo">${esc(state.shipTo || '')}</span></div></div><div class="doc1-party"><b>${en ? 'Issued by' : 'Émis par'}</b><strong>Ébénisterie de l’Hermitage inc.</strong><p>68, chemin des guides<br>Ripon (Qc) J0V 1V0<br>(819) 428-7690</p></div></div>
        <table class="paper-table"><thead><tr><th>${en ? 'Description' : 'Description'}</th><th>${en ? 'Qty' : 'Qté'}</th><th>${en ? 'Unit price' : 'Prix unitaire'}</th><th>${en ? 'Amount' : 'Montant'}</th></tr></thead><tbody id="previewRows"></tbody></table>
        <div class="doc1-closing"><div class="doc1-note" data-notes-block ${view.notes?.trim() ? '' : 'hidden'}><b>${en ? 'Note to client' : 'Note pour le client'}</b><p data-preview="notes">${esc(view.notes || '')}</p></div>${totals}</div>
        <div class="doc1-footer">${footerIds}</div></div><p class="preview-caption">${en ? 'English customer copy' : 'Aperçu du document'} · format Lettre</p>`;
    }
    function pdfIssues() {
      const issues = [];
      const add = (selector, label) => issues.push({ selector, label });
      if (!parseDate(state.date)) add('[data-field="date"]', 'Date du document');
      if (state.kind === 'soumission' && !parseDate(state.validUntil)) add('[data-field="validUntil"]', 'Date de validité');
      if (state.dueDate && !parseDate(state.dueDate)) add('[data-field="dueDate"]', 'Date limite de paiement');
      if (!state.client.trim()) add('[data-field="client"]', 'Nom du client');
      if (!state.address.trim()) add('[data-field="address"]', 'Adresse de facturation');
      for (const [index, item] of state.items.entries()) {
        if (!item.description?.trim()) add(`[data-item="${index}"][data-key="description"]`, `Description de la ligne ${index + 1}`);
        const rawQuantity = String(item.quantity ?? '').trim();
        const quantity = Number(rawQuantity.replace(',', '.'));
        if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(rawQuantity) || !Number.isFinite(quantity) || quantity <= 0) add(`[data-item="${index}"][data-key="quantity"]`, `Quantité de la ligne ${index + 1}`);
        const rawPrice = String(item.price ?? '').trim();
        const price = Number(rawPrice.replace(',', '.'));
        if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(rawPrice) || !Number.isFinite(price) || price < 0) add(`[data-item="${index}"][data-key="price"]`, `Prix unitaire de la ligne ${index + 1}`);
      }
      const rawDeposit = String(state.deposit ?? '').trim();
      if (rawDeposit && (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(rawDeposit) || !Number.isFinite(Number(rawDeposit.replace(',', '.'))))) add('[data-field="deposit"]', 'Dépôt');
      return issues;
    }
    function paintValidation() {
      const issues = showValidation ? pdfIssues() : [];
      const panel = document.getElementById('pdf-validation');
      if (panel) {
        panel.hidden = !issues.length;
        panel.innerHTML = issues.length ? `<strong>À compléter avant de continuer</strong><ul>${issues.map(issue => `<li>${esc(issue.label)}</li>`).join('')}</ul>` : '';
      }
      document.querySelectorAll('input[aria-invalid="true"], textarea[aria-invalid="true"]').forEach(field => field.removeAttribute('aria-invalid'));
      issues.forEach(issue => document.querySelector(issue.selector)?.setAttribute('aria-invalid', 'true'));
      return issues;
    }
    function recentRows() {
      const query = recentQuery.trim().toLocaleLowerCase('fr-CA');
      const matches = records.filter(record => [record.draft?.client, record.draft?.project, record.draft?.kind].some(value => String(value || '').toLocaleLowerCase('fr-CA').includes(query)));
      if (!matches.length) return `<p class="recent-empty">${query ? 'Aucun document trouvé.' : 'Aucun document enregistré pour le moment.'}</p>`;
      return matches.map(record => {
        const documentState = record.draft;
        const title = documentState.project?.trim() || documentState.client?.trim() || 'Sans titre';
        const kind = documentState.kind === 'facture' ? 'Facture' : 'Soumission';
        const updatedDate = new Date(record.updatedAt || Date.now());
        const updated = Number.isNaN(updatedDate.getTime()) ? '' : new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(updatedDate);
        return `<div class="recent-entry"><button type="button" class="recent-row" data-open-record="${esc(record.id)}"><span><strong>${esc(title)}</strong><small>${kind} · ${esc(documentState.client?.trim() || 'Client à compléter')} · ${esc(updated)}</small></span>${record.id === state.id ? '<em>En cours</em>' : '<em>Ouvrir</em>'}</button><button type="button" class="recent-restore" data-restore-version="${esc(record.id)}">Restaurer une version précédente</button></div>`;
      }).join('');
    }
    function recentDialog() {
      if (!recentOpen) return '';
      return `<div class="recent-backdrop"><div class="recent-panel" role="dialog" aria-modal="true" aria-labelledby="recent-title"><div class="recent-head"><h3 id="recent-title">Documents récents</h3><button type="button" data-close-recent aria-label="Fermer les documents récents" title="Fermer">✕</button></div><p class="recent-hint">Brouillons enregistrés sur cet ordinateur.</p><label for="recent-search">Rechercher un client ou un projet</label><input id="recent-search" data-recent-search type="search" value="${esc(recentQuery)}" placeholder="Nom du client ou du projet"><div class="recent-list" id="recent-list">${recentRows()}</div></div></div>`;
    }
    function paintVoiceUi() {
      const topMic = document.querySelector('[data-voice]');
      if (topMic) {
        topMic.disabled = Boolean(voiceSession?.stopping);
        topMic.setAttribute('aria-pressed', String(Boolean(voiceSession)));
        topMic.setAttribute('aria-label', voiceSession ? 'Arrêter la dictée du document' : 'Remplir le document en parlant');
        topMic.title = voiceSession ? 'Arrêter la dictée' : 'Remplir en parlant';
        topMic.classList.toggle('recording', Boolean(voiceSession));
      }
      const heading = document.querySelector('.items-section .table-head small');
      if (heading) heading.textContent = 'Microphone pour dicter · Étoiles pour améliorer';
      const statusAnchor = document.getElementById('save-status');
      if (statusAnchor) {
        const recovery = voiceRecovery?.session?.transcript;
        statusAnchor.insertAdjacentHTML('afterend', `${voiceStatus ? `<p class="voice-status" role="status" aria-live="polite">${esc(voiceStatus)}</p>` : ''}${recovery ? `<div class="voice-recovery" role="alert"><strong>Paroles reconnues à vérifier</strong><p>L’analyse a échoué. Votre texte reconnu reste disponible ici.</p><textarea readonly rows="3" aria-label="Paroles reconnues">${esc(recovery)}</textarea><div><button type="button" class="plain-button" data-retry-document-voice ${voiceRetryBusy ? 'disabled' : ''}>Réessayer le remplissage</button><button type="button" class="plain-button" data-copy-voice ${voiceRetryBusy ? 'disabled' : ''}>Copier le texte</button><button type="button" class="plain-button" data-dismiss-voice ${voiceRetryBusy ? 'disabled' : ''}>Fermer</button></div></div>` : ''}`);
      }
      document.querySelectorAll('.line-entry').forEach((entry, index) => {
        const dictate = entry.querySelector('.line-dictate');
        const enhance = entry.querySelector('.line-enhance');
        dictate.disabled = false; enhance.disabled = false;
        dictate.dataset.lineDictate = String(index);
        enhance.dataset.lineEnhance = String(index);
        dictate.setAttribute('aria-label', `Dicter la ligne ${index + 1}`);
        enhance.setAttribute('aria-label', `Améliorer la ligne ${index + 1} avec l’IA`);
        const assist = lineAssist?.index === index ? lineAssist : null;
        if (!assist) return;
        dictate.disabled = Boolean(assist.stopping || assist.processing);
        entry.classList.toggle('line-recording', Boolean(assist.recording));
        dictate.setAttribute('aria-pressed', String(Boolean(assist.recording)));
        dictate.title = assist.recording ? 'Arrêter la dictée' : 'Dicter cette ligne';
        const close = entry.querySelector('.remove-line');
        close.removeAttribute('data-remove');
        close.dataset.closeLineAssist = String(index);
        close.setAttribute('aria-label', 'Fermer la proposition');
        close.title = 'Fermer la proposition';
        const textarea = entry.querySelector('textarea[data-key="description"]');
        if (textarea) {
          textarea.removeAttribute('data-item');
          if (assist.proposal && !assist.recording && !assist.processing) {
            textarea.dataset.assistProposal = '';
            textarea.value = assist.proposal;
          } else textarea.readOnly = true;
        }
        const review = document.createElement('div');
        review.className = 'line-review';
        review.innerHTML = `<p class="line-review-status" role="status">${esc(assist.status)}</p>${assist.proposal && !assist.recording && !assist.processing ? `<div class="line-review-styles"><button type="button" data-line-style="prose" aria-pressed="${assist.style === 'prose'}">Texte clair</button><button type="button" data-line-style="bullets" aria-pressed="${assist.style === 'bullets'}">Liste à puces</button><button type="button" data-line-variation>Autre version</button></div><div class="line-review-actions"><button type="button" class="line-accept" data-line-accept>Accepter</button></div>` : ''}`;
        textarea?.insertAdjacentElement('afterend', review);
      });
    }
    function folderDialog() {
      if (!folderOpen) return '';
      return `<div class="recent-backdrop"><div class="recent-panel folder-panel" role="dialog" aria-modal="true" aria-labelledby="folder-title" aria-describedby="folder-help" tabindex="-1"><div class="recent-head"><h3 id="folder-title">Dossier des PDF</h3><button type="button" data-close-folder aria-label="Fermer le choix du dossier" title="Fermer" ${folderBusy ? 'disabled' : ''}>✕</button></div><p id="folder-help" class="recent-hint">Les soumissions et factures seront enregistrées ici avant l'impression ou lorsque vous créez un PDF.</p><div class="folder-current"><strong>Dossier actuel${usingDefaultDirectory ? ' · par défaut' : ''}</strong><span>${esc(pdfDirectory)}</span></div>${folderError ? `<p class="folder-error" role="alert">${esc(folderError)}</p>` : ''}<div class="folder-actions"><button type="button" class="primary" data-choose-folder ${folderBusy ? 'disabled' : ''}>Choisir un dossier…</button><button type="button" class="plain-button" data-default-folder ${folderBusy || usingDefaultDirectory ? 'disabled' : ''}>Revenir au dossier par défaut</button></div></div></div>`;
    }
    function aiSettingsDialog() {
      if (!settingsOpen) return '';
      if (!aiSettings) return `<div class="recent-backdrop"><div class="recent-panel ai-settings-panel" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" tabindex="-1"><div class="recent-head"><h3 id="ai-settings-title">Réglages de l’IA</h3><button type="button" data-close-ai-settings aria-label="Fermer les réglages">✕</button></div><p>${settingsError ? esc(settingsError) : 'Chargement des réglages…'}</p></div></div>`;
      const provider = aiSettings?.provider || 'openai';
      const activeConfigured = provider === 'openai' ? aiSettings?.openaiConfigured : aiSettings?.zaiConfigured;
      return `<div class="recent-backdrop"><div class="recent-panel ai-settings-panel" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" tabindex="-1"><div class="recent-head"><h3 id="ai-settings-title">Réglages de l’IA</h3><button type="button" data-close-ai-settings aria-label="Fermer les réglages" ${settingsBusy ? 'disabled' : ''}>✕</button></div><p class="recent-hint">Choisissez le service utilisé pour la traduction, les descriptions et la dictée. Les paroles enregistrées et le contenu du client sont envoyés uniquement au service choisi.</p><fieldset class="provider-choices"><legend>Service pour les textes et la voix</legend><label><input type="radio" name="ai-provider" value="openai" ${provider === 'openai' ? 'checked' : ''} ${settingsBusy ? 'disabled' : ''}> OpenAI ${aiSettings?.openaiConfigured ? '· clé enregistrée' : ''}</label><label><input type="radio" name="ai-provider" value="zai" ${provider === 'zai' ? 'checked' : ''} ${settingsBusy ? 'disabled' : ''}> Z.ai ${aiSettings?.zaiConfigured ? '· clé enregistrée' : ''}</label></fieldset><p class="settings-note">Une clé d’API générale du service choisi est nécessaire. Votre abonnement Codex ou Z.ai Coding Plan ne donne pas automatiquement accès aux appels de cette application.</p><label for="ai-key">${activeConfigured ? 'Remplacer la clé du service choisi' : 'Ajouter la clé du service choisi'}<input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="Clé d’API" ${settingsBusy ? 'disabled' : ''}></label><div class="folder-actions"><button type="button" class="primary" data-save-ai-key ${settingsBusy ? 'disabled' : ''}>Enregistrer la clé</button>${activeConfigured ? `<button type="button" class="plain-button" data-remove-ai-key ${settingsBusy ? 'disabled' : ''}>Supprimer la clé</button>` : ''}</div><p class="settings-note">La clé est gardée dans le coffre de Windows, séparément des brouillons et des PDF.</p>${settingsError ? `<p class="translation-error" role="alert">${esc(settingsError)}</p>` : ''}</div></div>`;
    }
    function invoiceNumberControl() {
      if (state.kind !== 'facture') return '';
      const issued = Boolean(state.issuedNumber);
      return `<div class="invoice-number"><div class="invoice-number-top"><span>Numéro de facture ${issued ? 'émise' : 'proposé'} : <strong>n° <span data-preview="invoiceNumber">${state.invoiceNumber ?? '—'}</span></strong></span><button type="button" class="plain-button" data-edit-number>${issued ? 'Régler le prochain n°' : 'Modifier le n°'}</button></div>${numberEditing ? `<div class="next-number-form" id="next-number-form"><label for="next-number">Prochain numéro de facture</label><div class="number-entry"><input id="next-number" name="number" type="number" min="1" step="1" value="${esc(numberConfirm ?? nextInvoiceNumber ?? '')}" required aria-describedby="next-number-help" ${numberConfirm === null ? '' : 'readonly'}>${numberConfirm === null ? '<button type="button" class="plain-button number-step" data-number-step="-1" aria-label="Diminuer le prochain numéro de facture">−</button><button type="button" class="plain-button number-step" data-number-step="1" aria-label="Augmenter le prochain numéro de facture">+</button><button type="button" class="primary" data-stage-number>Appliquer</button>' : ''}<button type="button" class="plain-button" data-close-number>Fermer</button></div><small id="next-number-help">Ce réglage s'applique aux prochaines factures. Les numéros déjà émis restent inchangés.</small>${numberError ? `<p class="number-error" role="alert">${esc(numberError)}</p>` : ''}${numberConfirm === null ? '' : `<div class="number-confirm" role="group" aria-label="Confirmer le prochain numéro"><strong>Définir ${numberConfirm} comme prochain numéro ?</strong><div><button type="button" class="primary" data-apply-number>Confirmer</button><button type="button" class="plain-button" data-cancel-number>Annuler</button></div></div>`}</div>` : ''}</div>`;
    }
    function languageControls() {
      const copy = state.englishCopy;
      const current = englishCurrent();
      const status = !copy ? 'Rédigez en français, puis créez une copie anglaise à vérifier.'
        : !current ? 'Le français a changé. La copie anglaise doit être actualisée.'
        : copy.reviewed ? 'Copie anglaise vérifiée et enregistrée avec ce document.'
        : 'Relisez et confirmez la copie anglaise avant le PDF.';
      const translateLabel = copy ? 'Retraduire' : 'Traduire en anglais';
      return `<div class="language-action"><div><strong>Copie pour le client · ${englishMode ? 'Anglais' : 'Français'}</strong><small>${status}</small></div><div class="language-buttons">${copy ? `<button type="button" class="plain-button" data-show-french ${englishMode ? '' : 'disabled'}>Français</button><button type="button" class="plain-button" data-show-english ${englishMode ? 'disabled' : ''}>English</button>` : ''}<button type="button" class="plain-button" data-translate>${translateLabel}</button></div></div>${translationError ? `<p class="translation-error" role="alert">${esc(translationError)}</p>` : ''}${englishMode && copy ? `<div class="english-review" aria-label="Vérification de la copie anglaise"><div class="english-review-head"><strong>Vérifier la copie anglaise</strong><button type="button" data-show-french aria-label="Fermer la copie anglaise" title="Revenir au français">✕</button></div>${!current ? '<p class="translation-error">Le texte français a changé. Retraduisez avant de créer un PDF anglais.</p>' : ''}<p>Relisez les mots anglais. Les prix, dates et numéros viennent toujours du document français.</p>${state.project.trim() ? `<label>Project<input data-en-field="project" value="${esc(copy.project)}"></label>` : ''}${state.items.map((item, index) => `<label>Line ${index + 1} · Description<textarea data-en-item="${index}" rows="2">${esc(copy.descriptions[index] ?? '')}</textarea></label>`).join('')}${state.notes.trim() ? `<label>Note to client<textarea data-en-field="notes" rows="2">${esc(copy.notes)}</textarea></label>` : ''}<div class="english-review-actions"><button type="button" class="primary" data-accept-english ${current ? '' : 'disabled'}>${copy.reviewed && current ? 'Copie vérifiée' : 'Confirmer cette copie'}</button><button type="button" class="plain-button" data-show-french>Revenir au français</button></div></div>` : ''}`;
    }
    function updateDialog() {
      if (!updateOpen) return '';
      const active = ['saving', 'downloading', 'installing', 'restarting'].includes(updateStatus);
      let detail = '';
      if (updateStatus === 'checking') detail = '<p>Recherche d’une mise à jour…</p>';
      else if (updateStatus === 'current') detail = '<p>Votre application est à jour.</p>';
      else if (updateStatus === 'available') detail = `<p>La version <strong>${esc(updateVersion)}</strong> est disponible.</p><p class="update-hint">L’installation commence seulement si vous choisissez « Installer ».</p>`;
      else if (updateStatus === 'saving') detail = '<p>Enregistrement du brouillon avant l’installation…</p>';
      else if (updateStatus === 'downloading') detail = `<p>Brouillon enregistré. Téléchargement de la version ${esc(updateVersion)}…</p>${updateTotal ? `<progress max="${updateTotal}" value="${updateDownloaded}" aria-label="Téléchargement de la mise à jour"></progress><small data-update-progress>${Math.min(100, Math.round(updateDownloaded / updateTotal * 100))} %</small>` : '<progress aria-label="Téléchargement de la mise à jour"></progress><small data-update-progress>Téléchargement en cours…</small>'}`;
      else if (updateStatus === 'installing') detail = '<p>Téléchargement terminé. L’installation démarre…</p>';
      else if (updateStatus === 'restarting') detail = '<p>Installation lancée. Redémarrage de l’application…</p>';
      else if (updateStatus === 'error') detail = `<p class="update-error" role="alert">${esc(updateError)}</p>`;
      return `<div class="recent-backdrop update-backdrop"><div class="recent-panel update-panel" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-detail" tabindex="-1"><div class="recent-head"><h3 id="update-title">Mises à jour</h3><button type="button" data-close-update aria-label="Fermer les mises à jour" title="Fermer" ${active ? 'disabled' : ''}>✕</button></div><div id="update-detail" class="update-detail" role="status" aria-live="polite">${detail}</div><div class="update-actions">${updateStatus === 'available' ? '<button type="button" class="primary" data-install-update aria-describedby="update-detail">Installer la mise à jour</button>' : ''}${['current', 'error'].includes(updateStatus) ? '<button type="button" class="plain-button" data-check-update>Vérifier à nouveau</button>' : ''}${active ? '' : '<button type="button" class="plain-button" data-close-update>Fermer</button>'}</div></div></div>`;
    }
    function render() {
      const app = document.getElementById('app');
      if (!state) {
        app.innerHTML = `<div class="load-error" role="alert"><h1>Impossible de charger les brouillons</h1><p>${esc(loadError || 'Chargement en cours…')}</p><button type="button" class="primary" data-retry-load>Réessayer</button></div>`;
        return;
      }
      app.className = `app v1 ${theme === 'dark' ? 'dark' : ''}`;
      app.innerHTML = `<header class="app-top"><div class="brand"><div class="brand-mark" aria-hidden="true"></div><span>Ébénisterie de l'Hermitage inc.<small>Soumissions et factures</small></span></div><button type="button" class="plain-button folder-tool" data-folder title="Changer le dossier des PDF"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7l2 2h9v11H3z"/></svg>Dossier des PDF</button><div class="top-tools"><button type="button" class="plain-button" data-ai-settings>Réglages IA</button><button type="button" class="plain-button" data-recent>Documents récents</button><button type="button" class="plain-button" data-check-update>Vérifier les mises à jour</button><button type="button" class="theme-button" data-theme>${theme === 'dark' ? '☀ Mode clair' : '☾ Mode sombre'}</button></div></header>
        <div class="welcome"><p class="eyebrow">${design.title}</p><h2>Que voulez-vous préparer aujourd'hui&nbsp;?</h2><p>${design.subtitle}</p></div>
        <div class="choice-row"><button type="button" class="choice ${state.kind === 'soumission' ? 'active' : ''}" data-kind="soumission" aria-pressed="${state.kind === 'soumission'}"><span class="choice-icon">S</span><span><strong>Soumission</strong><small>Préparer un prix pour un client</small></span></button><button type="button" class="choice ${state.kind === 'facture' ? 'active' : ''}" data-kind="facture" aria-pressed="${state.kind === 'facture'}"><span class="choice-icon">F</span><span><strong>Facture</strong><small>Facturer un travail ou un produit</small></span></button></div>
        <div class="workbench">
        <section class="editor">
          <div class="section-head"><div class="section-title"><h3>${kindTitle()} à remplir</h3><p>Enregistrement automatique sur cet ordinateur.</p></div><div class="section-tools"><button type="button" class="plain-button save-button" data-save aria-label="Enregistrer le brouillon" title="Enregistrer le brouillon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4zM7 3v7h9V3M7 21v-8h10v8"></path></svg><span>Enregistrer le brouillon</span></button><button type="button" class="icon-button" data-voice aria-label="Remplir en parlant" title="Remplir en parlant"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"></path></svg></button><button type="button" class="icon-button" data-undo aria-label="Annuler la dernière modification" title="Annuler la dernière modification" ${undoStack.length ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 0 14"></path></svg></button><button type="button" class="icon-button reset-button" data-reset aria-label="Réinitialiser le brouillon" title="Réinitialiser le brouillon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"></path></svg></button></div></div>
          <p class="save-status" id="save-status" role="status" aria-live="polite">${esc(saveStatus)}</p><div class="validation-panel" id="pdf-validation" role="alert" hidden></div>
          <div class="client-fields"><h4>Projet et client</h4><div class="client-grid">
            ${input('project','Nom du projet','Nom du projet','text','span2')}
            ${input('date','Date du document','','date')}
            ${state.kind === 'facture' ? input('dueDate','Date limite de paiement <span class="optional">(facultatif)</span>','','date') : input('validUntil','Valide jusqu’au','','date')}
            ${input('client','Nom du client <span class="required">(obligatoire)</span>','Nom complet ou entreprise','text','span2')}
            ${input('contact','Téléphone <span class="optional">(facultatif)</span>','Numéro de téléphone','tel')}
            ${input('email','Courriel <span class="optional">(facultatif)</span>','adresse@exemple.com','email')}
            ${input('address','Adresse de facturation','Rue, ville, code postal','text','span2')}
            ${input('shipTo','Adresse de livraison <span class="optional">(facultatif)</span>','Seulement si différente','text','span2')}
          </div></div>
          <div class="items-section"><div class="table-head"><h4>Travaux et articles</h4><small>Microphone pour dicter · Étoiles pour améliorer</small></div>
            <div id="lines">${state.items.map(row).join('')}</div>
            <button type="button" class="add-button" data-add>+ Ajouter une ligne</button>
            <div class="optional-fields"><h4>Au besoin</h4><div class="fields">
              ${input('deposit',state.kind === 'facture' ? 'Dépôt reçu ($) <span class="optional">(facultatif)</span>' : 'Dépôt demandé ($) <span class="optional">(facultatif)</span>','Laissez vide si aucun dépôt','text','span2')}
              ${textArea('notes','Note pour le client <span class="optional">(facultatif)</span>','Ajoutez plusieurs lignes si nécessaire','span2',1)}
            </div>
            </div>
          </div>
          <div class="summary-section">
            ${invoiceNumberControl()}
            ${languageControls()}
          </div>
          <div class="actions"><button type="button" class="primary" data-pdf>Créer le PDF</button><button type="button" class="print-button" data-print>Imprimer</button></div><p class="output-status" role="status" aria-live="polite">${esc(outputStatus)}</p>
        </section><aside class="preview">${preview()}</aside></div>${recentDialog()}${updateDialog()}${folderDialog()}${aiSettingsDialog()}`;
      app.querySelectorAll('.app-top, .welcome, .choice-row, .workbench').forEach(el => { el.inert = recentOpen || updateOpen || folderOpen || settingsOpen; });
      sync();
      fitTextareas(app);
      paintValidation();
      paintVoiceUi();
      fitTextareas(app);
    }
    function sync() {
      const view = customerDraft();
      document.querySelectorAll('[data-row-total]').forEach(el => { const item = state.items[Number(el.dataset.rowTotal)]; el.textContent = money(value(item.quantity) * value(item.price)); });
      for (const [key, amount] of Object.entries({ subtotal: total(), tps: tps(), tvq: tvq(), gross: gross(), deposit: deposit(), balance: balance() })) document.querySelectorAll(`[data-preview="${key}"]`).forEach(el => el.textContent = money(amount));
      document.querySelectorAll('[data-deposit-row]').forEach(el => { el.hidden = deposit() <= 0; });
      document.querySelectorAll('[data-shipping-block]').forEach(el => { el.hidden = !state.shipTo?.trim(); });
      document.querySelectorAll('[data-phone-block]').forEach(el => { el.hidden = !state.contact?.trim(); });
      document.querySelectorAll('[data-email-block]').forEach(el => { el.hidden = !state.email?.trim(); });
      document.querySelectorAll('[data-notes-block]').forEach(el => { el.hidden = !view.notes?.trim(); });
      const previewFallback = { client:englishMode ? 'Client name' : 'Nom du client', shipTo:'', address:englishMode ? 'Billing address' : 'Adresse de facturation', date:'Date', validUntil:englishMode ? 'Valid until' : 'Date de validité', dueDate:englishMode ? 'None' : 'Aucune', invoiceNumber:state.invoiceNumber ?? '—', contact:'', email:'', project:englishMode ? 'Project name' : 'Nom du projet', notes:'' };
      for (const field of Object.keys(previewFallback)) document.querySelectorAll(`[data-preview="${field}"]`).forEach(el => el.textContent = ['date','validUntil','dueDate'].includes(field) ? displayDate(state[field]) || previewFallback[field] : view[field] || previewFallback[field]);
      const rows = view.items.filter(i => i.description?.trim() || String(i.price || '').trim()).map(i => `<tr><td>${esc(i.description || '—')}</td><td>${esc(i.quantity || '—')}</td><td>${money(value(i.price))}</td><td>${money(value(i.quantity) * value(i.price))}</td></tr>`).join('');
      const table = document.getElementById('previewRows'); if (table) table.innerHTML = rows || '<tr><td colspan="4" style="color:#87948b">Aucun article ajouté</td></tr>';
    }
    let toastTimer;
    function notice(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3700); }
    function readyForOutput() {
      if (englishMode && (!englishCurrent() || !state.englishCopy?.reviewed)) {
        notice('Vérifiez et confirmez la copie anglaise avant de créer son PDF.');
        document.querySelector('.english-review')?.scrollIntoView({ block: 'nearest' });
        return false;
      }
      showValidation = true;
      const issues = paintValidation();
      if (issues.length) {
        notice(`${issues.length} élément${issues.length > 1 ? 's' : ''} à compléter avant de continuer.`);
        document.querySelector(issues[0].selector)?.focus();
        return false;
      }
      showValidation = false;
      paintValidation();
      return true;
    }
    function setBusy(active) {
      busy = active;
      const workbench = document.querySelector('.workbench');
      if (workbench) {
        workbench.inert = active || recentOpen || updateOpen || folderOpen || settingsOpen;
        workbench.setAttribute('aria-busy', String(active));
      }
    }
    async function nativeTransition(name, args, message) {
      if (busy) return false;
      if (voiceRetryBusy) { notice('Attendez la fin de la nouvelle analyse avant de changer de document.'); return false; }
      if (voiceRecovery?.session?.transcript && !confirm('Les paroles reconnues qui n’ont pas été analysées seront perdues en changeant de document. Continuer ?')) return false;
      setBusy(true);
      try {
        const snapshot = await runCommand(name, args);
        applySnapshot(snapshot);
        savedRevision = editRevision;
        showValidation = false;
        recentOpen = false;
        numberConfirm = null;
        numberEditing = false;
        numberError = '';
        outputStatus = '';
        calendarField = null;
        lineAssist = null;
        voiceRecovery = null;
        voiceStatus = '';
        render();
        notice(message);
        return true;
      } catch (error) {
        notice(`Action impossible : ${errorText(error)}`);
        return false;
      } finally {
        setBusy(false);
      }
    }
    async function exportDocument(printAfter = false) {
      if (busy || !readyForOutput()) return;
      const alreadyExported = Boolean(records.find(record => record.id === state.id)?.exports?.length);
      if (printAfter) {
        const numberMessage = state.kind === 'facture' && !state.issuedNumber
          ? ` Le numéro ${state.invoiceNumber} sera confirmé et le suivant sera proposé pour la prochaine facture.`
          : '';
        const copyMessage = alreadyExported ? ' Une copie précédente sera conservée.' : '';
        if (!confirm(`Avant d'imprimer, l'application enregistrera ${alreadyExported ? 'une nouvelle copie du PDF' : 'le PDF'} dans :\n${pdfDirectory}.${numberMessage}${copyMessage} Continuer ?`)) return;
      } else if (alreadyExported && !confirm('Ce document a déjà été enregistré en PDF. Créer une autre copie avec le même numéro de facture, si applicable ? Le fichier précédent sera conservé.')) {
        return;
      }
      setBusy(true);
      let archivedPath = null;
      try {
        if (!await flushChanges()) return;
        setBusy(true);
        const draft = copy(state);
        const expectedInvoiceNumber = draft.kind === 'facture' ? Number(draft.invoiceNumber) : null;
        if (draft.kind === 'facture' && (!Number.isInteger(expectedInvoiceNumber) || expectedInvoiceNumber <= 0)) {
          throw new Error('Numéro de facture indisponible. Réessayez après avoir rouvert le brouillon.');
        }
        const language = englishMode ? 'en' : 'fr';
        const pdfDraft = language === 'en' ? customerDraft() : draft;
        const bytes = await createPdf(pdfDraft, { invoiceNumber: expectedInvoiceNumber, language });
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Le PDF n’a pas pu être créé.');
        const result = await runCommand('export_pdf', {
          draft, pdfBytes: Array.from(bytes), expectedInvoiceNumber, language
        });
        if (!result?.snapshot || !result?.path) throw new Error('La confirmation du PDF est incomplète.');
        archivedPath = result.path;
        state = copy(result.snapshot);
        numberEditing = false; numberConfirm = null; numberError = '';
        savedRevision = editRevision;
        try { applySnapshot(await runCommand('load_state')); }
        catch (refreshError) { notice(`PDF enregistré, mais liste non actualisée : ${errorText(refreshError)}`); }
        outputStatus = `${printAfter ? 'PDF enregistré avant impression' : 'PDF enregistré'} : ${result.path}`;
        render();
        notice(result.nameCollision
          ? `Un PDF portait déjà ce nom. Nouvelle copie : ${result.filename}. L'ancien fichier a été conservé.`
          : `PDF enregistré : ${result.path}`);
        if (printAfter) {
          setBusy(true);
          await new Promise(resolve => requestAnimationFrame(resolve));
          window.print();
        }
      } catch (error) {
        notice(archivedPath ? `PDF enregistré dans ${archivedPath}, mais impression impossible : ${errorText(error)}` : `Export non confirmé : ${errorText(error)}`);
      } finally {
        setBusy(false);
      }
    }
    async function loadState() {
      try {
        const snapshot = await runCommand('load_state');
        applySnapshot(snapshot);
        loadError = null;
        savedRevision = editRevision;
        render();
      } catch (error) {
        state = null;
        loadError = errorText(error);
        render();
      }
    }
    function closeRecent() {
      recentOpen = false;
      numberConfirm = null;
      render();
      (recentOpener && document.contains(recentOpener) ? recentOpener : document.querySelector('[data-recent]'))?.focus();
    }
    function closeFolder() {
      if (folderBusy) return;
      folderOpen = false;
      folderError = '';
      render();
      document.querySelector('[data-folder]')?.focus();
    }
    async function openAiSettings() {
      settingsOpen = true; settingsError = ''; aiSettings = null; render();
      try { aiSettings = await runCommand('get_ai_settings'); }
      catch (error) { settingsError = `Réglages indisponibles : ${errorText(error)}`; }
      render(); document.querySelector('.ai-settings-panel')?.focus();
    }
    function closeAiSettings() {
      if (settingsBusy) return;
      settingsOpen = false; settingsError = ''; render();
      document.querySelector('[data-ai-settings]')?.focus();
    }
    async function changeAiProvider(provider) {
      if (settingsBusy || !['openai', 'zai'].includes(provider)) return;
      settingsBusy = true; settingsError = '';
      try { aiSettings = await runCommand('set_ai_provider', { provider }); }
      catch (error) { settingsError = `Service inchangé : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector(`input[name="ai-provider"][value="${provider}"]`)?.focus(); }
    }
    async function saveAiKey(remove = false) {
      if (settingsBusy || !aiSettings) return;
      const provider = aiSettings.provider;
      const key = remove ? null : document.getElementById('ai-key')?.value?.trim();
      if (!remove && !key) { settingsError = 'Entrez une clé d’API avant de l’enregistrer.'; render(); return; }
      if (remove && !confirm(`Supprimer la clé ${provider === 'openai' ? 'OpenAI' : 'Z.ai'} enregistrée sur cet ordinateur ?`)) return;
      settingsBusy = true; settingsError = '';
      try {
        aiSettings = await runCommand('set_ai_key', { provider, key });
        notice(remove ? 'Clé supprimée.' : 'Clé enregistrée dans Windows.');
      } catch (error) { settingsError = `Clé inchangée : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.getElementById('ai-key')?.focus(); }
    }
    async function aiReady() {
      try {
        aiSettings = await runCommand('get_ai_settings');
        const configured = aiSettings.provider === 'openai' ? aiSettings.openaiConfigured : aiSettings.zaiConfigured;
        if (configured) return true;
        notice('Ajoutez une clé pour le service IA choisi.');
        await openAiSettings();
      } catch (error) { notice(`IA indisponible : ${errorText(error)}`); }
      return false;
    }
    const queueVoiceWork = work => {
      voiceQueue = voiceQueue.catch(() => {}).then(work);
      return voiceQueue;
    };
    async function proposeLine(style = 'prose', variation = 0) {
      const assist = lineAssist;
      if (!assist || !assist.source?.trim() || assist.processing) return;
      assist.processing = true; assist.style = style;
      assist.status = style === 'bullets' ? 'Préparation des points…' : 'Préparation du texte…';
      render();
      try {
        const proposal = await runCommand('ai_rewrite_line', { source: assist.source, style, variation });
        if (lineAssist !== assist || state.id !== assist.draftId) return;
        if (typeof proposal !== 'string' || !proposal.trim()) throw new Error('Aucun texte proposé.');
        assist.proposal = proposal.trim();
        assist.status = 'Relisez la proposition. Le texte d’origine est conservé jusqu’à votre accord.';
        assist.variation = variation;
      } catch (error) {
        if (lineAssist === assist) {
          assist.proposal ||= assist.source;
          assist.status = `IA indisponible : ${errorText(error)}. Le texte reconnu reste modifiable ici.`;
        }
      } finally {
        assist.processing = false;
        if (lineAssist === assist) render();
      }
    }
    async function enhanceLine(index) {
      if (activeCapture || voiceSession || lineAssist?.processing || lineAssist?.stopping) return;
      const source = state.items[index]?.description?.trim();
      if (!source) { notice('Écrivez d’abord une description ou utilisez le microphone.'); return; }
      if (!await aiReady()) return;
      lineAssist = { index, draftId: state.id, source, proposal: '', style: 'prose', variation: 0, status: 'Préparation du texte…', processing: false, recording: false };
      await proposeLine();
    }
    async function startLineDictation(index) {
      if (activeCapture || voiceSession || voiceRetryBusy || lineAssist?.stopping) return;
      if (!await aiReady()) return;
      englishMode = false;
      const original = state.items[index]?.description || '';
      const assist = { index, draftId: state.id, source: original, transcript: '', proposal: '', style: 'prose', variation: 0, status: 'Écoute en cours… Rappuyez sur le micro pour terminer.', processing: false, recording: true };
      lineAssist = assist; voiceQueue = Promise.resolve(); render();
      try {
        const controller = await startCapture({ segmentMs: 20000,
          onSegment: blob => queueVoiceWork(async () => {
            const audioBytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
            const result = await runCommand('ai_transcribe_audio', { audioBytes });
            if (lineAssist !== assist) return;
            if (typeof result === 'string' && result.trim()) assist.transcript += `${assist.transcript ? ' ' : ''}${result.trim()}`;
            assist.status = 'Texte entendu. Continuez à parler ou rappuyez sur le micro.';
            render();
          }),
          onError: error => { if (lineAssist === assist) {
            activeCapture = null; assist.recording = false;
            if (assist.transcript.trim()) {
              assist.source = [original, assist.transcript].filter(Boolean).join('\n');
              assist.proposal = assist.source;
              assist.status = `Dictée interrompue : ${errorText(error)}. Le texte reconnu reste modifiable ici.`;
            } else assist.status = `Microphone : ${errorText(error)}`;
            render();
          } }
        });
        if (lineAssist !== assist || !assist.recording) { await controller.cancel(); return; }
        activeCapture = controller;
      } catch (error) {
        activeCapture = null;
        assist.recording = false; assist.status = `Microphone indisponible : ${errorText(error)}`; render();
      }
    }
    async function stopLineDictation() {
      const assist = lineAssist;
      if (!assist?.recording || assist.stopping) return;
      assist.stopping = true; assist.recording = false; assist.status = 'Traitement de la dictée…'; render();
      const capture = activeCapture; activeCapture = null;
      try {
        await capture?.stop();
        await voiceQueue;
        if (lineAssist !== assist) return;
        if (!assist.transcript.trim()) throw new Error('Aucune parole reconnue. Réessayez.');
        assist.source = [state.items[assist.index]?.description, assist.transcript].filter(Boolean).join('\n');
        await proposeLine('prose', 0);
      } catch (error) { if (lineAssist === assist) {
        if (assist.transcript.trim()) {
          assist.source = [state.items[assist.index]?.description, assist.transcript].filter(Boolean).join('\n');
          assist.proposal ||= assist.source;
        }
        assist.status = `Dictée interrompue : ${errorText(error)}. ${assist.proposal ? 'Le texte reconnu reste modifiable ici.' : 'Réessayez.'}`;
        render();
      } }
      finally { assist.stopping = false; if (lineAssist === assist) render(); }
    }
    async function closeLineAssist() {
      const capture = activeCapture;
      activeCapture = null; lineAssist = null; render();
      try { await capture?.cancel(); } catch { /* The original line is untouched. */ }
    }
    async function startDocumentDictation() {
      if (activeCapture || voiceSession) return;
      if (lineAssist) { notice('Acceptez ou fermez la proposition de la ligne avant de dicter le document.'); return; }
      if (voiceRecovery) { notice('Vérifiez ou fermez les paroles déjà reconnues avant une nouvelle dictée.'); return; }
      if (!await aiReady()) return;
      englishMode = false;
      const session = createVoiceSession(state);
      voiceSession = session; voiceStatus = 'Écoute du document… Les champs apparaissent au fur et à mesure.';
      voiceQueue = Promise.resolve(); render();
      try {
        const controller = await startCapture({ segmentMs: 5000,
          onSegment: blob => queueVoiceWork(async () => {
            const audioBytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
            const transcript = await runCommand('ai_transcribe_audio', { audioBytes });
            if (voiceSession !== session || !transcript?.trim()) return;
            session.transcript += `${session.transcript ? ' ' : ''}${transcript.trim()}`;
            if (session.transcript.length > 20000) throw new Error('Dictée très longue. Arrêtez et vérifiez le document avant de continuer.');
            voiceStatus = 'Paroles reconnues. Remplissage des champs…'; render();
            const update = await runCommand('ai_extract_document', { transcript: session.transcript });
            if (voiceSession !== session || state.id !== session.draftId) return;
            const beforeVoiceUpdate = copy(state);
            if (applyVoiceUpdate(state, update, session)) {
              undoStack.push({ draft: beforeVoiceUpdate });
              if (undoStack.length > 20) undoStack.shift();
              undoGroup = null;
              markDirty(); render();
              await saveNow(true);
            }
            voiceStatus = 'Document mis à jour. Continuez à parler ou rappuyez sur le micro.'; render();
          }),
          onError: error => { if (voiceSession === session) {
            activeCapture = null; voiceSession = null;
            if (session.transcript) voiceRecovery = { session };
            voiceStatus = `Dictée interrompue : ${errorText(error)}. Les champs déjà enregistrés restent dans le brouillon.`;
            render();
          } }
        });
        if (voiceSession !== session || session.stopping) { await controller.cancel(); return; }
        activeCapture = controller;
      } catch (error) {
        activeCapture = null; voiceSession = null;
        voiceStatus = `Microphone indisponible : ${errorText(error)}`; render();
      }
    }
    async function stopDocumentDictation() {
      const session = voiceSession;
      if (!session || session.stopping) return;
      session.stopping = true;
      const capture = activeCapture; activeCapture = null;
      voiceStatus = 'Fin de dictée. Vérification des dernières paroles…'; render();
      try {
        await capture?.stop();
        await voiceQueue;
        if (!await saveNow(true)) throw new Error('Le brouillon n’a pas pu être enregistré.');
        voiceStatus = session.transcript ? 'Dictée terminée. Vérifiez les champs avant de créer le PDF.' : 'Aucune parole reconnue. Le document n’a pas été rempli par la dictée.';
        if (session.transcript && 'speechSynthesis' in window) {
          try {
            const reply = new SpeechSynthesisUtterance('J’ai rempli les informations entendues. Vérifiez le document.');
            reply.lang = 'fr-CA'; window.speechSynthesis.speak(reply);
          } catch { /* A missing voice must not invalidate a saved draft. */ }
        }
      } catch (error) {
        if (session.transcript) voiceRecovery = { session };
        voiceStatus = `Dictée interrompue : ${errorText(error)}. Vérifiez les champs déjà remplis.`;
      }
      finally { if (voiceSession === session) voiceSession = null; render(); }
    }
    async function retryDocumentVoice() {
      const session = voiceRecovery?.session;
      if (!session?.transcript || busy || voiceSession || voiceRetryBusy) return;
      if (!await aiReady()) return;
      if (voiceRecovery?.session !== session) return;
      voiceRetryBusy = true;
      voiceStatus = 'Nouvelle analyse des paroles reconnues…'; render();
      try {
        const update = await runCommand('ai_extract_document', { transcript: session.transcript });
        if (voiceRecovery?.session !== session) return;
        if (state.id !== session.draftId) throw new Error('Ce texte appartient à un autre brouillon.');
        const beforeVoiceUpdate = copy(state);
        if (applyVoiceUpdate(state, update, session)) {
          undoStack.push({ draft: beforeVoiceUpdate });
          if (undoStack.length > 20) undoStack.shift();
          undoGroup = null; markDirty(); render();
        }
        if (!await saveNow(true)) throw new Error('Le brouillon n’a pas pu être enregistré.');
        if (voiceRecovery?.session !== session) return;
        voiceRecovery = null;
        voiceStatus = 'Paroles analysées. Vérifiez les champs avant le PDF.';
      } catch (error) { if (voiceRecovery?.session === session) voiceStatus = `Analyse encore impossible : ${errorText(error)}. Le texte reconnu est conservé ci-dessous.`; }
      finally { voiceRetryBusy = false; render(); }
    }
    async function translateEnglish() {
      if (busy) return;
      if (state.englishCopy?.reviewed && !confirm('Remplacer la copie anglaise déjà vérifiée ? Elle restera dans les versions précédentes du document.')) return;
      translationError = '';
      if (!await flushChanges()) return;
      setBusy(true);
      try {
        const source = copy(state);
        const proposed = await runCommand('ai_translate_english', { draft: source });
        if (state.id !== source.id || editRevision !== savedRevision) throw new Error('Le document a changé pendant la traduction. Réessayez.');
        if (!proposed || proposed.descriptions?.length !== source.items.length) throw new Error('La traduction est incomplète. Réessayez.');
        rememberUndo();
        state.englishCopy = { sourceProject: source.project, sourceNotes: source.notes,
          sourceDescriptions: source.items.map(item => item.description),
          project: String(proposed.project ?? ''), notes: String(proposed.notes ?? ''),
          descriptions: proposed.descriptions.map(text => String(text ?? '')), reviewed: false };
        englishMode = true;
        markDirty();
        render();
        if (!await saveNow(true)) throw new Error('La copie anglaise n’a pas pu être enregistrée.');
        notice('Copie anglaise créée. Relisez-la et confirmez-la avant le PDF.');
        document.querySelector('.english-review')?.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        translationError = `Traduction impossible : ${errorText(error)}`;
        render();
      } finally { setBusy(false); }
    }
    async function chooseFolder(useDefault = false) {
      if (folderBusy) return;
      folderError = '';
      let path = null;
      if (!useDefault) {
        try { path = await pickFolder({ directory: true, multiple: false, defaultPath: pdfDirectory || undefined, title: 'Choisir le dossier des PDF' }); }
        catch {
          try { path = await pickFolder({ directory: true, multiple: false, title: 'Choisir le dossier des PDF' }); }
          catch (error) { folderError = `Impossible d'ouvrir le choix du dossier : ${errorText(error)}`; render(); return; }
        }
        if (path === null) return;
        if (typeof path !== 'string' || !path.trim()) { folderError = 'Le dossier choisi est invalide.'; render(); return; }
      }
      folderBusy = true;
      render();
      try {
        const snapshot = await runCommand('set_output_directory', { path });
        applySnapshot(snapshot, false);
        folderOpen = false;
        folderError = '';
        notice(usingDefaultDirectory ? 'Dossier des PDF par défaut rétabli.' : `Les prochains PDF seront enregistrés dans : ${pdfDirectory}`);
      } catch (error) {
        folderError = `Dossier inchangé : ${errorText(error)}`;
      } finally {
        folderBusy = false;
        render();
        document.querySelector(folderOpen ? '[data-choose-folder]' : '[data-folder]')?.focus();
      }
    }
    async function releaseUpdate(update) {
      try { await update?.close?.(); } catch { /* The installer may already have released it. */ }
    }
    function closeUpdate() {
      if (['saving', 'downloading', 'installing', 'restarting'].includes(updateStatus)) return;
      updateRequestId++;
      updateOpen = false;
      const update = availableUpdate;
      availableUpdate = null;
      void releaseUpdate(update);
      render();
      document.querySelector('.app-top [data-check-update]')?.focus();
    }
    async function checkForUpdate() {
      if (busy || !state) return;
      const requestId = ++updateRequestId;
      const previous = availableUpdate;
      availableUpdate = null;
      void releaseUpdate(previous);
      updateOpen = true;
      updateStatus = 'checking';
      updateError = '';
      updateVersion = '';
      updateDraftSaved = false;
      render();
      document.querySelector('.update-panel')?.focus();
      try {
        const found = await check({ timeout: 30_000 });
        if (requestId !== updateRequestId || !updateOpen) { await releaseUpdate(found); return; }
        if (found) {
          availableUpdate = found;
          updateVersion = String(found.version || 'inconnue');
          updateStatus = 'available';
        } else updateStatus = 'current';
      } catch (error) {
        if (requestId !== updateRequestId || !updateOpen) return;
        console.error('Update check failed', error);
        updateStatus = 'error';
        updateError = 'Impossible de vérifier les mises à jour. Vérifiez votre connexion et réessayez.';
      }
      render();
      document.querySelector(updateStatus === 'available' ? '[data-install-update]' : '.update-panel [data-close-update]')?.focus();
    }
    function showUpdateProgress() {
      const progress = document.querySelector('.update-panel progress');
      if (progress && updateTotal) {
        progress.max = updateTotal;
        progress.value = Math.min(updateDownloaded, updateTotal);
      }
      const label = document.querySelector('[data-update-progress]');
      if (label) label.textContent = updateTotal ? `${Math.min(100, Math.round(updateDownloaded / updateTotal * 100))} %` : `${Math.round(updateDownloaded / 1024)} Ko reçus`;
    }
    async function installUpdate() {
      if (busy || updateStatus !== 'available' || !availableUpdate) return;
      const update = availableUpdate;
      updateStatus = 'saving';
      render();
      setBusy(true);
      try {
        if (!await saveNow(true)) throw new Error('Brouillon non enregistré. Installation annulée.');
        updateDraftSaved = true;
        updateStatus = 'downloading';
        updateDownloaded = 0;
        updateTotal = null;
        render();
        setBusy(true);
        await update.downloadAndInstall(event => {
          if (event.event === 'Started') {
            updateTotal = Number(event.data?.contentLength) || null;
            updateDownloaded = 0;
            render();
            setBusy(true);
          } else if (event.event === 'Progress') {
            updateDownloaded += Number(event.data?.chunkLength) || 0;
            showUpdateProgress();
          } else if (event.event === 'Finished') {
            updateStatus = 'installing';
            render();
            setBusy(true);
          }
        });
        updateStatus = 'restarting';
        render();
        await relaunch();
      } catch (error) {
        console.error('Update installation failed', error);
        updateStatus = 'error';
        updateError = `${updateDraftSaved ? 'Brouillon enregistré. ' : ''}Impossible d’installer la mise à jour. Réessayez ou demandez de l’aide.`;
        availableUpdate = null;
        await releaseUpdate(update);
        setBusy(false);
        render();
        document.querySelector('.update-panel [data-check-update]')?.focus();
      }
    }
    document.addEventListener('click', async event => {
      if (event.target.dataset?.dateDisplay) { toggleCalendar(event.target.dataset.dateDisplay); return; }
      const b = event.target.closest('button');
      if (!b || b.disabled) return;
      if (b.hasAttribute('data-retry-load')) { await loadState(); return; }
      if (busy || !state) return;
      if (b.hasAttribute('data-voice')) { if (voiceSession) await stopDocumentDictation(); else await startDocumentDictation(); return; }
      if (b.dataset.lineDictate !== undefined) {
        const index = Number(b.dataset.lineDictate);
        if (lineAssist?.recording && lineAssist.index === index) await stopLineDictation();
        else await startLineDictation(index);
        return;
      }
      if (b.dataset.closeLineAssist !== undefined) { await closeLineAssist(); return; }
      if (voiceSession || voiceRetryBusy || lineAssist?.recording || lineAssist?.processing || lineAssist?.stopping) {
        notice('Terminez la dictée ou la proposition en cours avant cette action.'); return;
      }
      if (b.hasAttribute('data-ai-settings')) { await openAiSettings(); return; }
      if (b.hasAttribute('data-close-ai-settings')) { closeAiSettings(); return; }
      if (b.hasAttribute('data-save-ai-key')) { await saveAiKey(); return; }
      if (b.hasAttribute('data-remove-ai-key')) { await saveAiKey(true); return; }
      if (b.hasAttribute('data-retry-document-voice')) { await retryDocumentVoice(); return; }
      if (b.hasAttribute('data-copy-voice')) {
        const transcript = voiceRecovery?.session?.transcript;
        if (!transcript) return;
        try { await navigator.clipboard.writeText(transcript); notice('Paroles reconnues copiées.'); }
        catch { document.querySelector('.voice-recovery textarea')?.select(); notice('Texte sélectionné. Appuyez sur Ctrl+C pour le copier.'); }
        return;
      }
      if (b.hasAttribute('data-dismiss-voice')) { voiceRecovery = null; voiceStatus = ''; render(); return; }
      if (b.dataset.lineEnhance !== undefined) { await enhanceLine(Number(b.dataset.lineEnhance)); return; }
      if (b.dataset.lineStyle) { await proposeLine(b.dataset.lineStyle, 0); return; }
      if (b.hasAttribute('data-line-variation')) { if (lineAssist) await proposeLine(lineAssist.style, lineAssist.variation + 1); return; }
      if (b.hasAttribute('data-line-accept')) {
        if (lineAssist?.proposal && state.items[lineAssist.index]) {
          rememberUndo();
          state.items[lineAssist.index].description = lineAssist.proposal;
          lineAssist = null; markDirty(); render(); void saveNow();
          notice('Description acceptée.');
        }
        return;
      }
      if (b.hasAttribute('data-check-update')) { await checkForUpdate(); return; }
      if (b.hasAttribute('data-close-update')) { closeUpdate(); return; }
      if (b.hasAttribute('data-install-update')) { await installUpdate(); return; }
      if (b.dataset.calendar) { toggleCalendar(b.dataset.calendar); return; }
      if (b.hasAttribute('data-calendar-prev')) { shiftCalendar(-1); return; }
      if (b.hasAttribute('data-calendar-next')) { shiftCalendar(1); return; }
      if (b.dataset.calendarDay) { chooseDate(b.dataset.calendarDay); return; }
      if (b.hasAttribute('data-calendar-today')) { chooseDate(isoDate(new Date())); return; }
      if (b.hasAttribute('data-calendar-clear')) { chooseDate(''); return; }
      if (b.hasAttribute('data-theme')) {
        theme = theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(themeStorageKey, theme); } catch { /* Preference stays active for this session. */ }
        render();
        return;
      }
      if (b.hasAttribute('data-folder')) {
        folderError = '';
        folderOpen = true;
        render();
        document.querySelector('.folder-panel [data-choose-folder]')?.focus();
        return;
      }
      if (b.hasAttribute('data-close-folder')) { closeFolder(); return; }
      if (b.hasAttribute('data-choose-folder')) { await chooseFolder(); return; }
      if (b.hasAttribute('data-default-folder')) { await chooseFolder(true); return; }
      if (b.hasAttribute('data-translate')) { await translateEnglish(); return; }
      if (b.hasAttribute('data-show-french')) { englishMode = false; translationError = ''; render(); return; }
      if (b.hasAttribute('data-show-english')) { englishMode = true; translationError = ''; render(); return; }
      if (b.hasAttribute('data-accept-english')) {
        if (!englishCurrent() || !state.englishCopy) { notice('Actualisez la traduction après les changements en français.'); return; }
        if (state.englishCopy.descriptions.some(text => !String(text).trim()) ||
          (state.project.trim() && !state.englishCopy.project.trim()) ||
          (state.notes.trim() && !state.englishCopy.notes.trim())) {
          notice('Complétez les textes anglais avant de confirmer.'); return;
        }
        rememberUndo(); state.englishCopy.reviewed = true; markDirty(); render();
        if (await saveNow(true)) notice('Copie anglaise vérifiée et enregistrée.');
        return;
      }
      if (b.hasAttribute('data-recent')) {
        if (!await flushChanges()) return;
        recentOpener = b;
        recentOpen = true; recentQuery = ''; numberConfirm = null; render();
        document.querySelector('[data-recent-search]')?.focus();
        return;
      }
      if (b.hasAttribute('data-close-recent')) { closeRecent(); return; }
      if (b.hasAttribute('data-edit-number')) {
        if (!await flushChanges()) return;
        numberEditing = true; numberConfirm = null; numberError = '';
        render(); document.getElementById('next-number')?.focus(); return;
      }
      if (b.hasAttribute('data-close-number')) {
        numberEditing = false; numberConfirm = null; numberError = '';
        render(); document.querySelector('[data-edit-number]')?.focus(); return;
      }
      if (b.dataset.numberStep) {
        const input = document.getElementById('next-number');
        if (b.dataset.numberStep === '1') input?.stepUp(); else input?.stepDown();
        numberError = ''; input?.focus(); return;
      }
      if (b.hasAttribute('data-stage-number')) {
        const number = Number(document.getElementById('next-number')?.value);
        if (!Number.isSafeInteger(number) || number <= 0) { numberError = 'Entrez un numéro entier positif.'; render(); document.getElementById('next-number')?.focus(); return; }
        if (number === nextInvoiceNumber) { numberError = 'Ce numéro est déjà le prochain numéro.'; render(); document.getElementById('next-number')?.focus(); return; }
        numberError = '';
        numberConfirm = number;
        render(); document.querySelector('[data-apply-number]')?.focus();
        return;
      }
      if (b.hasAttribute('data-cancel-number')) { numberConfirm = null; render(); document.getElementById('next-number')?.focus(); return; }
      if (b.hasAttribute('data-apply-number')) {
        if (numberConfirm === null || !await flushChanges()) return;
        setBusy(true);
        try {
          const snapshot = await runCommand('set_next_invoice_number', { number: numberConfirm });
          applySnapshot(snapshot); numberConfirm = null; numberEditing = false; numberError = ''; render();
          document.querySelector('[data-edit-number]')?.focus();
          notice(`Prochain numéro de facture : ${nextInvoiceNumber}.`);
        } catch (error) { numberError = `Numéro inchangé : ${errorText(error)}`; numberConfirm = null; render(); document.getElementById('next-number')?.focus(); }
        finally { setBusy(false); }
        return;
      }
      if (b.dataset.openRecord) {
        if (b.dataset.openRecord === state.id) { closeRecent(); return; }
        if (!await flushChanges()) return;
        const previousId = state.id;
        if (await nativeTransition('open_draft', { id: b.dataset.openRecord }, 'Document repris.')) {
          undoStack.push({ openId: previousId }); undoGroup = null;
        }
        return;
      }
      if (b.dataset.restoreVersion) {
        if (!await flushChanges()) return;
        const previousId = state.id;
        const previousDraft = copy(state);
        if (await nativeTransition('restore_previous', { id: b.dataset.restoreVersion }, 'Version précédente restaurée.')) {
          undoStack.push(previousId === state.id ? { draft: previousDraft } : { openId: previousId }); undoGroup = null;
        }
        return;
      }
      if (b.hasAttribute('data-undo')) { await undo(); return; }
      if (b.dataset.kind) {
        if (state.kind === b.dataset.kind) return;
        if (state.issuedNumber) { notice('Cette facture est déjà émise. Créez un nouveau document pour changer de type.'); return; }
        rememberUndo();
        lineAssist = null;
        state.kind = b.dataset.kind; englishMode = false; showValidation = false; numberEditing = false; numberConfirm = null; numberError = ''; render();
        document.querySelector('.workbench')?.classList.add('switching');
        markDirty(); void saveNow();
        return;
      }
      if (b.hasAttribute('data-add')) {
        lineAssist = null;
        rememberUndo();
        state.items.push({ description: '', quantity: '1', price: '' });
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-item="${state.items.length - 1}"][data-key="description"]`)?.focus();
        return;
      }
      if (b.dataset.remove !== undefined) {
        lineAssist = null;
        rememberUndo();
        state.items.splice(Number(b.dataset.remove), 1);
        if (!state.items.length) state.items.push({ description: '', quantity: '1', price: '' });
        render(); markDirty(); void saveNow();
        return;
      }
      if (b.hasAttribute('data-save')) { if (await saveNow(true)) notice('Brouillon enregistré.'); return; }
      if (b.hasAttribute('data-reset')) {
        if (!confirm('Effacer les champs du brouillon en cours et commencer un nouveau document ? Le précédent restera dans Documents récents.')) return;
        if (!await flushChanges()) return;
        const previousId = state.id;
        if (await nativeTransition('new_draft', { kind: state.kind }, 'Nouveau brouillon vide. Le précédent reste dans Documents récents.')) {
          undoStack.push({ openId: previousId }); undoGroup = null;
        }
        return;
      }
      if (b.hasAttribute('data-pdf')) { await exportDocument(false); return; }
      if (b.hasAttribute('data-print')) { await exportDocument(true); return; }
    });
    document.addEventListener('input', event => {
      const el = event.target;
      if (el.hasAttribute('data-recent-search')) {
        recentQuery = el.value;
        const list = document.getElementById('recent-list');
        if (list) list.innerHTML = recentRows();
        return;
      }
      if (!state || busy) return;
      if (el.hasAttribute('data-assist-proposal')) {
        if (lineAssist && !lineAssist.recording && !lineAssist.processing) {
          lineAssist.proposal = el.value;
          fitTextareas(el.parentElement);
        }
        return;
      }
      if (el.hasAttribute('data-en-field') || el.hasAttribute('data-en-item')) {
        const en = state.englishCopy;
        if (!en) return;
        rememberUndo(`${state.id}:english:${el.dataset.enField ?? el.dataset.enItem}`);
        if (el.dataset.enField) en[el.dataset.enField] = el.value;
        else en.descriptions[Number(el.dataset.enItem)] = el.value;
        en.reviewed = false;
        sync(); markDirty();
        const reviewButton = document.querySelector('[data-accept-english]');
        if (reviewButton) reviewButton.textContent = 'Confirmer cette copie';
        const status = document.querySelector('.language-action small');
        if (status) status.textContent = 'Relisez et confirmez la copie anglaise avant le PDF.';
        if (el.tagName === 'TEXTAREA') fitTextareas(el.parentElement);
        return;
      }
      if (el.dataset.field) {
        rememberUndo(`${state.id}:field:${el.dataset.field}`);
        state[el.dataset.field] = el.value;
        releaseVoiceField(voiceSession, el.dataset.field);
        releaseVoiceField(voiceRecovery?.session, el.dataset.field);
      } else if (el.dataset.item !== undefined) {
        const index = Number(el.dataset.item);
        if (!state.items[index]) return;
        rememberUndo(`${state.id}:item:${index}:${el.dataset.key}`);
        state.items[index][el.dataset.key] = el.value;
        releaseVoiceItem(voiceSession, index, el.dataset.key);
        releaseVoiceItem(voiceRecovery?.session, index, el.dataset.key);
      } else return;
      sync();
      paintValidation();
      markDirty();
      if (englishMode && !englishCurrent()) {
        const status = document.querySelector('.language-action small');
        if (status) status.textContent = 'Le français a changé. La copie anglaise doit être actualisée.';
        const reviewButton = document.querySelector('[data-accept-english]');
        if (reviewButton) reviewButton.disabled = true;
      }
      if (el.tagName === 'TEXTAREA') fitTextareas(el.parentElement);
    });
    document.addEventListener('change', event => {
      const el = event.target;
      if (el.name === 'ai-provider') { void changeAiProvider(el.value); return; }
      if (!calendarField || !calendarView) return;
      if (el.hasAttribute('data-calendar-month')) {
        calendarView.month = Number(el.value);
        render(); document.querySelector('[data-calendar-month]')?.focus();
      }
      if (el.hasAttribute('data-calendar-year')) {
        const year = Number(el.value);
        if (!Number.isInteger(year) || year < 1900 || year > 2100) return;
        calendarView.year = year;
        render(); document.querySelector('[data-calendar-year]')?.focus();
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!calendarField || event.target.closest('.date-wrap')) return;
      const field = calendarField;
      calendarField = null; calendarView = null;
      document.querySelector(`[data-date-wrap="${field}"] .date-popover`)?.remove();
      document.querySelectorAll(`[data-calendar="${field}"], [data-date-display="${field}"]`).forEach(el => el.setAttribute('aria-expanded', 'false'));
    });
    document.addEventListener('focusout', event => {
      if (event.target.dataset.field || event.target.dataset.item !== undefined || event.target.dataset.enField || event.target.dataset.enItem !== undefined) {
        undoGroup = null;
        void saveNow();
      }
    });
    document.addEventListener('keydown', event => {
      if (event.target.dataset?.dateDisplay && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); toggleCalendar(event.target.dataset.dateDisplay); return;
      }
      if (event.key === 'Escape' && calendarField) {
        const field = calendarField; calendarField = null; calendarView = null;
        render(); document.querySelector(`[data-calendar="${field}"]`)?.focus(); return;
      }
      if (event.key === 'Tab' && calendarField) {
        const wrap = document.querySelector(`[data-date-wrap="${calendarField}"]`);
        const focusable = Array.from(wrap?.querySelectorAll('input, button, select') || []);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        return;
      }
       if (event.key === 'Escape' && settingsOpen) { closeAiSettings(); return; }
       if (event.key === 'Escape' && folderOpen) { closeFolder(); return; }
       if (event.key === 'Escape' && updateOpen) { closeUpdate(); return; }
       if (event.key === 'Escape' && recentOpen) { closeRecent(); return; }
       if (event.key === 'Tab' && (recentOpen || updateOpen || folderOpen || settingsOpen)) {
         const dialog = document.querySelector(settingsOpen ? '.ai-settings-panel' : folderOpen ? '.folder-panel' : updateOpen ? '.update-panel' : '.recent-panel');
        const focusable = Array.from(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || []);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow(); });
    window.addEventListener('beforeunload', () => { if (editRevision !== savedRevision) void saveNow(); });
    void loadState();
