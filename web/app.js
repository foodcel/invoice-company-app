    import { invoke } from '@tauri-apps/api/core';
    import { check } from '@tauri-apps/plugin-updater';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { open as pickFolder } from '@tauri-apps/plugin-dialog';
    import { createPdf, descriptionFitsPage } from './pdf.js';
    import { createAutomaticCorrections } from './automatic-corrections.js';
    import { createImprovementQueue } from './ai-improvement-queue.js';
    import { formatProject, formatClient, formatAddress } from './text-formatting.js';
    import './writing-controls.css';
    import { updatePdfPreview, printPdf } from './live-pdf-preview.js';
    import { enhanceSelects } from './integrated-selects.js';
    import { attachPreviewLayout } from './preview-layout.js';
    import { installModalScrollLock } from './modal-scroll.js';
    import { replaceAppMarkup, installInteractionMotion, openPanelMotion, closePanelMotion, collapseRowMotion } from './interactions.js';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { createDocumentLibrary } from './document-library.js';
    import './cleanup.css';
    import './settings.css';
    import packageInfo from '../package.json';
    import { formatPhone, formatPhoneInput } from './phone.js';
    import { openEmailComposer, openMailSettings } from './email-composer.js';
    import './email-composer.css';
    import './interactions.css';
    import { paymentRows, paymentTotal, paymentIssues } from './payments.js';
    import { noteRows, setNoteRows, noteIssues } from './client-notes.js';
    import './final-refinements.css';
    import './approved-panels.css';
    import './appearance.css';
    import './letter-preview.css';
    import './work-reversed.css';
    import './library-pdf-preview.css';
    import {hydrateLibraryPreviews} from './library-pdf-preview.js';
    import { palettes, readAppearance, appearanceTokens } from './appearance.js';
    import { updateTax, resolveTax, taxIssue, previewTaxTotals, taxLabel, taxRegistration, documentLocation, migrateEditableTax } from './taxes.js';
    import { startStreamingRecognition } from './voice-capture.js';
    import { createVoiceSession, releaseVoiceField, releaseVoiceItem, applyVoiceUpdate } from './voice-workflow.js';
    import businessCardImage from './assets/business-card-image.png';

    installModalScrollLock();
    installInteractionMotion();
    const design = { title: 'Accueil calme', subtitle: 'Un choix clair, puis le document à remplir.' };
    const today = () => isoDate(new Date());
    let state = null;
    const themeStorageKey = 'hermitage-theme';
    const initialAppearance = readAppearance(localStorage);
    let { theme, palette, tint } = initialAppearance;
    let appearanceOpen = false;
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
    let rowMotionPending = false;
    let mailOpen = false;
    let undoStack = [];
    let undoGroup = null;
    let records = [];
    let nextInvoiceNumber = null;
    let pdfDirectory = '';
    let usingDefaultDirectory = true;
    let pdfDirectories = {};
    let folderOpen = false;
    let folderBusy = false;
    let folderError = '';
    let englishMode = false;
    let translationError = '';
    let translationLoading = false;
    let settingsOpen = false;
    let preferencesOpen = false;
    let settingsBusy = false;
    let settingsError = '';
    let settingsSuccess = '';
    let aiSettings = null;
    let lineAssist = null;
    let assistMotionIndex = null, recoveryMotionText = '';
    let activeCapture = null;
    let voiceSession = null;
    let voiceRecovery = null;
    let voiceRetryBusy = false;
    let voiceQueue = Promise.resolve();
    let voiceStatus = '';
    let voiceLiveText = '';
    let loadError = null;
    let recentOpener = null;
    let updateOpen = false;
    let updateOrigin = 'startup';
    let updateStatus = 'idle';
    let updateError = '';
    let availableUpdate = null;
    let updateVersion = '';
    let updateDownloaded = 0;
    let updateTotal = null;
    let updateDraftSaved = false;
    let updateRequestId = 0;
    let startupUpdateChecked = false;
    let startupUpdatePending = false;
    let numberConfirm = null;
    let numberEditing = false;
    let numberError = '';
    let saveStatus = 'Brouillon enregistré';
    let lastSavedAt = null;
    let outputStatus = '';
    let detachPreviewLayout = () => {};
    const copy = value => JSON.parse(JSON.stringify(value));
    const writingIdentities = new Map(), descriptionLimits = new Map(), descriptionNearLimits = new Set();
    let lastDescriptionKey = null;
    let descriptionValidationRevision = 0;
    let writingSequence = 0;
    function writingIds() {
      if (!state) return {items:[],notes:[]};
      let ids = writingIdentities.get(state.id);
      if (!ids) { ids={items:[],notes:[]}; writingIdentities.set(state.id,ids); }
      for (const [key,count] of [['items',state.items.length],['notes',noteRows(state).length]]) {
        ids[key].length=Math.min(ids[key].length,count);
        while(ids[key].length<count)ids[key].push(`${key}:${++writingSequence}`);
      }
      return ids;
    }
    function writingFields() {
      if (!state) return [];
      const ids=writingIds();
      return [...state.items.map((item,index)=>({key:ids.items[index],text:item.description})),
        ...noteRows(state).map((text,index)=>({key:ids.notes[index],text}))];
    }
    function writingTarget(key) {
      const ids=writingIds(),item=ids.items.indexOf(key),note=ids.notes.indexOf(key);
      return item>=0 ? {item,element:document.querySelector(`[data-item="${item}"][data-key="description"]`)}
        : note>=0 ? {note,element:document.querySelector(`[data-note="${note}"]`)} : null;
    }
    const automatic = createAutomaticCorrections({
      getDocumentId:()=>state?.id, getFields:writingFields,
      proofread:source=>invoke('ai_proofread_text',{source}),
      write:(key,text)=>{
        const target=writingTarget(key);if(!target)return;
        if(target.item!==undefined)state.items[target.item].description=text;
        else {const entries=noteRows(state);entries[target.note]=text;setNoteRows(state,entries);}
        if(target.element)target.element.value=text;
      },
      onChange:()=>{markDirty();sync();void validateDescriptionLimits();},
      onStatus:()=>paintWritingStatus()
    });
    const improvements=createImprovementQueue({
      isCurrent:job=>state?.id===job.documentId&&writingFields().some(f=>f.key===job.key&&f.text===job.source),
      run:job=>invoke('ai_rewrite_line',{source:job.source,style:'prose',variation:0}),
      onResult:job=>{automatic.applyImprovement(job.key,job.source,job.result);},
      onStatus:()=>paintWritingStatus()
    });
    function paintWritingStatus() {
      if(!state)return;
      const status=automatic.snapshot(),queued=improvements.snapshot(state.id),button=document.querySelector('[data-undo]');
      const aiUndo=status.undoable||queued.pending||queued.errors.length;
      if(button){button.disabled=!aiUndo&&!undoStack.length;button.title=aiUndo?'Annuler toutes les corrections IA et la file, en gardant vos modifications':'Annuler la dernière modification';button.setAttribute('aria-label',button.title);}
      const output=document.querySelector('[data-writing-status]');
      if(output)output.textContent=queued.pending?`Améliorations IA : ${queued.pending} ligne${queued.pending>1?'s':''} en cours ou en attente. Vous pouvez continuer à cliquer sur les étoiles.`:queued.errors.length?'Amélioration indisponible. Recliquez sur les étoiles de la ligne pour réessayer.':status.pending?'Correction du texte…':status.errors?'Correction indisponible. Réessayez avant de créer le PDF, imprimer ou envoyer.':'';
      for(const star of document.querySelectorAll('[data-line-enhance]')) {
        const index=star.dataset.lineEnhance,note=noteIndex(index),key=note!==null?writingIds().notes[note]:writingIds().items[Number(index)];
        const field=writingFields().find(f=>f.key===key);
        const job=[...queued.jobs].reverse().find(j=>j.key===key&&(['waiting','running'].includes(j.status)||(j.status==='error'&&j.source===field?.text)||(j.status==='done'&&j.result===field?.text)));
        if(job){star.dataset.aiQueueState=job.status;star.title={waiting:'En attente dans la file IA',running:'Amélioration en cours',done:'Amélioration appliquée — Annuler en haut pour la retirer',error:'Amélioration échouée — cliquez pour réessayer'}[job.status];star.setAttribute('aria-label',star.title);}
        else {delete star.dataset.aiQueueState;star.title='Améliorer cette ligne avec l’IA';star.setAttribute('aria-label',star.title);}
        star.setAttribute('aria-busy',String(job?.status==='running'));
      }
    }
    function formatEnteredField(field) {
      const formatter={project:formatProject,client:formatClient,address:formatAddress,shipTo:formatAddress,contact:formatPhone}[field];
      if(!formatter||!state)return;
      const formatted=formatter(state[field]);
      if(formatted!==state[field]){rememberUndo();state[field]=formatted;const el=document.querySelector(`[data-field="${field}"]`);if(el)el.value=formatted;markDirty();sync();}
    }
    async function validateDescriptionLimits() {
      if(!state)return;
      const revision=++descriptionValidationRevision;
      const draft=copy(state),ids=[...writingIds().items],docId=state.id;
      for(let index=0;index<draft.items.length;index++) {
        if(revision!==descriptionValidationRevision)return;
        const source=draft.items[index].description,key=ids[index];
        const fits=await descriptionFitsPage(draft,source);
        if(revision!==descriptionValidationRevision||state?.id!==docId||writingIds().items[index]!==key||state.items[index]?.description!==source)return;
        const limited=!fits,near=limited||!(await descriptionFitsPage(draft,source+'\nFin de la phrase.'));
        if(revision!==descriptionValidationRevision||state?.id!==docId||state.items[index]?.description!==source)return;
        descriptionLimits.set(`${docId}:${key}`,limited);
        if(source.trim()&&near)descriptionNearLimits.add(`${docId}:${key}`);else descriptionNearLimits.delete(`${docId}:${key}`);
        const row=document.querySelector(`[data-item="${index}"][data-key="description"]`)?.closest('.line-entry');
        let warning=row?.nextElementSibling;
        if(!warning?.matches('[data-description-limit]'))warning=null;
        if(source.trim()&&near&&!warning&&row){warning=document.createElement('p');warning.dataset.descriptionLimit=key;warning.className='description-capacity';warning.setAttribute('role','status');row.after(warning);}
        if(warning){warning.textContent=limited?'Cette description dépasse une page. Le texte est conservé : utilisez Ajouter une ligne pour continuer sur la page suivante.':'Cette description arrive à la limite d’une page. Terminez votre phrase, puis utilisez Ajouter une ligne pour continuer.';warning.hidden=!source.trim()||!near;}
      }
    }
    async function finishWritingForOutput() {
      const id=state.id;
      for(const field of ['project','client','address','shipTo','contact'])formatEnteredField(field);
      await improvements.drain(id);
      await automatic.ensureAll();
      if(state.id!==id)throw new Error('Le document a changé. Réessayez.');
      await validateDescriptionLimits();
      if(writingIds().items.some(key=>descriptionLimits.get(`${id}:${key}`)))throw new Error('Une description dépasse une page. Utilisez Ajouter une ligne pour continuer.');
    }
    const errorText = error => String(error?.message || error || 'Erreur inconnue');
    const smallIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${({
      settings:'<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
      document:'<path d="M14 2H6v20h12V6Z M14 2v5h5M9 12h6M9 16h6"/>',
      folder:'<path d="M3 6h7l2 2h9v11H3Z"/>',
      mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
      ai:'<path d="m12 2 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z M19 16v6M16 19h6"/>',
      update:'<path d="M20 8a9 9 0 1 0 1 7M20 3v6h-6M12 7v5l3 2"/>',
      theme:'<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>'
    })[name] || ''}</svg>`;
    function appHeader() {
      return `<header class="app-top"><div class="brand"><div class="brand-mark" aria-hidden="true"></div><span>Ébénisterie de l’Hermitage inc.<small>Soumissions et factures</small></span></div><nav class="choice-row" aria-label="Documents"><button type="button" class="choice ${state.kind === 'soumission' ? 'active' : ''}" data-kind="soumission" aria-pressed="${state.kind === 'soumission'}"><span class="choice-icon">S</span><span><strong>Soumission</strong><small>Préparer un prix pour un client</small></span></button><button type="button" class="choice ${state.kind === 'facture' ? 'active' : ''}" data-kind="facture" aria-pressed="${state.kind === 'facture'}"><span class="choice-icon">F</span><span><strong>Facture</strong><small>Facturer un travail ou un produit</small></span></button><button type="button" class="choice documents-choice" data-recent><span class="choice-icon">${smallIcon('document')}</span><span><strong>Documents</strong><small>Retrouver vos documents et brouillons</small></span></button></nav><div class="top-tools"><button type="button" class="plain-button settings-trigger" data-preferences aria-expanded="${preferencesOpen || folderOpen || settingsOpen || (updateOpen && updateOrigin === 'settings')}" aria-controls="preferences-panel">${smallIcon('settings')}<span>Réglages</span></button></div></header>`;
    }
    function settingsHeader(title, id, closeAttribute, disabled = false, back = true) {
      return `<header class="settings-head"><div class="settings-heading">${back ? `<button type="button" class="settings-back" data-settings-back aria-label="Retour aux réglages" ${disabled ? 'disabled' : ''}>← Réglages</button>` : ''}<h3 class="settings-title" id="${id}">${title}</h3></div><button type="button" class="settings-close" ${closeAttribute} aria-label="Fermer les réglages" ${disabled ? 'disabled' : ''}>✕</button></header>`;
    }
    function preferencesDialog() {
      if (!preferencesOpen) return '';
      if (appearanceOpen) return `<div class="preferences-layer" data-preferences-outside><section class="preferences-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="appearance-title">${settingsHeader('Apparence', 'appearance-title', 'data-close-preferences')}<div class="settings-body appearance-options"><fieldset class="appearance-group"><legend>Mode</legend><div class="theme-choices" role="group" aria-label="Mode d’affichage">${[['light','Clair'],['dark','Sombre']].map(([value,label])=>`<button type="button" data-theme="${value}" aria-pressed="${theme===value}">${label}</button>`).join('')}</div></fieldset><fieldset class="appearance-group"><legend>Couleur</legend><div class="palette-choices">${Object.entries(palettes).map(([value,p])=>`<button type="button" class="palette-choice" data-palette="${value}" aria-pressed="${palette===value}"><i class="palette-swatch" style="--swatch:${p[theme][0]}" aria-hidden="true"></i><span>${p.label}</span></button>`).join('')}</div></fieldset><fieldset class="appearance-group"><legend>Fond des panneaux</legend><div class="theme-choices" role="group" aria-label="Intensité de la couleur">${[['soft','Doux'],['strong','Plus marqué']].map(([value,label])=>`<button type="button" data-tint="${value}" aria-pressed="${tint===value}">${label}</button>`).join('')}</div></fieldset><div class="appearance-example"><span>Aperçu — panneau et champ à remplir</span><div>Votre texte ici</div></div><p class="recent-hint">Vos choix sont enregistrés sur cet ordinateur. Les couleurs des documents PDF restent celles de l’entreprise.</p></div></section></div>`;
      return `<div class="preferences-layer" data-preferences-outside><section id="preferences-panel" class="preferences-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="preferences-title">${settingsHeader('Réglages', 'preferences-title', 'data-close-preferences', false, false)}<div class="settings-body preferences-content"><button type="button" class="preference-row appearance-row" data-appearance>${smallIcon('theme')}<span><strong>Apparence</strong><small>${palettes[palette].label} · ${theme === 'dark' ? 'Sombre' : 'Clair'} · Couleurs et contraste</small></span><span>›</span></button><button type="button" class="preference-row" data-folder>${smallIcon('folder')}<span><strong>Dossiers des PDF</strong><small>Factures et soumissions</small></span><span>›</span></button><button type="button" class="preference-row" data-mail-settings>${smallIcon('mail')}<span><strong>Courriel Outlook</strong><small>Compte, copie au comptable et signature</small></span><span>›</span></button><button type="button" class="preference-row" data-ai-settings>${smallIcon('ai')}<span><strong>Intelligence artificielle</strong><small>Connexion et abonnement ChatGPT</small></span><span>›</span></button><button type="button" class="preference-row" data-check-update>${smallIcon('update')}<span><strong>Mises à jour</strong><small>Version ${packageInfo.version} · Vérification à l’ouverture</small></span><span>›</span></button></div></section></div>`;
    }
    function closePreferences() {
      preferencesOpen = false; appearanceOpen = false; render(); document.querySelector('[data-preferences]')?.focus();
    }
    let nativeThemeApplied = null;
    function applyWindowTheme() {
      document.documentElement.style.colorScheme = theme;
      document.body.dataset.theme = theme;
      const tokens = appearanceTokens({theme,palette,tint});
      for (const [key,value] of Object.entries(tokens)) app.style.setProperty(key,value);
      document.body.style.backgroundColor = tokens['--bg'];
      if (window.__TAURI_INTERNALS__ && nativeThemeApplied !== theme) { nativeThemeApplied = theme; void getCurrentWindow().setTheme(theme).catch(error => { nativeThemeApplied = null; console.debug('Native theme unavailable', error); }); }
    }
    function applySnapshot(snapshot, replaceCurrent = true) {
      const loadingDocument = !state || state.id !== snapshot?.current?.id;
      if (!snapshot?.current || !Array.isArray(snapshot.records)) throw new Error('Réponse de stockage invalide.');
      if (state?.id !== snapshot.current.id) { englishMode = false; translationError = ''; lastSavedAt = null; }
      records = snapshot.records;
      nextInvoiceNumber = snapshot.nextInvoiceNumber;
      pdfDirectory = snapshot.pdfDirectory;
      usingDefaultDirectory = snapshot.usingDefaultDirectory;
      pdfDirectories = {
        facture: { path: snapshot.invoicePdfDirectory || snapshot.pdfDirectory, default: snapshot.usingDefaultInvoiceDirectory ?? snapshot.usingDefaultDirectory },
        soumission: { path: snapshot.quotePdfDirectory || snapshot.pdfDirectory, default: snapshot.usingDefaultQuoteDirectory ?? snapshot.usingDefaultDirectory }
      };
      if (replaceCurrent) state = copy(snapshot.current);
      else if (state?.id === snapshot.current.id) {
        state.invoiceNumber = snapshot.current.invoiceNumber;
        state.issuedNumber = snapshot.current.issuedNumber;
      }
      if (state && (!Array.isArray(state.items) || !state.items.length)) state.items = [{ description: '', quantity: '1', price: '' }];
      if (state && !Array.isArray(state.payments)) state.payments = paymentRows(state);
      if (state) {
        const entries = noteRows(state);
        setNoteRows(state, loadingDocument && entries.length === 1 && entries[0] === '' ? [] : entries);
      }
      if (state) { migrateEditableTax(state); updateTax(state); }
    }
    function runCommand(name, args) {
      const task = commandQueue.catch(() => {}).then(() => invoke(name, args));
      commandQueue = task.catch(() => {});
      return task;
    }
    function markDirty() {
      updateTax(state);
      if (!voiceSession) voiceStatus = '';
      if (englishMode && !englishCurrent()) englishMode = false;
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
      if (el) {
        el.querySelector('.save-status-announcement').textContent = message;
        el.setAttribute('aria-label', `Enregistrer le brouillon. ${message}`);
        el.title = saveTooltip();
        el.dataset.state = saveState();
      }
    }
    function saveState() {
      if (saveStatus.includes('Échec')) return 'error';
      if (saveStatus === 'Enregistrement…') return 'saving';
      return saveStatus === 'Brouillon enregistré' ? 'saved' : 'pending';
    }
    function saveTooltip() {
      const time = lastSavedAt ? ` Dernier enregistrement confirmé à ${lastSavedAt.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.` : '';
      return `Enregistrer le brouillon. Enregistrement automatique sur cet ordinateur 0,5 s après la dernière modification. État : ${saveStatus}${time}`;
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
        lastSavedAt = new Date();
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
      if (busy) return;
      const queued=improvements.snapshot(state.id);
      if (automatic.snapshot().undoable||queued.pending||queued.errors.length) {
        improvements.cancel(state.id);
        automatic.undoAll();undoGroup=null;
        await saveNow();notice('Toutes les corrections IA ont été annulées. Vos modifications sont conservées.');return;
      }
      if (!undoStack.length) return;
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
    const taxTotals = () => previewTaxTotals(state, paymentTotal(state));
    const total = () => taxTotals().subtotal;
    const gross = () => taxTotals().total;
    const deposit = () => paymentTotal(state);
    const balance = () => taxTotals().balance;
    function taxControls() {
      const tax = resolveTax(state);
      const options = [['auto','Automatique'],['ON','Ontario'],['QC','Québec']];
      return `<div class="tax-controls span2"><div class="tax-selectors"><label>Lieu du travail<select data-tax-setting="fulfillment" aria-label="Mode de travail">${[['installation','Livraison et installation'],['delivery','Livraison seulement'],['pickup','Retrait à l’atelier (Québec)']].map(([key,label])=>`<option value="${key}" ${tax.fulfillment===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Taxes<select data-tax-setting="selection" aria-label="Choix des taxes">${options.map(([key,label])=>`<option value="${key}" ${tax.selection===key?'selected':''}>${label}</option>`).join('')}</select></label></div></div>`;
    }
    function previewTaxRows(en=false) {
      const totals=taxTotals();
      return totals.lines.map(line=>`<div><span>${taxLabel(line.code,en?'en':'fr')}</span><span>${money(line.amount)}</span></div>`).join('') || `<div><span>${en?'Taxes':'Taxes'}</span><span>${en?'To confirm':'À confirmer'}</span></div>`;
    }
    const taxMoney = amount => amount===null ? (englishMode?'To confirm':'À confirmer') : money(amount);
    const kindTitle = () => state.kind === 'facture' ? 'Facture' : 'Soumission';
    const englishCurrent = () => {
      const en = state?.englishCopy;
      return Boolean(en && en.sourceProject === state.project && en.sourceNotes === state.notes &&
        Array.isArray(en.sourceDescriptions) && en.sourceDescriptions.length === state.items.length &&
        en.sourceDescriptions.every((value, index) => value === state.items[index].description) &&
        Array.isArray(en.descriptions) && en.descriptions.length === state.items.length);
    };
    const englishComplete = () => {
      if (!englishCurrent()) return false;
      const en = state.englishCopy;
      return (!state.project.trim() || Boolean(en.project.trim())) &&
        (!state.notes.trim() || Boolean(en.notes.trim())) &&
        state.items.every((item, index) => item.description.trim()
          ? Boolean(en.descriptions[index].trim()) : en.descriptions[index] === '');
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
    const paymentIndex = field => /^payment-(\d+)$/.exec(field)?.[1];
    const dateValue = field => paymentIndex(field) !== undefined ? state.payments[Number(paymentIndex(field))]?.date || '' : state[field];
    const dateName = field => paymentIndex(field) !== undefined ? `la date du paiement ${Number(paymentIndex(field)) + 1}` : dateNames[field];
    const paymentDate = iso => parseDate(iso) ? new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' }).format(parseDate(iso)) : '';
    function calendarPopover(field) {
      const view = calendarView || parseDate(dateValue(field)) || new Date();
      const year = view.year ?? view.getFullYear();
      const month = view.month ?? view.getMonth();
      const offset = (new Date(year, month, 1).getDay() + 6) % 7;
      const count = new Date(year, month + 1, 0).getDate();
      const days = Array.from({ length: count }, (_, index) => {
        const day = index + 1;
        const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
        const spoken = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'full' }).format(new Date(year, month, day));
        return `<button type="button" data-calendar-day="${iso}" aria-label="${esc(spoken)}" aria-selected="${dateValue(field) === iso}" data-today="${today() === iso}">${day}</button>`;
      }).join('');
      const months = monthNames.map((name, index) => `<option value="${index}" ${index === month ? 'selected' : ''}>${name}</option>`).join('');
      const years = Array.from({ length: 201 }, (_, index) => 1900 + index).map(option => `<option value="${option}" ${option === year ? 'selected' : ''}>${option}</option>`).join('');
      return `<div class="date-popover" role="dialog" aria-label="Choisir ${dateName(field)}"><div class="calendar-toolbar"><button type="button" data-calendar-prev aria-label="Mois précédent">‹</button><select data-calendar-month aria-label="Mois">${months}</select><select data-calendar-year aria-label="Année">${years}</select><button type="button" data-calendar-next aria-label="Mois suivant">›</button></div><div class="calendar-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(day => `<b aria-hidden="true">${day}</b>`).join('')}${'<span aria-hidden="true"></span>'.repeat(offset)}${days}</div><div class="calendar-actions"><button type="button" data-calendar-today>Aujourd’hui</button>${field === 'dueDate' || paymentIndex(field) !== undefined ? '<button type="button" data-calendar-clear>Effacer la date</button>' : ''}<button type="button" class="calendar-close" data-close-calendar aria-label="Fermer le calendrier" title="Fermer le calendrier">×</button></div></div>`;
    }
    function dateControl(field, label, span = '') {
      const open = calendarField === field;
      return `<div class="${span} date-wrap" data-date-wrap="${field}"><label for="date-${field}">${label}</label><div class="date-shell"><input id="date-${field}" data-field="${field}" data-date-display="${field}" type="text" readonly value="${esc(displayDate(state[field]))}" placeholder="Choisir une date" aria-haspopup="dialog" aria-expanded="${open}"><button type="button" class="date-trigger" data-calendar="${field}" aria-label="Choisir ${dateNames[field]}" title="Ouvrir le calendrier" aria-expanded="${open}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 18h2"></path></svg></button></div>${open ? calendarPopover(field) : ''}</div>`;
    }
    function toggleCalendar(field) {
      if (calendarField === field) { calendarField = null; calendarView = null; render(); return; }
      const initial = parseDate(dateValue(field)) || new Date();
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
      if (dateValue(field) !== iso) {
        rememberUndo();
        if (paymentIndex(field) !== undefined) state.payments[Number(paymentIndex(field))].date = iso;
        else state[field] = iso;
      }
      calendarField = null; calendarView = null;
      render(); markDirty(); void saveNow();
      document.querySelector(`[data-calendar="${field}"]`)?.focus();
    }
    function paymentsControl() {
      const invoice = state.kind === 'facture';
      return `<div class="span2 payment-fields payment-card"><div class="payment-card-head payment-labels"><span>Montant ($)</span><span>Date</span><span aria-hidden="true"></span></div><div class="payment-card-body"><div class="payment-list">${state.payments.map((payment, index) => {
        const field = `payment-${index}`, open = calendarField === field;
        return `<div class="payment-entry date-wrap" data-date-wrap="${field}"><div class="payment-shell"><div class="payment-amount"><input data-payment="${index}" aria-label="Montant du paiement ${index + 1}" inputmode="decimal" value="${esc(payment.amount)}" placeholder="Montant"><span>$</span></div><div class="date-shell payment-date-shell"><input type="text" readonly data-date-display="${field}" aria-label="${dateName(field)}" aria-haspopup="dialog" aria-expanded="${open}" value="${esc(displayDate(payment.date))}" placeholder="Choisir une date"><button type="button" class="date-trigger payment-date" data-calendar="${field}" aria-label="Choisir ${dateName(field)}${payment.date ? ' : ' + esc(paymentDate(payment.date)) : ''}" title="Choisir la date" aria-haspopup="dialog" aria-expanded="${open}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 18h2"/></svg></button></div></div><button type="button" class="payment-remove" data-remove-payment="${index}" aria-label="Retirer le paiement ${index + 1}" title="Retirer ce paiement"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg></button>${open ? calendarPopover(field) : ''}</div>`;
      }).join('')}</div><button type="button" class="add-button" data-add-payment>+ Ajouter ${invoice ? 'un paiement' : 'un dépôt'}</button><div class="payment-total"><span>${invoice ? 'Total reçu' : 'Total des dépôts'}</span><strong data-preview="deposit">${money(deposit())}</strong></div></div></div>`;
    }
    function paymentBreakdown() {
      const en = englishMode, invoice = state.kind === 'facture';
      const rows = paymentRows(state).filter(payment => value(payment.amount) > 0);
      if (!rows.length) return '';
      const title = en ? (invoice ? 'Payments received' : 'Deposits requested') : (invoice ? 'Paiements reçus' : 'Dépôts demandés');
      return `<b>${title}</b>${rows.map(payment => `<div class="payment-detail"><span>${esc(displayDate(payment.date) || (en ? 'Date not specified' : 'Date non précisée'))}</span><strong>${money(value(payment.amount))}</strong></div>`).join('')}`;
    }
    const input = (field, label, placeholder = '', type = 'text', span = '') => type === 'date' ? dateControl(field, label, span) : `<label class="${span}">${label}<input data-field="${field}" type="${type}" value="${esc(field === 'contact' ? formatPhone(state[field]) : state[field])}" placeholder="${esc(placeholder)}" ${field === 'client' ? 'required' : ''}></label>`;
    const textArea = (field, label, placeholder = '', span = '', rows = 2) => `<label class="${span}">${label}<textarea data-field="${field}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(state[field] || '')}</textarea></label>`;
    const fieldArrow = direction => `<svg class="field-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="${direction==='up-right'?'M4 18h14V4m-4 4 4-4 4 4':'M20 6H6v14m-4-4 4 4 4-4'}"/></svg>`;
    const row = (item, i) => `<div class="line-entry compact-work"><div class="line-body"><label for="line-description-${i}" class="sr-only">Description de la ligne ${i+1}</label><textarea id="line-description-${i}" data-item="${i}" data-key="description" rows="2" placeholder="Décrivez les travaux, matériaux ou étapes en détail">${esc(item.description)}</textarea><div class="work-labels" aria-hidden="true"><div class="first-labels"><span class="description-label">Description${fieldArrow("up-right")}</span><span class="price-label">${fieldArrow("down-left")}Prix unitaire</span></div><span class="quantity-label">${fieldArrow("down-left")}Qté</span><span class="amount-label">${fieldArrow("down-left")}Montant</span></div><div class="work-metrics"><span class="line-number" aria-label="Ligne ${i+1}">${i+1}</span><label class="work-price"><span class="sr-only">Prix unitaire de la ligne ${i+1}</span><span class="line-input-shell"><input data-item="${i}" data-key="price" aria-label="Prix unitaire de la ligne ${i+1}" value="${esc(item.price)}" inputmode="decimal" placeholder="0,00"></span></label><label class="work-quantity"><span class="sr-only">Quantité de la ligne ${i+1}</span><span class="line-input-shell"><input data-item="${i}" data-key="quantity" aria-label="Quantité de la ligne ${i+1}" value="${esc(item.quantity)}" inputmode="decimal" placeholder="1"><span class="quantity-steps"><button type="button" data-quantity-step="1" data-line="${i}" aria-label="Augmenter la quantité de la ligne ${i+1}" title="Augmenter la quantité"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button><button type="button" data-quantity-step="-1" data-line="${i}" aria-label="Diminuer la quantité de la ligne ${i+1}" title="Diminuer la quantité"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></span></span></label><strong class="line-amount" data-row-total="${i}">${money(value(item.quantity)*value(item.price))}</strong></div></div><div class="line-header-actions work-tool-rail"><button type="button" class="remove-line" data-remove="${i}" aria-label="Retirer la ligne ${i+1}" title="Retirer cette ligne"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg></button><button type="button" class="line-dictate" aria-label="Dicter cette ligne" title="Dicter cette ligne"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg></button><button type="button" class="line-enhance" aria-label="Améliorer cette ligne" title="Améliorer cette ligne">${smallIcon('ai')}</button></div></div>`;
    function fitTextareas(root = document) {
      root.querySelectorAll('textarea').forEach(el => {
        if(el.closest('.compact-work,.notes-entry')) { el.style.removeProperty('height'); return; }
        el.style.height = 'auto';
        el.style.height = Math.max(el.scrollHeight + 2, el.dataset.key === 'description' ? 68 : 45) + 'px';
      });
    }
    function preview() {
      const view = customerDraft();
      const en = englishMode && Boolean(state.englishCopy);
      const location = documentLocation(state,en?'en':'fr');
      const footerIds = taxRegistration(resolveTax(state).province,en?'en':'fr').map(text=>`<span>${text}</span>`).join('');
      const invoice = state.kind === 'facture';
      const number = invoice ? `<small>${en ? 'Invoice no.' : 'Facture n°'} <span data-preview="invoiceNumber">${state.invoiceNumber ?? '—'}</span></small>` : '';
      const dateLabel = invoice ? (en ? 'Payment due' : 'Date limite de paiement') : (en ? 'Valid until' : 'Valide jusqu’au');
      const dateField = invoice ? 'dueDate' : 'validUntil';
      const hasDeposit = deposit() > 0;
      const totals = `<div class="paper-totals">
        <div><span>${en ? 'Subtotal' : 'Sous-total'}</span><span data-preview="subtotal">${money(total())}</span></div>
        <div class="preview-tax-lines" data-preview-tax-lines>${previewTaxRows(en)}</div>
        <div class="grand"><span>${en ? 'Total including taxes' : 'Total avec taxes'}</span><span data-preview="gross">${taxMoney(gross())}</span></div>
        <div data-deposit-row ${hasDeposit ? '' : 'hidden'}><span>${en ? (invoice ? 'Total received' : 'Total deposits') : (invoice ? 'Total reçu' : 'Total des dépôts')}</span><span data-preview="deposit">${money(deposit())}</span></div>
        <div class="balance" data-deposit-row ${hasDeposit ? '' : 'hidden'}><span>${en ? (invoice ? 'Balance due' : 'Balance after deposit') : 'Balance'}</span><span data-preview="balance">${taxMoney(balance())}</span></div>
      </div>`;
      return `<div class="paper doc1">
        <div class="paper-top"><div class="paper-logo"><div class="paper-mark" aria-hidden="true"><img src="${businessCardImage}" alt="" width="374" height="339"></div><div class="paper-name"><strong>ÉBÉNISTERIE</strong><small>DE L'HERMITAGE INC.</small></div></div><div class="paper-type">${en ? (invoice ? 'Invoice' : 'Quote') : kindTitle()}${number}</div></div>
        <div class="doc1-summary"><div><b>${en ? 'Project' : 'Projet'}</b><strong class="project-name" data-preview="project">${esc(view.project || (en ? 'Project name' : 'Nom du projet'))}</strong></div><div><b>${en ? 'Document date' : 'Date du document'}</b><span data-preview="date">${esc(displayDate(state.date))}</span></div><div><b>${dateLabel}</b><span data-preview="${dateField}">${esc(displayDate(state[dateField]) || (invoice ? (en ? 'None' : 'Aucune') : ''))}</span></div></div>
        <div class="doc1-parties"><div class="doc1-party"><b>${en ? (invoice ? 'Bill to' : 'Prepared for') : (invoice ? 'Facturé à' : 'Proposition pour')}</b><strong data-preview="client">${esc(state.client || (en ? 'Client name' : 'Nom du client'))}</strong><p><span data-preview="address">${esc(state.address || (en ? 'Billing address' : 'Adresse de facturation'))}</span><span data-phone-block ${state.contact?.trim() ? '' : 'hidden'}><br>${en ? 'Tel.' : 'Tél.'} <span data-preview="contact">${esc(formatPhone(state.contact))}</span></span><span data-email-block ${state.email?.trim() ? '' : 'hidden'}><br>${en ? 'Email' : 'Courriel'} : <span data-preview="email">${esc(state.email || '')}</span></span></p><div class="doc1-ship" data-shipping-block ${location.address.trim() ? '' : 'hidden'}><b data-shipping-label>${esc(location.label)}</b><span data-preview="shipTo">${esc(location.address)}</span></div></div><div class="doc1-party"><b>${en ? 'Issued by' : 'Émis par'}</b><strong>Ébénisterie de l’Hermitage inc.</strong><p>68, chemin des guides<br>Ripon (Qc) J0V 1V0<br>(819) 428-7690</p></div></div>
        <table class="paper-table"><thead><tr><th>${en ? 'Description' : 'Description'}</th><th>${en ? 'Qty' : 'Qté'}</th><th>${en ? 'Unit price' : 'Prix unitaire'}</th><th>${en ? 'Amount' : 'Montant'}</th></tr></thead><tbody id="previewRows"></tbody></table>
        <div class="doc1-closing"><div class="doc1-extras"><div class="doc1-note" data-notes-block ${view.notes?.trim() ? '' : 'hidden'}><b>${en ? 'Note to client' : 'Note pour le client'}</b><p data-preview="notes">${esc(view.notes || '')}</p></div><div class="doc1-payments" data-payment-breakdown ${hasDeposit ? '' : 'hidden'}>${paymentBreakdown()}</div></div>${totals}</div>
        <div class="doc1-footer">${footerIds}</div></div><p class="preview-caption">${en ? 'English customer copy' : 'Aperçu du document'} · format Lettre</p>`;
    }
    function pdfIssues() {
      const issues = [];
      const taxError=taxIssue(state); if(taxError)issues.push({selector:'[data-tax-setting="selection"]',label:taxError});
      const add = (selector, label) => issues.push({ selector, label });
      if (!parseDate(state.date)) add('[data-field="date"]', 'Date du document');
      if (state.kind === 'soumission' && !parseDate(state.validUntil)) add('[data-field="validUntil"]', 'Date de validité');
      if (state.dueDate && !parseDate(state.dueDate)) add('[data-field="dueDate"]', 'Date limite de paiement');
      if (!state.project.trim()) add('[data-field="project"]', 'Nom du projet');
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
      for (const issue of paymentIssues(state)) add(issue.field === 'date' ? `[data-calendar="payment-${issue.index}"]` : `[data-payment="${issue.index}"]`, issue.message);
      return issues;
    }
    function paintValidation() {
      const issues = showValidation ? pdfIssues() : [];
      const panel = document.getElementById('pdf-validation');
      if (panel) {
        panel.hidden = !issues.length;
        panel.innerHTML = issues.length ? `<strong>À compléter avant de continuer</strong><ul>${issues.map(issue => `<li>${esc(issue.label)}</li>`).join('')}</ul>` : '';
      }
      document.querySelectorAll('[aria-invalid="true"]').forEach(field => field.removeAttribute('aria-invalid'));
      issues.forEach(issue => document.querySelector(issue.selector)?.setAttribute('aria-invalid', 'true'));
      return issues;
    }
    const documentLibrary = createDocumentLibrary({
      getRecords: () => records, getState: () => state, command: runCommand,
      transition: libraryTransition, flush: flushChanges, logo: businessCardImage, notice,
      render: () => { recentOpen = documentLibrary.isOpen; render(); }
    });
    async function libraryTransition(name, args, message) {
      const success = await nativeTransition(name, args, message);
      if (success) { undoStack = []; undoGroup = null; render(); }
      return success;
    }
    function recentDialog() { return documentLibrary.html(); }
    function paintVoiceUi() {
      if(!lineAssist)assistMotionIndex=null;
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
      const statusAnchor = document.querySelector('.section-head');
      if (statusAnchor) {
        const recovery = voiceRecovery?.session?.transcript;
        statusAnchor.insertAdjacentHTML('afterend', `${voiceStatus ? `<p class="voice-status" role="status" aria-live="polite">${esc(voiceStatus)}</p>` : ''}${voiceSession ? `<div class="voice-live" aria-label="Paroles reconnues pendant la dictée"><strong>Ce que j’entends</strong><p data-live-transcript aria-live="polite">${esc(voiceLiveText || 'Parlez maintenant…')}</p></div>` : ''}${recovery ? `<div class="voice-recovery" role="alert"><strong>Paroles reconnues à vérifier</strong><p>L’analyse a échoué. Votre texte reconnu reste disponible ici.</p><textarea readonly rows="3" aria-label="Paroles reconnues">${esc(recovery)}</textarea><div><button type="button" class="plain-button" data-retry-document-voice ${voiceRetryBusy ? 'disabled' : ''}>Réessayer le remplissage</button><button type="button" class="plain-button" data-copy-voice ${voiceRetryBusy ? 'disabled' : ''}>Copier le texte</button><button type="button" class="plain-button" data-dismiss-voice ${voiceRetryBusy ? 'disabled' : ''}>Fermer</button></div></div>` : ''}`);
      }
      document.querySelectorAll('.line-entry').forEach((entry, index) => {
        const recovery=voiceRecovery?.session?.transcript||'';
        if(recovery && recovery!==recoveryMotionText)openPanelMotion(document.querySelector('.voice-recovery'));
        recoveryMotionText=recovery;
        const dictate = entry.querySelector('.line-dictate');
        const enhance = entry.querySelector('.line-enhance');
        dictate.disabled = false; enhance.disabled = false;
        dictate.dataset.lineDictate = String(index);
        enhance.dataset.lineEnhance = String(index);
        dictate.setAttribute('aria-label', `Dicter la ligne ${index + 1}`);
        enhance.setAttribute('aria-label', `Améliorer la ligne ${index + 1} avec l’IA`);
        paintLineAssist(entry, lineAssist?.index === index ? lineAssist : null,
          entry.querySelector('textarea[data-key="description"]'), dictate, entry.querySelector('.remove-line'));
      });
      document.querySelectorAll('.notes-entry').forEach((notes, index) => {
        const key = index === 0 ? 'notes' : `notes:${index}`;
        paintLineAssist(notes, lineAssist?.index === key ? lineAssist : null,
          notes.querySelector('textarea'), notes.querySelector('[data-line-dictate]'), notes.querySelector('[data-remove-note]'));
      });
    }
    function paintLineAssist(entry, assist, textarea, dictate, close) {
        if (!assist) return;
        dictate.disabled = Boolean(assist.stopping || assist.processing);
        entry.classList.toggle('line-recording', Boolean(assist.recording));
        dictate.setAttribute('aria-pressed', String(Boolean(assist.recording)));
        dictate.setAttribute('aria-label', assist.recording ? 'Arrêter la dictée' : noteIndex(assist.index) !== null ? 'Dicter la note pour le client' : `Dicter la ligne ${assist.index + 1}`);
        dictate.title = assist.recording ? 'Arrêter la dictée' : noteIndex(assist.index) !== null ? 'Dicter la note' : 'Dicter cette ligne';
        close.removeAttribute('data-remove');
        close.removeAttribute('data-remove-note');
        close.disabled = false;
        close.hidden = false;
        close.dataset.closeLineAssist = String(assist.index);
        close.setAttribute('aria-label', 'Fermer la proposition');
        close.title = 'Fermer la proposition';
        if (textarea) {
          textarea.removeAttribute('data-item');
          textarea.removeAttribute('data-field');
          textarea.removeAttribute('data-note');
          if (assist.proposal && !assist.recording && !assist.processing && !assist.stopping) {
            textarea.dataset.assistProposal = '';
            textarea.value = assist.proposal;
          } else {
            textarea.readOnly = true;
            if (assist.recording) textarea.value = [assist.original, assist.transcript].filter(Boolean).join('\n');
          }
        }
        const review = document.createElement('div');
        review.className = 'line-review';
        review.innerHTML = `<p class="line-review-status" role="status">${esc(assist.status)}</p>${assist.proposal && !assist.recording && !assist.processing && !assist.stopping ? `<div class="line-review-styles"><button type="button" data-line-style="prose" aria-pressed="${assist.style === 'prose'}">Texte clair</button><button type="button" data-line-style="bullets" aria-pressed="${assist.style === 'bullets'}">Liste à puces</button><button type="button" data-line-variation>Autre version</button></div><div class="line-review-actions"><button type="button" class="line-accept" data-line-accept>Accepter</button></div>` : ''}`;
        textarea?.insertAdjacentElement('afterend', review);
        if(assistMotionIndex!==assist.index){openPanelMotion(review);assistMotionIndex=assist.index;}
    }
    function folderDialog() {
      if (!folderOpen) return '';
      return `<div class="recent-backdrop"><div class="recent-panel folder-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="folder-title" aria-describedby="folder-help" tabindex="-1">${settingsHeader('Dossiers des PDF', 'folder-title', 'data-close-folder', folderBusy)}<div class="settings-body"><p id="folder-help" class="recent-hint">Créer le PDF et envoyer par courriel enregistrent une copie dans le dossier de son type. Imprimer n’enregistre aucun PDF. Les fichiers déjà enregistrés restent à leur place.</p>${['facture', 'soumission'].map(kind => `<section class="folder-kind"><div class="folder-current"><strong>${kind === 'facture' ? 'Factures' : 'Soumissions'}${pdfDirectories[kind]?.default ? ' · par défaut' : ''}</strong><span>${esc(pdfDirectories[kind]?.path || '')}</span></div><div class="folder-actions"><button type="button" class="primary" data-choose-folder data-folder-kind="${kind}" ${folderBusy ? 'disabled' : ''}>Choisir un dossier…</button><button type="button" class="plain-button" data-default-folder data-folder-kind="${kind}" ${folderBusy || pdfDirectories[kind]?.default ? 'disabled' : ''}>Dossier par défaut</button></div></section>`).join('')}${folderError ? `<p class="folder-error" role="alert">${esc(folderError)}</p>` : ''}</div></div></div>`;
    }
    function aiSettingsDialog() {
      if (!settingsOpen) return '';
      if (!aiSettings) return `<div class="recent-backdrop"><div class="recent-panel ai-settings-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" tabindex="-1">${settingsHeader('Réglages de l’IA', 'ai-settings-title', 'data-close-ai-settings', settingsBusy)}<div class="settings-body"><p>${settingsError ? esc(settingsError) : 'Chargement des réglages…'}</p></div></div></div>`;
      const provider = aiSettings.provider;
      const business = provider === 'business';
      const activeConfigured = business ? aiSettings.businessConfigured : provider === 'chatgpt' && aiSettings.chatgptConfigured;
      const disabled = settingsBusy ? 'disabled' : '';
      return `<div class="recent-backdrop"><div class="recent-panel ai-settings-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" tabindex="-1">
        ${settingsHeader('Réglages de l’IA', 'ai-settings-title', 'data-close-ai-settings', settingsBusy)}<div class="settings-body">
        <p class="recent-hint">Choisissez le compte utilisé pour rédiger, améliorer et traduire vos documents.</p>
        <fieldset class="provider-choices"><legend>Votre service</legend>
          <label><input type="radio" name="ai-provider" value="chatgpt" ${provider === 'chatgpt' ? 'checked' : ''} ${disabled}> <span><strong>ChatGPT Sub</strong><small>Abonnement personnel</small></span></label>
          <label><input type="radio" name="ai-provider" value="business" ${business ? 'checked' : ''} ${disabled}> <span><strong>ChatGPT Business</strong><small>Espace de travail</small></span></label>
        </fieldset>
        <section class="ai-account"><div class="ai-account-heading"><strong>${business ? 'ChatGPT Business' : 'ChatGPT Sub'}</strong><span class="ai-connection ${activeConfigured ? 'connected' : ''}">${aiSettings.authPending ? 'En attente' : activeConfigured ? 'Connecté' : 'Non connecté'}</span></div>
        ${business ? `<p class="settings-note">Utilise un jeton d’accès Codex créé dans votre espace ChatGPT Business, selon ses autorisations et limites.</p>
        <p class="settings-note">Dans ChatGPT : Paramètres de l’espace → Access tokens → Create. Choisissez Codex si des portées sont proposées. Collez le jeton ci-dessous, uniquement sur cet ordinateur.</p>
        <label for="ai-key">${activeConfigured ? 'Remplacer le ' : 'Ajouter le '}jeton Business<input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="Jeton d’accès Codex de l’espace Business" ${disabled}></label>
        <div class="folder-actions"><button type="button" class="primary" data-save-ai-key ${disabled}>Enregistrer le jeton</button>${activeConfigured ? `<button type="button" class="plain-button" data-test-ai ${disabled}>Tester la connexion</button><button type="button" class="plain-button" data-remove-ai-key ${disabled}>Supprimer</button>` : ''}</div>` : `<p class="settings-note">Connectez votre compte ChatGPT pour utiliser votre abonnement Pro / personnel.</p>
        ${aiSettings.authPending ? '<p class="settings-note" role="status">Connexion en attente. Terminez la connexion dans le navigateur, puis actualisez ici.</p>' : ''}
        <div class="folder-actions"><button type="button" class="primary" data-start-chatgpt-login ${settingsBusy || aiSettings.authPending ? 'disabled' : ''}>Se connecter à ChatGPT</button>${aiSettings.authPending ? `<button type="button" class="plain-button" data-refresh-ai-settings ${disabled}>Actualiser la connexion</button><button type="button" class="plain-button" data-cancel-chatgpt-login ${disabled}>Annuler la connexion</button>` : ''}${activeConfigured ? `<button type="button" class="plain-button" data-test-ai ${disabled}>Tester la connexion</button>` : ''}${activeConfigured || aiSettings.authError ? `<button type="button" class="plain-button" data-disconnect-chatgpt ${disabled}>Déconnecter ChatGPT</button>` : ''}</div>`}
        </section><p class="settings-note ai-privacy">${settingsBusy ? 'Traitement en cours… ' : ''}Identifiants protégés dans le coffre de Windows. Le test utilise trois demandes d’exemple.</p><details class="ai-information"><summary>À propos de la dictée et des services</summary><p class="settings-note">Le microphone est transcrit localement avec Nemotron 3.5. Le texte reconnu est ensuite envoyé au service choisi.</p><p class="settings-note">Z.ai et Claude : connexion par abonnement non disponible dans cette version.</p></details>
        ${settingsSuccess ? `<p class="settings-success" role="status">${esc(settingsSuccess)}</p>` : ''}
        ${settingsError || aiSettings.authError ? `<p class="translation-error" role="status">${esc(settingsError || aiSettings.authError)}</p>` : ''}
      </div></div></div>`;
    }
    function invoiceNumberControl() {
      if (state.kind !== 'facture') return '';
      const issued = Boolean(state.issuedNumber);
      const used = numberConfirm !== null && records.some(record => record.draft.issuedNumber === numberConfirm);
      const older = numberConfirm !== null && numberConfirm < nextInvoiceNumber;
      const warning = used
        ? `La facture n° ${numberConfirm} existe déjà. Vous pouvez réutiliser ce numéro pour ${issued ? 'une nouvelle facture' : 'ce brouillon'}. L’ancien PDF restera intact; la nouvelle copie aura un nom de fichier distinct.`
        : older ? `Le n° ${numberConfirm} deviendra le nouveau point de départ des factures. Après sa création en PDF, la prochaine facture sera le n° ${numberConfirm + 1}. Les anciennes factures restent intactes.` : '';
      const editValue = numberConfirm ?? (issued ? nextInvoiceNumber : state.invoiceNumber) ?? '';
      const editRow = `<label class="number-prefix" for="next-number">N°</label><input id="next-number" name="number" type="number" min="1" step="1" value="${esc(editValue)}" required ${numberConfirm === null ? '' : 'readonly'} aria-label="${issued ? 'Numéro de la prochaine facture' : 'Numéro de cette facture'}">${numberConfirm === null ? '<button type="button" class="number-step" data-number-step="-1" aria-label="Diminuer le numéro de facture">−</button><button type="button" class="number-step" data-number-step="1" aria-label="Augmenter le numéro de facture">+</button><button type="button" class="number-apply" data-stage-number>OK</button>' : '<button type="button" class="number-step" data-cancel-number aria-label="Annuler la confirmation">×</button>'}`;
      const viewRow = `<span class="number-prefix">N°</span><strong class="number-value" data-preview="invoiceNumber">${state.invoiceNumber ?? '—'}</strong><div class="number-quick-controls"><button type="button" data-quick-number-step="-1" aria-label="Diminuer le numéro de la prochaine facture" title="Diminuer le numéro" ${numberConfirm !== null || (issued ? nextInvoiceNumber : state.invoiceNumber) <= 1 ? 'disabled' : ''}>−</button><button type="button" data-quick-number-step="1" aria-label="Augmenter le numéro de la prochaine facture" title="Augmenter le numéro" ${numberConfirm !== null ? 'disabled' : ''}>+</button><button type="button" class="number-edit" data-edit-number aria-label="${issued ? 'Régler le numéro de la prochaine facture' : 'Modifier le numéro de facture'}" title="Modifier le numéro">✎</button></div>`;
      return `<div class="invoice-number"><div class="number-row">${numberEditing ? editRow : viewRow}</div>${numberConfirm !== null ? `<div class="number-popover" role="group" aria-label="Confirmer le numéro"><p class="number-warning" role="alert">${esc(warning)}</p><div><button type="button" class="primary" data-apply-number>Confirmer</button><button type="button" class="plain-button" data-cancel-number>Annuler</button></div></div>` : numberError ? `<div class="number-popover number-error" role="alert">${esc(numberError)}</div>` : ''}</div>`;
    }
    function languageControls() {
      return `<div class="language-panel" role="group" aria-label="Langue du PDF"><button type="button" data-show-french aria-pressed="${!englishMode}" class="${englishMode ? '' : 'active'}">Français</button><button type="button" data-show-english aria-pressed="${englishMode}" aria-busy="${translationLoading}" class="${englishMode ? 'active' : ''}">${translationLoading ? 'English…' : 'English'}</button></div>`;
    }
    function notesControl() {
      const entries = noteRows(state);
      const mic = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>';
      const sparkle = smallIcon('ai');
      const cross = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
      return `<section class="notes-card span2" aria-label="Notes pour le client"><div class="notes-card-body"><div class="notes-list">${entries.map((note,index) => {
        const key = index === 0 ? 'notes' : `notes:${index}`, id = index === 0 ? 'client-notes' : `client-notes-${index}`;
        return `<div class="notes-entry" data-note-entry="${index}"><div class="note-body"><label class="sr-only" for="${id}">Note ${index+1}</label><textarea id="${id}" ${index===0?'data-field="notes"':''} data-note="${index}" rows="2" placeholder="Écrivez une note pour le client">${esc(note)}</textarea></div><div class="notes-tools"><button type="button" data-remove-note="${index}" aria-label="Retirer la note ${index+1}" title="Retirer cette note">${cross}</button><button type="button" data-line-dictate="${key}" aria-label="Dicter la note ${index+1}" aria-pressed="false" title="Dicter cette note">${mic}</button><button type="button" data-line-enhance="${key}" aria-label="Améliorer la note ${index+1} avec l’IA" title="Améliorer cette note">${sparkle}</button></div></div>`;
      }).join('')}</div><button type="button" class="add-button" data-add-note>+ Ajouter une note</button></div></section>`;
    }
    function updateDialog() {
      if (!updateOpen) return '';
      const active = ['saving', 'downloading', 'installing', 'restarting'].includes(updateStatus);
      let detail = '';
      if (updateStatus === 'checking') detail = '<p>Recherche d’une mise à jour…</p>';
      else if (updateStatus === 'current') detail = '<p>Votre application est à jour.</p>';
      else if (updateStatus === 'available') detail = `<p>La version <strong>${esc(updateVersion)}</strong> est disponible.</p><p class="update-hint">Voulez-vous mettre l’application à jour maintenant ? Votre brouillon sera enregistré avant l’installation.</p>`;
      else if (updateStatus === 'saving') detail = '<p>Enregistrement du brouillon avant l’installation…</p>';
      else if (updateStatus === 'downloading') detail = `<p>Brouillon enregistré. Téléchargement de la version ${esc(updateVersion)}…</p>${updateTotal ? `<progress max="${updateTotal}" value="${updateDownloaded}" aria-label="Téléchargement de la mise à jour"></progress><small data-update-progress>${Math.min(100, Math.round(updateDownloaded / updateTotal * 100))} %</small>` : '<progress aria-label="Téléchargement de la mise à jour"></progress><small data-update-progress>Téléchargement en cours…</small>'}`;
      else if (updateStatus === 'installing') detail = '<p>Téléchargement terminé. L’installation démarre…</p>';
      else if (updateStatus === 'restarting') detail = '<p>Installation lancée. Redémarrage de l’application…</p>';
      else if (updateStatus === 'error') detail = `<p class="update-error" role="alert">${esc(updateError)}</p>`;
      if (updateOrigin === 'settings') return `<div class="recent-backdrop settings-update-backdrop"><section class="recent-panel update-panel settings-pane" role="dialog" aria-modal="true" aria-labelledby="update-title" tabindex="-1">${settingsHeader('Mises à jour', 'update-title', 'data-close-update', active)}<div class="settings-body"><section class="settings-update-version"><strong>Version ${packageInfo.version}</strong><p class="settings-note">La recherche de mises à jour se fait automatiquement à l’ouverture.</p></section><div id="update-detail" class="update-detail" role="status" aria-live="polite">${detail}</div><div class="update-actions">${updateStatus === 'available' ? '<button type="button" class="primary" data-install-update>Mettre à jour maintenant</button>' : ''}${['current', 'error'].includes(updateStatus) ? '<button type="button" class="plain-button" data-check-update>Vérifier à nouveau</button>' : ''}</div></div></section></div>`;
      return `<div class="recent-backdrop update-backdrop"><div class="recent-panel update-panel" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-detail" tabindex="-1"><div class="recent-head"><h3 id="update-title">${updateStatus === 'available' ? 'Nouvelle mise à jour disponible' : 'Mises à jour'}</h3><button type="button" data-close-update aria-label="Fermer les mises à jour" title="Fermer" ${active ? 'disabled' : ''}>✕</button></div><div id="update-detail" class="update-detail" role="status" aria-live="polite">${detail}</div><div class="update-actions">${updateStatus === 'available' ? '<button type="button" class="primary" data-install-update aria-describedby="update-detail">Mettre à jour maintenant</button>' : ''}${['current', 'error'].includes(updateStatus) ? '<button type="button" class="plain-button" data-check-update>Vérifier à nouveau</button>' : ''}${active ? '' : `<button type="button" class="plain-button" data-close-update>${updateStatus === 'available' ? 'Plus tard' : 'Fermer'}</button>`}</div></div></div>`;
    }
    function render() {
      detachPreviewLayout();
      const app = document.getElementById('app');
      if (!state) {
        app.innerHTML = `<div class="load-error" role="alert"><h1>Impossible de charger les brouillons</h1><p>${esc(loadError || 'Chargement en cours…')}</p><button type="button" class="primary" data-retry-load>Réessayer</button></div>`;
        return;
      }
      if (startupUpdatePending && !busy && !mailOpen && !recentOpen && !folderOpen && !settingsOpen && !preferencesOpen && !voiceSession && !lineAssist) {
        startupUpdatePending = false;
        updateOpen = true;
      }
      app.className = `app v1 ${theme === 'dark' ? 'dark' : ''}`;
      applyWindowTheme();
      replaceAppMarkup(app, `${appHeader()}
        <div class="workbench">
        <section class="editor">
          <div class="section-head"><div class="section-title"><h3>${kindTitle()} à remplir</h3></div><div class="section-tools"><button type="button" class="icon-button save-button" id="save-status" data-save data-state="${saveState()}" aria-label="Enregistrer le brouillon. ${esc(saveStatus)}" title="${esc(saveTooltip())}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4zM7 3v7h9V3M7 21v-8h10v8"></path></svg><span class="save-status-mark" aria-hidden="true"></span><span class="save-status-announcement sr-only" role="status" aria-live="polite">${esc(saveStatus)}</span></button><button type="button" class="icon-button" data-voice aria-label="Remplir en parlant" title="Remplir en parlant"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v4m-4 0h8"></path></svg></button><button type="button" class="icon-button" data-undo aria-label="Annuler la dernière modification" title="Annuler la dernière modification" ${undoStack.length ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h9a7 7 0 0 1 0 14"></path></svg></button><button type="button" class="icon-button reset-button" data-reset aria-label="Réinitialiser le brouillon" title="Réinitialiser le brouillon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7"></path></svg></button></div></div>
          <div class="validation-panel" id="pdf-validation" role="alert" hidden></div>
          <div class="client-fields"><h4>Projet et client</h4><div class="client-grid">
            ${input('project','Nom du projet <span class="required">(obligatoire)</span>','Nom du projet')}
            ${input('client','Nom du client <span class="required">(obligatoire)</span>','Nom complet ou entreprise')}
            ${input('date','Date du document','','date')}
            ${state.kind === 'facture' ? input('dueDate','Date limite de paiement <span class="optional">(facultatif)</span>','','date') : input('validUntil','Valide jusqu’au','','date')}
            ${input('contact','Téléphone <span class="optional">(facultatif)</span>','Numéro de téléphone','tel')}
            ${input('email','Courriel <span class="optional">(facultatif)</span>','adresse@exemple.com','email')}
            ${input('address','Adresse de facturation <span class="required">(obligatoire)</span>','Rue, ville, code postal')}
            ${input('shipTo','Adresse du chantier / de livraison <span class="optional">(si différente)</span>','Rue, ville, province, code postal')}
            ${taxControls()}
          </div></div>
          <div class="items-section"><div class="table-head"><h4>Travaux et articles</h4><small>Microphone pour dicter · Étoiles pour mettre en file IA</small></div>
            <div id="lines">${state.items.map(row).join('')}</div>
            <button type="button" class="add-button" data-add>+ Ajouter une ligne</button>
          </div>
          <div class="optional-fields"><h4>${state.kind==='facture'?'Dépôts et paiements reçus':'Dépôts demandés'} <span class="optional">(facultatif)</span></h4>${paymentsControl()}</div>
          <div class="client-notes-section"><h4>Notes pour le client <span class="optional">(facultatif)</span></h4>${notesControl()}</div>
          <div class="summary-section">
            ${invoiceNumberControl()}
            ${languageControls()}
          </div>
          <div class="actions email-output-actions">
            <button type="button" class="print-button save-draft-button" data-save-draft title="Enregistrer ce document dans Documents pour le reprendre plus tard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4zM7 3v7h9V3M7 21v-8h10v8"></path></svg><span>Enregistrer le brouillon</span></button>
            <button type="button" class="print-button" data-pdf><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg><span>Créer le PDF</span></button>
            <button type="button" class="print-button" data-print><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6Z"/><path d="M18 12h.01"/></svg><span>Imprimer</span></button>
            <button type="button" class="primary" data-send-email><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9L2 9Z"/><path d="m22 2-11 11"/></svg><span>Envoyer</span></button>
          </div><p class="writing-status" data-writing-status role="status" aria-live="polite"></p><p class="output-status" role="status" aria-live="polite">${esc(outputStatus)}</p>
        </section><aside class="preview"><div class="preview-scroll"><div class="preview-page"><div class="live-pdf-pages" data-live-pdf aria-busy="true"></div><p class="page-status" hidden data-page-status role="status" aria-live="polite">Préparation de l’aperçu Lettre…</p><div class="preview-source" aria-hidden="true">${preview()}</div></div></div></aside></div>${recentDialog()}${updateDialog()}${folderDialog()}${aiSettingsDialog()}${preferencesDialog()}`);
      app.querySelectorAll('.app-top, .workbench').forEach(el => { el.inert = mailOpen || recentOpen || updateOpen || folderOpen || settingsOpen || preferencesOpen; });
      sync();
      paintWritingStatus();void validateDescriptionLimits();
      const calendar = app.querySelector('.date-popover');
      if (calendar) {
        const wrap = calendar.closest('.date-wrap'), anchor = wrap?.querySelector('[data-calendar]');
        if (anchor && wrap) {
          const width = calendar.offsetWidth, start = wrap.getBoundingClientRect().left;
          const left = Math.max(12, Math.min(anchor.getBoundingClientRect().right - width, innerWidth - width - 12));
          calendar.style.left = `${left - start}px`; calendar.style.right = 'auto';
          const anchorBox = anchor.getBoundingClientRect(), wrapBox = wrap.getBoundingClientRect();
          const height = calendar.offsetHeight;
          const below = anchorBox.bottom + 8;
          const top = below + height <= innerHeight - 12 ? below : Math.max(12, anchorBox.top - height - 8);
          calendar.style.top = `${top - wrapBox.top}px`;
        }
      }
      fitTextareas(app);
      paintValidation();
      paintVoiceUi();
      fitTextareas(app);
      enhanceSelects(app);
      hydrateLibraryPreviews(app);
      detachPreviewLayout = attachPreviewLayout(app);
    }
    function sync() {
      for (const button of document.querySelectorAll('[data-remove]')) {
        const item = state.items[Number(button.dataset.remove)];
        button.disabled = state.items.length === 1 && item && !item.description && !item.price && ['','1'].includes(item.quantity);
      }
      for (const button of document.querySelectorAll('[data-remove-payment]')) {
        const payment = state.payments[Number(button.dataset.removePayment)];
        button.disabled = state.payments.length === 1 && payment && !payment.amount && !payment.date;
      }
      for (const button of document.querySelectorAll('[data-remove-note]')) button.disabled = false;
      const legacyConfirm = document.querySelector('[data-confirm-legacy-tax]');
      if (legacyConfirm) legacyConfirm.hidden = resolveTax(state).selection !== 'legacy' || !taxIssue(state);
      const location=documentLocation(state,englishMode?'en':'fr');
      const view = {...customerDraft(),shipTo:location.address};
      document.querySelectorAll('[data-shipping-label]').forEach(el=>el.textContent=location.label);
      document.querySelectorAll('[data-row-total]').forEach(el => { const item = state.items[Number(el.dataset.rowTotal)]; el.textContent = money(value(item.quantity) * value(item.price)); });
      for (const [key, amount] of Object.entries({ subtotal: total(), gross: gross(), deposit: deposit(), balance: balance() })) document.querySelectorAll(`[data-preview="${key}"]`).forEach(el => el.textContent = taxMoney(amount));
      document.querySelectorAll('[data-preview-tax-lines]').forEach(el=>el.innerHTML=previewTaxRows(englishMode));
      document.querySelectorAll('.preview-page .doc1-footer').forEach(el=>el.innerHTML=taxRegistration(resolveTax(state).province,englishMode?'en':'fr').map(text=>`<span>${text}</span>`).join(''));
      document.querySelectorAll('[data-deposit-row]').forEach(el => { el.hidden = deposit() <= 0; });
      document.querySelectorAll('[data-shipping-block]').forEach(el => { el.hidden = !location.address.trim(); });
      document.querySelectorAll('[data-phone-block]').forEach(el => { el.hidden = !state.contact?.trim(); });
      document.querySelectorAll('[data-email-block]').forEach(el => { el.hidden = !state.email?.trim(); });
      document.querySelectorAll('[data-notes-block]').forEach(el => { el.hidden = !view.notes?.trim(); });
      document.querySelectorAll('[data-payment-breakdown]').forEach(el => { el.hidden = deposit() <= 0; el.innerHTML = paymentBreakdown(); });
      const previewFallback = { client:englishMode ? 'Client name' : 'Nom du client', shipTo:'', address:englishMode ? 'Billing address' : 'Adresse de facturation', date:'Date', validUntil:englishMode ? 'Valid until' : 'Date de validité', dueDate:englishMode ? 'None' : 'Aucune', invoiceNumber:state.invoiceNumber ?? '—', contact:'', email:'', project:englishMode ? 'Project name' : 'Nom du projet', notes:'' };
      for (const field of Object.keys(previewFallback)) document.querySelectorAll(`[data-preview="${field}"]`).forEach(el => el.textContent = ['date','validUntil','dueDate'].includes(field) ? displayDate(state[field]) || previewFallback[field] : (field === 'contact' ? formatPhone(view[field]) : view[field]) || previewFallback[field]);
      const rows = view.items.filter(i => i.description?.trim() || String(i.price || '').trim()).map(i => `<tr><td>${esc(i.description || '—')}</td><td>${esc(i.quantity || '—')}</td><td>${money(value(i.price))}</td><td>${money(value(i.quantity) * value(i.price))}</td></tr>`).join('');
      const table = document.getElementById('previewRows'); if (table) table.innerHTML = rows || '<tr><td colspan="4" style="color:#87948b">Aucun article ajouté</td></tr>';
      enhanceSelects(document.getElementById('app'));
      updatePdfPreview(customerDraft(), {invoiceNumber: state.invoiceNumber, language: englishMode ? 'en' : 'fr'}, pdfIssues().length > 0);
    }
    let toastTimer;
    function notice(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3700); }
    function readyForOutput() {
      if (englishMode && !englishComplete()) {
        notice('La version anglaise est incomplète ou périmée. Cliquez sur English pour la retraduire.');
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
        workbench.inert = active || mailOpen || recentOpen || updateOpen || folderOpen || settingsOpen || preferencesOpen;
        workbench.setAttribute('aria-busy', String(active));
      }
      if (!active && startupUpdatePending && !mailOpen && !recentOpen && !folderOpen && !settingsOpen && !preferencesOpen && !voiceSession && !lineAssist) render();
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
    async function printDocument() {
      if (busy || !readyForOutput()) return;
      setBusy(true);
      try {
        await finishWritingForOutput();
        if (!await flushChanges()) return;
        setBusy(true);
        const draft = copy(state);
        const invoiceNumber = draft.kind === 'facture' ? Number(draft.invoiceNumber) : null;
        if (draft.kind === 'facture' && (!Number.isSafeInteger(invoiceNumber) || invoiceNumber <= 0)) {
          throw new Error('Numéro de facture indisponible. Réessayez après avoir rouvert le brouillon.');
        }
        const language = englishMode ? 'en' : 'fr';
        const printDraft = language === 'en' ? customerDraft() : draft;
        // These bytes exist only in memory for faithful Letter-page printing.
        // Print must never call export_pdf, archive a file or reserve a number.
        const bytes = await createPdf(printDraft, { invoiceNumber, language });
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Le document n’a pas pu être préparé.');
        await printPdf(bytes);
        outputStatus = 'Fenêtre d’impression ouverte. Aucun PDF enregistré.';
        notice(outputStatus);
      } catch (error) {
        notice(`Impression impossible : ${errorText(error)}`);
      } finally {
        setBusy(false);
      }
    }
    async function exportDocument(forEmail = false) {
      if (busy || !readyForOutput()) {
        if (forEmail) throw new Error('Le document n’est pas prêt pour créer sa pièce jointe.');
        return;
      }
      if (!await ensureInvoiceNumberConfirmed()) {
        if (forEmail) throw new Error('Réutilisation du numéro annulée. Aucun courriel envoyé.');
        return;
      }
      const alreadyExported = Boolean(records.find(record => record.id === state.id)?.exports?.length);
      if (!forEmail && alreadyExported && !confirm('Ce document a déjà été enregistré en PDF. Créer une autre copie avec le même numéro de facture, si applicable ? Le fichier précédent sera conservé.')) {
        return;
      }
      setBusy(true);
      try {
        await finishWritingForOutput();
        if (!await flushChanges()) return;
        setBusy(true);
        if (englishMode && state.englishCopy && !state.englishCopy.reviewed) {
          state.englishCopy.reviewed = true;
          markDirty();
          if (!await saveNow(true)) throw new Error('La version anglaise n’a pas pu être enregistrée.');
        }
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
        state = copy(result.snapshot);
        numberEditing = false; numberConfirm = null; numberError = '';
        savedRevision = editRevision;
        try { applySnapshot(await runCommand('load_state')); }
        catch (refreshError) { notice(`PDF enregistré, mais liste non actualisée : ${errorText(refreshError)}`); }
        outputStatus = `PDF enregistré : ${result.path}`;
        render();
        notice(result.nameCollision
          ? `Un PDF portait déjà ce nom. Nouvelle copie : ${result.filename}. L'ancien fichier a été conservé.`
          : `PDF enregistré : ${result.path}`);
        return { path: result.path, filename: result.filename, draftId: result.snapshot.id };
      } catch (error) {
        if (forEmail) throw error;
        notice(`Export non confirmé : ${errorText(error)}`);
      } finally {
        setBusy(false);
      }
    }
    function finishMail() {
      mailOpen = false;
      document.getElementById('app').inert = false;
      render();
      document.querySelector(preferencesOpen ? '.preferences-panel button' : '[data-send-email]')?.focus({preventScroll:true});
    }
    async function showMailSettings() {
      if (mailOpen || busy) return;
      mailOpen = true;
      try { await openMailSettings({ invoke: runCommand, onClose: finishMail, onBack: () => { preferencesOpen = true; render(); document.querySelector('.preferences-panel button')?.focus(); } }); }
      catch (error) { finishMail(); notice(`Réglages du courriel indisponibles : ${errorText(error)}`); }
    }
    async function composeEmail() {
      if (mailOpen || busy || !readyForOutput()) return;
      setBusy(true);
      try {await finishWritingForOutput();}
      catch(error){notice(`Envoi indisponible : ${errorText(error)}`);return;}
      finally{setBusy(false);}
      if (!await flushChanges()) return;
      const source = copy(state);
      const language = englishMode ? 'en' : 'fr';
      const previewSource = copy(customerDraft());
      mailOpen = true;
      try {
        const filename = await runCommand('preview_pdf_filename', { draftId: source.id, language });
        await openEmailComposer({
          invoke: runCommand, draft: source, pdfDraft: previewSource, language,
          filename,
          previewPdf: () => createPdf(previewSource, { invoiceNumber: source.invoiceNumber, language }),
          preparePdf: async () => {
            if (state.id !== source.id) throw new Error('Le document ouvert a changé. Fermez ce courriel et ouvrez-le à nouveau.');
            const result = await exportDocument(true);
            if (!result) throw new Error('Le PDF n’a pas été enregistré. Aucun courriel n’a été envoyé.');
            return result;
          },
          rewrite: ({ subject, body, language }) => runCommand('ai_rewrite_email', { subject, body, language }),
          onClose: finishMail,
          onSent: receipt => { outputStatus = 'PDF enregistré. Courriel accepté par Outlook pour envoi.'; notice(outputStatus); }
        });
      } catch (error) { finishMail(); notice(`Courriel indisponible : ${errorText(error)}`); }
    }
    async function loadState() {
      try {
        const snapshot = await runCommand('load_state');
        applySnapshot(snapshot);
        loadError = null;
        savedRevision = editRevision;
        render();
        void checkForStartupUpdate();
      } catch (error) {
        state = null;
        loadError = errorText(error);
        render();
      }
    }
    function closeRecent() {
      if (!documentLibrary.close()) return;
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
      document.querySelector('[data-preferences]')?.focus();
    }
    async function openAiSettings() {
      settingsOpen = true; settingsError = ''; settingsSuccess = ''; aiSettings = null; render();
      try { aiSettings = await runCommand('get_ai_settings'); }
      catch (error) { settingsError = `Réglages indisponibles : ${errorText(error)}`; }
      render(); document.querySelector('.ai-settings-panel')?.focus();
    }
    function closeAiSettings() {
      if (settingsBusy) return;
      settingsOpen = false; settingsError = ''; settingsSuccess = ''; render();
      document.querySelector('[data-preferences]')?.focus();
    }
    async function changeAiProvider(provider) {
      if (settingsBusy || !['chatgpt', 'business'].includes(provider)) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try { aiSettings = await runCommand('set_ai_provider', { provider }); }
      catch (error) { settingsError = `Sélection indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector(`input[name="ai-provider"][value="${provider}"]`)?.focus(); }
    }
    async function startChatgptLogin() {
      if (settingsBusy || aiSettings?.provider !== 'chatgpt' || aiSettings.authPending) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try {
        const result = await runCommand('start_chatgpt_login');
        aiSettings = result.settings;
        if (result.attemptId) await runCommand('open_chatgpt_login', { attempt: result.attemptId });
      } catch (error) { settingsError = `Connexion indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector('[data-refresh-ai-settings], [data-start-chatgpt-login]')?.focus(); }
    }
    async function refreshAiSettings() {
      if (settingsBusy) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try { aiSettings = await runCommand('get_ai_settings'); }
      catch (error) { settingsError = `Actualisation indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector('[data-refresh-ai-settings], [data-test-ai], [data-start-chatgpt-login]')?.focus(); }
    }
    async function cancelChatgptLogin() {
      if (settingsBusy || !aiSettings?.authPending) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try { aiSettings = await runCommand('cancel_chatgpt_login'); }
      catch (error) { settingsError = `Annulation indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector('[data-start-chatgpt-login]')?.focus(); }
    }
    async function disconnectChatgpt() {
      if (settingsBusy || !(aiSettings?.chatgptConfigured || aiSettings?.authError)) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try { aiSettings = await runCommand('disconnect_chatgpt'); }
      catch (error) { settingsError = `Déconnexion indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.querySelector('[data-start-chatgpt-login]')?.focus(); }
    }
    async function saveAiKey(remove = false) {
      if (settingsBusy || aiSettings?.provider !== 'business') return;
      const provider = 'business';
      const key = remove ? null : document.getElementById('ai-key')?.value?.trim();
      if (!remove && !key) { settingsSuccess = ''; settingsError = 'Entrez le jeton Business avant de l’enregistrer.'; render(); return; }
      if (remove && !confirm('Supprimer les identifiants IA enregistrés pour ce service sur cet ordinateur ?')) return;
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try {
        aiSettings = await runCommand('set_ai_key', { provider, key });
        notice(remove ? 'Identifiants supprimés.' : 'Identifiants enregistrés dans Windows. Testez la connexion pour les vérifier.');
      } catch (error) { settingsError = `Enregistrement indisponible : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); document.getElementById('ai-key')?.focus(); }
    }
    async function testAiConnection() {
      if (settingsBusy) return;
      if (aiSettings?.provider === 'business' && document.getElementById('ai-key')?.value?.trim()) {
        // Preserve the unsaved replacement instead of testing the previous credential.
        notice('Enregistrez d’abord le nouveau jeton Business, puis testez la connexion.');
        return;
      }
      settingsBusy = true; settingsError = ''; settingsSuccess = ''; render();
      try { settingsSuccess = await runCommand('test_ai_connection'); }
      catch (error) { settingsError = `Connexion non vérifiée : ${errorText(error)}`; }
      finally { settingsBusy = false; render(); }
    }
    async function aiReady() {
      try {
        aiSettings = await runCommand('get_ai_settings');
        const configured = aiSettings.provider === 'business' ? aiSettings.businessConfigured : aiSettings.provider === 'chatgpt' && aiSettings.chatgptConfigured;
        // Enables an authenticated attempt. Only a completed provider response proves access.
        if (configured) return true;
        notice(aiSettings.provider === 'business' ? 'Ajoutez votre jeton Business dans les réglages.' : 'Connectez votre compte ChatGPT dans les réglages.');
        await openAiSettings();
      } catch (error) { notice(`IA indisponible : ${errorText(error)}`); }
      return false;
    }
    const queueVoiceWork = work => {
      voiceQueue = voiceQueue.catch(() => {}).then(work);
      return voiceQueue;
    };
    function lineAssistText(index) {
      const note = noteIndex(index);
      return note !== null ? noteRows(state)[note] : state.items[index]?.description;
    }
    function lineAssistTextarea(index) {
      const note = noteIndex(index);
      return note !== null ? document.querySelector(note === 0 ? '#client-notes' : `#client-notes-${note}`)
        : document.querySelectorAll('.line-entry')[index]?.querySelector('textarea[data-key="description"]');
    }
    function noteIndex(key) {
      if (key === 'notes') return 0;
      if (typeof key === 'string' && /^notes:\d+$/.test(key)) return Number(key.slice(6));
      return null;
    }
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
      if (activeCapture || voiceSession || lineAssist?.recording || lineAssist?.processing || lineAssist?.stopping) return;
      const source = lineAssistText(index);
      if (!source) { notice(noteIndex(index) !== null ? 'Écrivez d’abord une note ou utilisez le microphone.' : 'Écrivez d’abord une description ou utilisez le microphone.'); return; }
      if(noteIndex(index)!==null) {
        if(!await aiReady())return;
        lineAssist={index,draftId:state.id,source:source.trim(),proposal:'',style:'prose',variation:0,status:'Préparation du texte…',processing:false,recording:false};
        await proposeLine();return;
      }
      const documentId=state.id,note=noteIndex(index),key=note!==null?writingIds().notes[note]:writingIds().items[index];
      if (!await aiReady()) return;
      const current=writingFields().find(f=>f.key===key);
      if(state.id!==documentId||!current?.text?.trim())return;
      automatic.supersede(key);
      improvements.enqueue({documentId,key,source:current.text});
    }
    async function startLineDictation(index) {
      if (activeCapture || voiceSession || voiceRetryBusy || lineAssist?.recording || lineAssist?.processing || lineAssist?.stopping) return;
      if (!await aiReady()) return;
      englishMode = false;
      const original = lineAssistText(index);
      if (typeof original !== 'string') return;
      const assist = { index, draftId: state.id, original, source: original, transcript: '', proposal: '', style: 'prose', variation: 0, status: 'Écoute en cours… Rappuyez sur le micro pour terminer.', processing: false, recording: true };
      lineAssist = assist; voiceQueue = Promise.resolve(); render();
      try {
        assist.status = 'Chargement du moteur vocal local…'; render();
        const url = await runCommand('start_local_asr');
        const controller = await startStreamingRecognition({ url,
          onPartial: partial => {
            if (lineAssist !== assist) return;
            const box = lineAssistTextarea(index);
            if (box) { box.value = [original, assist.transcript, partial].filter(Boolean).join('\n'); fitTextareas(box.parentElement); }
          },
          onFinal: text => {
            if (lineAssist !== assist) return;
            assist.transcript += `${assist.transcript ? ' ' : ''}${text}`;
            assist.status = 'Texte entendu. Continuez à parler ou rappuyez sur le micro.';
            const box = lineAssistTextarea(index);
            if (box) { box.value = [original, assist.transcript].filter(Boolean).join('\n'); fitTextareas(box.parentElement); }
          },
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
        assist.status = 'Écoute en cours… Rappuyez sur le micro pour terminer.'; render();
      } catch (error) {
        if (lineAssist !== assist) return;
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
        assist.source = [assist.original, assist.transcript].filter(Boolean).join('\n');
        await proposeLine('prose', 0);
      } catch (error) { if (lineAssist === assist) {
        if (assist.transcript.trim()) {
          assist.source = [assist.original, assist.transcript].filter(Boolean).join('\n');
          assist.proposal ||= assist.source;
        }
        assist.status = `Dictée interrompue : ${errorText(error)}. ${assist.proposal ? 'Le texte reconnu reste modifiable ici.' : 'Réessayez.'}`;
        render();
      } }
      finally { assist.stopping = false; if (lineAssist === assist) render(); }
    }
    async function closeLineAssist() {
      const capture = activeCapture;
      closePanelMotion(document.querySelector('.line-review'));
      activeCapture = null; lineAssist = null; render();
      try { await capture?.cancel(); } catch { /* The original line is untouched. */ }
    }
    async function startDocumentDictation() {
      if (activeCapture || voiceSession) return;
      if (lineAssist) { notice('Acceptez ou fermez la proposition en cours avant de dicter le document.'); return; }
      if (voiceRecovery) { notice('Vérifiez ou fermez les paroles déjà reconnues avant une nouvelle dictée.'); return; }
      if (!await aiReady()) return;
      englishMode = false;
      const session = createVoiceSession(state);
      voiceSession = session; voiceStatus = 'Écoute du document… Les champs apparaissent au fur et à mesure.';
      voiceLiveText = '';
      voiceQueue = Promise.resolve(); render();
      try {
        voiceStatus = 'Chargement du moteur vocal local…'; render();
        const url = await runCommand('start_local_asr');
        const controller = await startStreamingRecognition({ url,
          onPartial: partial => {
            if (voiceSession !== session) return;
            voiceLiveText = [session.transcript, partial].filter(Boolean).join(' ');
            const live = document.querySelector('[data-live-transcript]');
            if (live) live.textContent = voiceLiveText || 'Parlez maintenant…';
          },
          onFinal: transcript => {
            if (voiceSession !== session || !transcript?.trim()) return;
            session.transcript += `${session.transcript ? ' ' : ''}${transcript.trim()}`;
            voiceLiveText = session.transcript;
            if (session.transcript.length > 20000) {
              voiceStatus = 'Dictée très longue. Arrêtez le microphone et vérifiez le document.';
              render();
              return;
            }
            const live = document.querySelector('[data-live-transcript]');
            if (live) live.textContent = voiceLiveText;
            const transcriptSoFar = session.transcript;
            void queueVoiceWork(async () => {
              voiceStatus = 'Paroles reconnues. Remplissage des champs…'; render();
              const update = await runCommand('ai_extract_document', { transcript: transcriptSoFar });
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
            }).catch(error => {
              if (voiceSession === session) {
                voiceRecovery = { session };
                voiceStatus = `Analyse impossible : ${errorText(error)}. Vos paroles restent disponibles.`;
                render();
              }
            });
          },
          onError: error => { if (voiceSession === session) {
            activeCapture = null; voiceSession = null;
            if (session.transcript) voiceRecovery = { session };
            voiceStatus = `Dictée interrompue : ${errorText(error)}. Les champs déjà enregistrés restent dans le brouillon.`;
            render();
          } }
        });
        if (voiceSession !== session || session.stopping) { await controller.cancel(); return; }
        activeCapture = controller;
        voiceStatus = 'Écoute du document… Les champs apparaissent après chaque phrase.'; render();
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
      translationError = '';
      if (!await flushChanges()) return;
      translationLoading = true;
      render();
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
        translationLoading = false;
        markDirty();
        render();
        if (!await saveNow(true)) throw new Error('La copie anglaise n’a pas pu être enregistrée.');
        notice('Version anglaise affichée. Relisez l’aperçu avant de créer le PDF.');
      } catch (error) {
        translationError = `Traduction impossible : ${errorText(error)}`;
        translationLoading = false;
        englishMode = false;
        outputStatus = translationError;
        render();
        notice(translationError);
      } finally { setBusy(false); }
    }
    async function applyNumberChoice(selectedNumber) {
      if (!await flushChanges()) return;
      setBusy(true);
      try {
        const reused = selectedNumber < nextInvoiceNumber || records.some(record => record.draft.issuedNumber === selectedNumber);
        const snapshot = await runCommand('set_next_invoice_number', { number: selectedNumber, allowReuse: reused });
        applySnapshot(snapshot); numberConfirm = null; numberEditing = false; numberError = ''; render();
        document.querySelector('[data-edit-number]')?.focus();
        notice(`Nouveau point de départ enregistré : ${nextInvoiceNumber}. Après la création du PDF, la prochaine facture sera le n° ${selectedNumber + 1}.`);
      } catch (error) {
        numberError = `Numéro inchangé : ${errorText(error)}`;
        numberConfirm = null; render();
        const input = document.getElementById('next-number');
        if (input) input.value = String(selectedNumber);
        input?.focus();
      } finally { setBusy(false); }
    }
    async function chooseFolder(useDefault = false, kind = state.kind) {
      if (folderBusy) return;
      folderError = '';
      let path = null;
      if (!useDefault) {
        try { path = await pickFolder({ directory: true, multiple: false, defaultPath: pdfDirectories[kind]?.path || undefined, title: `Choisir le dossier des ${kind === 'facture' ? 'factures' : 'soumissions'}` }); }
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
        const snapshot = await runCommand('set_output_directory', { path, kind });
        applySnapshot(snapshot, false);
        folderOpen = true;
        folderError = '';
        notice(`${kind === 'facture' ? 'Factures' : 'Soumissions'} : dossier enregistré. ${pdfDirectories[kind].path}`);
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
    async function ensureInvoiceNumberConfirmed() {
      if (state.kind !== 'facture' || state.issuedNumber || state.manualInvoiceNumber === state.invoiceNumber
        || !records.some(record => record.draft?.issuedNumber === state.invoiceNumber)) return true;
      const number = state.invoiceNumber, id = state.id;
      if (!confirm(`La facture n° ${number} existe déjà. Réutiliser ce numéro ? Les anciennes factures et leurs PDF seront conservés.`)) return false;
      if (!await flushChanges()) return false;
      if (state.id !== id || state.invoiceNumber !== number) {
        notice('Le numéro a changé pendant l’enregistrement. Vérifiez la facture avant de réessayer.');
        return false;
      }
      try {
        const snapshot = await runCommand('confirm_invoice_number_reuse', { draftId: id, expectedNumber: number });
        applySnapshot(snapshot);
        return true;
      } catch (error) {
        notice(`Numéro non confirmé : ${errorText(error)}`);
        return false;
      }
    }
    async function checkForStartupUpdate() {
      if (startupUpdateChecked) return;
      startupUpdateChecked = true;
      const requestId = updateRequestId;
      try {
        const found = await check({ timeout: 30_000 });
        if (requestId !== updateRequestId || updateOpen) { await releaseUpdate(found); return; }
        if (!found) return;
        availableUpdate = found;
        updateVersion = String(found.version || 'inconnue');
        updateStatus = 'available';
        updateError = '';
        startupUpdatePending = true;
        render();
      } catch (error) {
        // Offline/current launches stay quiet. Manual checking still reports failures.
        console.debug('Startup update check unavailable', error);
      }
    }
    function closeUpdate(backToSettings = false) {
      if (['saving', 'downloading', 'installing', 'restarting'].includes(updateStatus)) return;
      updateRequestId++;
      updateOpen = false;
      startupUpdatePending = false;
      const update = availableUpdate;
      availableUpdate = null;
      void releaseUpdate(update);
      if (backToSettings) preferencesOpen = true;
      render();
      document.querySelector(backToSettings ? '.preferences-panel [data-check-update]' : '[data-preferences]')?.focus();
    }
    async function checkForUpdate() {
      if (busy || !state || mailOpen) return;
      const requestId = ++updateRequestId;
      startupUpdatePending = false;
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
      if (document.activeElement === document.querySelector('.update-panel')) document.querySelector(updateStatus === 'available' ? '[data-install-update]' : '.update-panel [data-check-update]')?.focus({preventScroll:true});
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
      if (rowMotionPending) return;
      if (event.target.classList?.contains('recent-backdrop')) { if (updateOpen && updateOrigin === 'settings') { closeUpdate(); return; } if (folderOpen) { closeFolder(); return; } if (settingsOpen) { closeAiSettings(); return; } }
      if (event.target.matches?.('[data-preferences-outside]')) { closePreferences(); return; }
      if (event.target.dataset?.dateDisplay) { toggleCalendar(event.target.dataset.dateDisplay); return; }
      const b = event.target.closest('button');
      if (!b || b.disabled) return;
      if (b.hasAttribute('data-preferences')) { preferencesOpen = !preferencesOpen; appearanceOpen = false; render(); document.querySelector('.preferences-panel button')?.focus(); return; }
      if (b.hasAttribute('data-close-preferences')) { closePreferences(); return; }
      if (b.hasAttribute('data-appearance')) { appearanceOpen = true; render(); document.querySelector('button[data-theme]')?.focus(); return; }
      if (b.hasAttribute('data-settings-back')) {
        if (appearanceOpen) { appearanceOpen = false; render(); document.querySelector('[data-appearance]')?.focus(); return; }
        if (updateOpen) { closeUpdate(true); return; }
        if (folderBusy || settingsBusy) return;
        folderOpen = false; settingsOpen = false; folderError = ''; settingsError = ''; settingsSuccess = '';
        preferencesOpen = true; render(); document.querySelector('.preferences-panel button')?.focus(); return;
      }
      if (b.hasAttribute('data-retry-load')) { await loadState(); return; }
      if (busy || !state || mailOpen) return;
      if (b.hasAttribute('data-voice')) { if (voiceSession) await stopDocumentDictation(); else await startDocumentDictation(); return; }
      if (b.dataset.lineDictate !== undefined) {
        const index = noteIndex(b.dataset.lineDictate) !== null ? b.dataset.lineDictate : Number(b.dataset.lineDictate);
        if (lineAssist?.recording && lineAssist.index === index) await stopLineDictation();
        else await startLineDictation(index);
        return;
      }
      if (b.dataset.closeLineAssist !== undefined) { await closeLineAssist(); return; }
      if (voiceSession || voiceRetryBusy || lineAssist?.recording || lineAssist?.processing || lineAssist?.stopping) {
        notice('Terminez la dictée ou la proposition en cours avant cette action.'); return;
      }
      if (b.hasAttribute('data-test-ai')) { await testAiConnection(); return; }
      if (b.hasAttribute('data-mail-settings')) { preferencesOpen = false; render(); await showMailSettings(); return; }
      if (b.hasAttribute('data-send-email')) { await composeEmail(); return; }
      if (b.hasAttribute('data-ai-settings')) { preferencesOpen = false; await openAiSettings(); return; }
      if (b.hasAttribute('data-close-ai-settings')) { closeAiSettings(); return; }
      if (b.hasAttribute('data-start-chatgpt-login')) { await startChatgptLogin(); return; }
      if (b.hasAttribute('data-refresh-ai-settings')) { await refreshAiSettings(); return; }
      if (b.hasAttribute('data-cancel-chatgpt-login')) { await cancelChatgptLogin(); return; }
      if (b.hasAttribute('data-disconnect-chatgpt')) { await disconnectChatgpt(); return; }
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
      if (b.hasAttribute('data-dismiss-voice')) { closePanelMotion(document.querySelector('.voice-recovery')); voiceRecovery = null; voiceStatus = ''; render(); return; }
      if (b.dataset.lineEnhance !== undefined) { await enhanceLine(noteIndex(b.dataset.lineEnhance) !== null ? b.dataset.lineEnhance : Number(b.dataset.lineEnhance)); return; }
      if (b.dataset.lineStyle) { await proposeLine(b.dataset.lineStyle, 0); return; }
      if (b.hasAttribute('data-line-variation')) { if (lineAssist) await proposeLine(lineAssist.style, lineAssist.variation + 1); return; }
      if (b.hasAttribute('data-line-accept')) {
        if (lineAssist?.proposal && state.id === lineAssist.draftId && typeof lineAssistText(lineAssist.index) === 'string') {
          rememberUndo();
          const notes = noteIndex(lineAssist.index) !== null;
          if (notes) { const entries = noteRows(state); entries[noteIndex(lineAssist.index)] = lineAssist.proposal; setNoteRows(state, entries); }
          else state.items[lineAssist.index].description = lineAssist.proposal;
          lineAssist = null; markDirty(); render(); void saveNow();
          notice(notes ? 'Note acceptée.' : 'Description acceptée.');
        }
        return;
      }
      if (b.hasAttribute('data-check-update')) { if (preferencesOpen) updateOrigin = 'settings'; preferencesOpen = false; await checkForUpdate(); return; }
      if (b.hasAttribute('data-close-update')) { closeUpdate(); return; }
      if (b.hasAttribute('data-install-update')) { await installUpdate(); return; }
      if (b.hasAttribute('data-close-calendar')) {
        const field = calendarField; closePanelMotion(b.closest('.date-popover'));
        calendarField = null; calendarView = null; render();
        document.querySelector(`[data-calendar="${field}"]`)?.focus(); return;
      }
      if (b.dataset.calendar) { toggleCalendar(b.dataset.calendar); return; }
      if (b.hasAttribute('data-calendar-prev')) { shiftCalendar(-1); return; }
      if (b.hasAttribute('data-calendar-next')) { shiftCalendar(1); return; }
      if (b.dataset.calendarDay) { chooseDate(b.dataset.calendarDay); return; }
      if (b.hasAttribute('data-calendar-today')) { chooseDate(isoDate(new Date())); return; }
      if (b.hasAttribute('data-calendar-clear')) { chooseDate(''); return; }
      if (['theme','palette','tint'].some(key => b.hasAttribute(`data-${key}`))) {
        const key = ['theme','palette','tint'].find(key => b.hasAttribute(`data-${key}`));
        const value = b.dataset[key];
        if (key === 'theme') theme = value === 'dark' ? 'dark' : 'light';
        if (key === 'palette' && Object.hasOwn(palettes,value)) palette = value;
        if (key === 'tint') tint = value === 'strong' ? 'strong' : 'soft';
        try { localStorage.setItem('hermitage-theme',theme); localStorage.setItem('hermitage-palette',palette); localStorage.setItem('hermitage-tint',tint); } catch { /* Session remains usable without storage. */ }
        render(); document.querySelector(`button[data-${key}="${value}"]`)?.focus(); return;
      }
      if (b.hasAttribute('data-folder')) {
        preferencesOpen = false; folderError = '';
        folderOpen = true;
        render();
        document.querySelector('.folder-panel [data-choose-folder]')?.focus();
        return;
      }
      if (b.hasAttribute('data-close-folder')) { closeFolder(); return; }
      if (b.hasAttribute('data-choose-folder')) { await chooseFolder(false, b.dataset.folderKind); return; }
      if (b.hasAttribute('data-default-folder')) { await chooseFolder(true, b.dataset.folderKind); return; }
      if (b.hasAttribute('data-show-french')) { englishMode = false; translationError = ''; render(); return; }
      if (b.hasAttribute('data-show-english')) {
        if (englishMode && englishComplete()) return;
        if (englishComplete()) { englishMode = true; translationError = ''; render(); }
        else await translateEnglish();
        return;
      }
      if (b.hasAttribute('data-recent')) {
        if (!await flushChanges()) return;
        try { applySnapshot(await runCommand('load_state'), false); }
        catch (error) { notice(`Documents indisponibles : ${errorText(error)}`); return; }
        recentOpener = b;
        numberConfirm = null; documentLibrary.open();
        document.querySelector('[data-recent-search]')?.focus();
        return;
      }
      if (['data-library-action', 'data-select-record', 'data-review-record', 'data-record-history', 'data-library-filter', 'data-library-version', 'data-library-new'].some(attribute => b.hasAttribute(attribute))) { await documentLibrary.handleClick(b); return; }
      if (b.hasAttribute('data-close-recent')) { closeRecent(); return; }
      if (b.hasAttribute('data-edit-number')) {
        if (!await flushChanges()) return;
        numberEditing = true; numberConfirm = null; numberError = '';
        render(); document.getElementById('next-number')?.focus(); return;
      }
      if (b.dataset.numberStep) {
        const input = document.getElementById('next-number');
        if (b.dataset.numberStep === '1') input?.stepUp(); else input?.stepDown();
        numberError = ''; document.querySelector('.number-popover.number-error')?.remove(); input?.focus(); return;
      }
      if (b.dataset.quickNumberStep !== undefined) {
        const current = state.issuedNumber ? nextInvoiceNumber : state.invoiceNumber;
        const number = current + Number(b.dataset.quickNumberStep);
        if (!Number.isSafeInteger(number) || number < 1) return;
        if (!await flushChanges()) return;
        numberError = '';
        if (number < nextInvoiceNumber || records.some(record => record.draft.issuedNumber === number)) {
          numberConfirm = number; render(); document.querySelector('[data-apply-number]')?.focus();
        } else await applyNumberChoice(number);
        return;
      }
      if (b.hasAttribute('data-stage-number')) {
        const number = Number(document.getElementById('next-number')?.value);
        if (!Number.isSafeInteger(number) || number <= 0) { numberError = 'Entrez un numéro entier positif.'; render(); document.getElementById('next-number')?.focus(); return; }
        if (number === (state.issuedNumber ? nextInvoiceNumber : state.invoiceNumber)) {
          numberEditing = false; numberError = ''; render(); document.querySelector('[data-edit-number]')?.focus(); return;
        }
        numberError = '';
        if (number < nextInvoiceNumber || records.some(record => record.draft.issuedNumber === number)) {
          numberConfirm = number; render(); document.querySelector('[data-apply-number]')?.focus();
        } else await applyNumberChoice(number);
        return;
      }
      if (b.hasAttribute('data-cancel-number')) {
        const candidate = numberConfirm;
        numberConfirm = null; render();
        const input = document.getElementById('next-number');
        if (input && candidate !== null) input.value = String(candidate);
        if (input) input.focus(); else document.querySelector('[data-edit-number]')?.focus(); return;
      }
      if (b.hasAttribute('data-apply-number')) {
        if (numberConfirm !== null) await applyNumberChoice(numberConfirm);
        return;
      }
      if (b.hasAttribute('data-undo')) { await undo(); return; }
      if (b.dataset.kind) {
        if (state.kind === b.dataset.kind) return;
        if (state.issuedNumber) { notice('Cette facture est déjà émise. Créez un nouveau document pour changer de type.'); return; }
        rememberUndo();
        lineAssist = null;
        state.kind = b.dataset.kind;
        if (state.kind === 'soumission' && !String(state.validUntil || '').trim()) {
          const documentDate = parseDate(state.date);
          if (documentDate) {
            documentDate.setDate(documentDate.getDate() + 30);
            state.validUntil = isoDate(documentDate);
          }
        }
        englishMode = false; showValidation = false; numberEditing = false; numberConfirm = null; numberError = ''; render();
        document.querySelector('.workbench')?.classList.add('switching');
        markDirty(); void saveNow();
        return;
      }
      if (b.hasAttribute('data-add-note')) {
        const entries = noteRows(state);
        if (entries.length >= 500) { notice('Maximum de 500 notes par document.'); return; }
        if (lineAssist) await closeLineAssist();
        writingIds();rememberUndo(); entries.push(''); setNoteRows(state, entries);
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-note="${entries.length - 1}"]`)?.focus(); return;
      }
      if (b.dataset.removeNote !== undefined) {
        const index = Number(b.dataset.removeNote), entries = noteRows(state);
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
        if (lineAssist) await closeLineAssist();
        if (entries.length > 1) {
          rowMotionPending = true;
          try { await collapseRowMotion(b.closest('.notes-entry')); } finally { rowMotionPending = false; }
        }
        const latest = noteRows(state);
        writingIds().notes.splice(index,1);rememberUndo(); latest.splice(index, 1); setNoteRows(state, latest);
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-note="${Math.min(index, state.noteEntries.length - 1)}"]`)?.focus(); return;
      }
      if (b.hasAttribute('data-add-payment')) {
        if (state.payments.length >= 500) { notice('Maximum de 500 paiements par document.'); return; }
        rememberUndo(); calendarField = null; calendarView = null;
        state.payments.push({ amount: '', date: '' });
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-payment="${state.payments.length - 1}"]`)?.focus();
        return;
      }
      if (b.dataset.quantityStep !== undefined) {
        const index = Number(b.dataset.line);
        const input = document.querySelector(`[data-item="${index}"][data-key="quantity"]`);
        if (!input || !state.items[index]) return;
        const current = Number(String(input.value).replace(',', '.'));
        const candidate = Math.round(((Number.isFinite(current) ? current : 0) + Number(b.dataset.quantityStep)) * 1000000) / 1000000;
        const next = candidate > 0 ? candidate : current > 0 ? current : 1;
        input.value = String(next).replace('.', ',');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (b.dataset.removePayment !== undefined) {
        const index = Number(b.dataset.removePayment);
        if (!Number.isInteger(index) || !state.payments[index] || (state.payments.length === 1 && !state.payments[0].amount && !state.payments[0].date)) return;
        if (state.payments.length > 1) {
          rowMotionPending = true;
          try { await collapseRowMotion(b.closest('.payment-entry')); } finally { rowMotionPending = false; }
        }
        rememberUndo(); calendarField = null; calendarView = null;
        state.payments.splice(index, 1);
        if (!state.payments.length) state.payments.push({ amount: '', date: '' });
        state.deposit = deposit() > 0 ? deposit().toFixed(2) : '';
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-payment="${Math.min(index, state.payments.length - 1)}"]`)?.focus();
        return;
      }
      if (b.hasAttribute('data-add')) {
        lineAssist = null;
        rememberUndo();
        const limited=writingIds().items.findIndex(key=>descriptionLimits.get(`${state.id}:${key}`));
        if(limited>=0) {
          const item=state.items[limited],text=item.description,draft=copy(state);
          let low=0,high=text.length;
          while(low<high){const mid=Math.ceil((low+high)/2);if(await descriptionFitsPage(draft,text.slice(0,mid)))low=mid;else high=mid-1;}
          const boundaries=[...text.slice(0,low).matchAll(/[.!?](?=\s|$)|\n/g)];
          let split=boundaries.at(-1)?.index;
          if(split!==undefined)split++;
          else split=text.lastIndexOf(' ',low);
          if(!split||split<1){notice('Raccourcissez la première phrase avant de continuer sur une nouvelle ligne.');return;}
          item.description=text.slice(0,split).trimEnd();
          const ids=writingIds();
          state.items.splice(limited+1,0,{description:text.slice(split).trimStart(),quantity:'1',price:'0',pageBreakBefore:true});
          ids.items.splice(limited+1,0,`items:${++writingSequence}`);
          descriptionLimits.delete(`${state.id}:${writingIds().items[limited]}`);
          render();markDirty();void saveNow();void validateDescriptionLimits();
          document.querySelector(`[data-item="${limited+1}"][data-key="description"]`)?.focus();return;
        }
        const near=writingIds().items.findIndex(key=>key===lastDescriptionKey&&descriptionNearLimits.has(`${state.id}:${key}`));
        if(near>=0){const ids=writingIds();state.items.splice(near+1,0,{description:'',quantity:'1',price:'0',pageBreakBefore:true});ids.items.splice(near+1,0,`items:${++writingSequence}`);descriptionNearLimits.delete(`${state.id}:${lastDescriptionKey}`);render();markDirty();void saveNow();document.querySelector(`[data-item="${near+1}"][data-key="description"]`)?.focus();return;}
        state.items.push({ description: '', quantity: '1', price: '' });
        render(); markDirty(); void saveNow();
        document.querySelector(`[data-item="${state.items.length - 1}"][data-key="description"]`)?.focus();
        return;
      }
      if (b.dataset.remove !== undefined) {
        const index = Number(b.dataset.remove), item = state.items[index];
        if (!Number.isInteger(index) || !item || (state.items.length === 1 && !item.description && !item.price && Number(String(item.quantity).replace(',', '.')) === 1)) return;
        if (state.items.length > 1) {
          rowMotionPending = true;
          try { await collapseRowMotion(b.closest('.line-entry')); } finally { rowMotionPending = false; }
        }
        lineAssist = null;
        rememberUndo();
        writingIds().items.splice(index,1);state.items.splice(index, 1);
        if (!state.items.length) state.items.push({ description: '', quantity: '1', price: '' });
        render(); markDirty(); void saveNow();
        return;
      }
      if (b.hasAttribute('data-save-draft')) { if (await saveNow(true)) notice('Brouillon enregistré dans Documents. Vous pourrez le reprendre plus tard.'); return; }
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
      if (b.hasAttribute('data-pdf')) { await exportDocument(); return; }
      if (b.hasAttribute('data-print')) { await printDocument(); return; }
    });
    document.addEventListener('input', event => {
      const el = event.target;
      if (el.hasAttribute('data-library-search')) { documentLibrary.handleInput(el); return; }
      if (!state || busy) return;
      if (el.id === 'next-number') {
        numberError = '';
        document.querySelector('.number-popover.number-error')?.remove();
        return;
      }
      if (el.hasAttribute('data-assist-proposal')) {
        if (lineAssist && !lineAssist.recording && !lineAssist.processing) {
          lineAssist.proposal = el.value;
          fitTextareas(el.parentElement);
        }
        return;
      }
      if (el.dataset.note !== undefined) {
        const index = Number(el.dataset.note), entries = noteRows(state);
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
        rememberUndo(`${state.id}:note:${index}`);
        const previous = entries[index]; entries[index] = el.value;
        try { setNoteRows(state, entries); }
        catch (error) { el.value = previous; notice(errorText(error)); return; }
        releaseVoiceField(voiceSession, 'notes'); releaseVoiceField(voiceRecovery?.session, 'notes');
      } else if (el.dataset.field) {
        rememberUndo(`${state.id}:field:${el.dataset.field}`);
        if (el.dataset.field === 'contact') formatPhoneInput(el);
        state[el.dataset.field] = el.value;
        if (el.dataset.field === 'notes') setNoteRows(state, [el.value]);
        releaseVoiceField(voiceSession, el.dataset.field);
        releaseVoiceField(voiceRecovery?.session, el.dataset.field);
      } else if (el.dataset.payment !== undefined) {
        const index = Number(el.dataset.payment);
        if (!state.payments[index]) return;
        rememberUndo(`${state.id}:payment:${index}`);
        state.payments[index].amount = el.value;
        state.deposit = deposit() > 0 ? deposit().toFixed(2) : '';
      } else if (el.dataset.item !== undefined) {
        const index = Number(el.dataset.item);
        if (!state.items[index]) return;
        rememberUndo(`${state.id}:item:${index}:${el.dataset.key}`);
        state.items[index][el.dataset.key] = el.value;
        releaseVoiceItem(voiceSession, index, el.dataset.key);
        releaseVoiceItem(voiceRecovery?.session, index, el.dataset.key);
      } else return;
      const wasEnglish = englishMode;
      automatic.reconcile();paintWritingStatus();
      if(el.dataset.item!==undefined&&el.dataset.key==='description'){lastDescriptionKey=writingIds().items[Number(el.dataset.item)];void validateDescriptionLimits();}
      markDirty();
      if (wasEnglish && !englishMode) {
        const paper = document.querySelector('.preview-page');
        if (paper) paper.innerHTML = preview();
        for (const [selector, selected] of [['[data-show-french]', true], ['[data-show-english]', false]]) {
          const button = document.querySelector(selector);
          button?.classList.toggle('active', selected);
          button?.setAttribute('aria-pressed', String(selected));
        }
      }
      sync();
      paintValidation();
      if (el.tagName === 'TEXTAREA') fitTextareas(el.parentElement);
    });
    document.addEventListener('change', event => {
      const el = event.target;
      if(el.dataset.taxSetting) { rememberUndo(); updateTax(state,{[el.dataset.taxSetting]:el.value}); markDirty(); sync(); paintValidation(); void saveNow(); return; }
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
      const calendar=document.querySelector(`[data-date-wrap="${field}"] .date-popover`); closePanelMotion(calendar); calendar?.remove();
      document.querySelectorAll(`[data-calendar="${field}"], [data-date-display="${field}"]`).forEach(el => el.setAttribute('aria-expanded', 'false'));
    });
    document.addEventListener('focusout', event => {
      if (event.target.dataset.field || event.target.dataset.note !== undefined || event.target.dataset.item !== undefined || event.target.dataset.payment !== undefined) {
        undoGroup = null;
        if(event.target.dataset.field)formatEnteredField(event.target.dataset.field);
        const key=event.target.dataset.note!==undefined?writingIds().notes[Number(event.target.dataset.note)]
          :event.target.dataset.item!==undefined&&event.target.dataset.key==='description'?writingIds().items[Number(event.target.dataset.item)]:null;
        const toStar=event.relatedTarget?.closest?.('[data-line-enhance]');
        const queued=key&&improvements.snapshot(state.id).jobs.some(j=>j.key===key&&['waiting','running'].includes(j.status));
        if(key&&!toStar&&!queued)void automatic.schedule(key);
        void saveNow();
      }
    });
    document.addEventListener('beforeinput',event=>{
      const el=event.target;
      if(!state||el.dataset.item===undefined||el.dataset.key!=='description'||!event.inputType?.startsWith('insert'))return;
      const key=writingIds().items[Number(el.dataset.item)];
      if(descriptionLimits.get(`${state.id}:${key}`)&&!['.','!','?'].includes(event.data)){
        event.preventDefault();notice('La limite d’une page est atteinte. Utilisez Ajouter une ligne pour continuer.');
      }
    });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        const button = document.querySelector('[data-print]');
        if (button && !button.disabled && !button.closest('[inert]')) button.click();
        return;
      }
      if (event.target.id === 'next-number') {
        if (event.key === 'Enter') { event.preventDefault(); document.querySelector('[data-stage-number]')?.click(); return; }
        if (event.key === 'Escape') {
          event.preventDefault(); numberEditing = false; numberConfirm = null; numberError = '';
          render(); document.querySelector('[data-edit-number]')?.focus(); return;
        }
      }
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
       if (event.key === 'Escape' && preferencesOpen) { if (appearanceOpen) { appearanceOpen=false; render(); document.querySelector('[data-appearance]')?.focus(); } else closePreferences(); return; }
       if (event.key === 'Escape' && settingsOpen) { closeAiSettings(); return; }
       if (event.key === 'Escape' && folderOpen) { closeFolder(); return; }
       if (event.key === 'Escape' && updateOpen) { closeUpdate(); return; }
       if (event.key === 'Escape' && recentOpen) { const back = document.querySelector('[data-library-action="cancel-delete"], [data-library-action="cancel-restore"], [data-library-action="close-preview"], [data-library-action="close-history"]'); if (back) back.click(); else closeRecent(); return; }
       if (event.key === 'Tab' && (recentOpen || updateOpen || folderOpen || settingsOpen || preferencesOpen)) {
         const dialog = document.querySelector(preferencesOpen ? '.preferences-panel' : settingsOpen ? '.ai-settings-panel' : folderOpen ? '.folder-panel' : updateOpen ? '.update-panel' : '.recent-panel');
        const focusable = Array.from(dialog?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]') || []).filter(el=>!el.closest('[hidden],[inert]') && el.getClientRects().length);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (document.activeElement===dialog || !dialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) void saveNow(); });
    window.addEventListener('beforeunload', () => { if (editRevision !== savedRevision) void saveNow(); });
    void loadState();
