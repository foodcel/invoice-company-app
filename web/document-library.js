import { previewTaxTotals, taxLabel, taxRegistration, documentLocation } from './taxes.js';
import { paymentRows, paymentTotal } from './payments.js';
import { formatPhone } from './phone.js';
import { releaseAfterMotion } from './interactions.js';
import { draftPreview } from './library-pdf-preview.js';

export const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
function amounts(draft) {
  const totals=previewTaxTotals(draft,paymentTotal(draft));
  return {...totals,gross:totals.total,paid:totals.deposit};
}
export const documentTotal = draft => amounts(draft).gross;
export const documentMoney = amount => amount===null ? 'À confirmer' : new Intl.NumberFormat('fr-CA', {style:'currency',currency:'CAD'}).format(Number.isFinite(amount) ? amount : 0);
export const recordTitle = record => record?.draft?.project?.trim() || record?.draft?.client?.trim() || 'Sans titre';
export const canDeleteDraft = record => Boolean(record?.draft && Array.isArray(record.exports) && !record.exports.length && record.draft.issuedNumber == null && !(record.savedVersions || []).some(version => version.snapshot?.issuedNumber != null));
function sentDate(record) {
  // Only receipts bound to saved exports establish local acceptance history.
  // Cached status flags and draft timestamps do not describe a sent snapshot.
  return (record.exports || []).flatMap(entry => entry.sentReceipts || [])
    .map(receipt => receipt.acceptedAt).filter(date => date && Number.isFinite(Date.parse(date)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || '';
}
export function recordStatus(record) {
  if (sentDate(record)) return {label:'Envoyé',className:'sent',icon:'✓'};
  if (record.exports?.length) return {label:'PDF créé',className:'pdf',icon:'▤'};
  return {label:'Brouillon',className:'draft',icon:'◷'};
}
export function filterDocuments(records, kind = 'all', query = '') {
  const words = String(query).trim().toLocaleLowerCase('fr-CA').split(/\s+/).filter(Boolean);
  return records.filter(record => record?.draft && (kind === 'all' || record.draft.kind === kind) &&
    words.every(word => [record.draft.project, record.draft.client, record.draft.issuedNumber, record.draft.invoiceNumber]
      .some(value => String(value ?? '').toLocaleLowerCase('fr-CA').includes(word))));
}
export function savedDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('fr-CA', {dateStyle:'medium',timeStyle:'short'}).format(date);
}
function typeBadge(record) {
  const invoice = record.draft.kind === 'facture';
  const type = invoice ? (record.draft.issuedNumber ? 'Facture n° '+record.draft.issuedNumber : 'Facture') : 'Soumission';
  return `<span class="document-badge ${invoice?'':'quote'}">${escapeText(type)}</span>`;
}
function statusBadge(record) {
  const status = recordStatus(record);
  return `<span class="document-status ${status.className}">${status.icon} ${status.label}</span>`;
}
export function badges(record) {
  return `<div class="library-badges">${typeBadge(record)}${statusBadge(record)}</div>`;
}
export function libraryRows(records, selectedId, renderPaper) {
  if (!records.length) return '<div class="library-empty">Aucun document trouvé.<small>Essayez un autre nom ou numéro.</small></div>';
  return records.map(record => `<button type="button" class="library-row ${record.id===selectedId?'selected':''}" data-select-record="${escapeText(record.id)}" aria-pressed="${record.id===selectedId}"><div class="library-thumbnail" aria-hidden="true"><div class="library-thumbnail-paper">${renderPaper(record.draft)}</div></div><div class="library-row-text"><div class="library-badges">${typeBadge(record)}</div><strong>${escapeText(recordTitle(record))}</strong><small>${escapeText(record.draft.client || 'Client à compléter')} · ${escapeText(savedDate(record.updatedAt))}</small></div><div class="library-row-summary">${statusBadge(record)}<b>${documentMoney(documentTotal(record.draft))}</b></div></button>`).join('');
}
export function libraryDetail(record, renderPaper, magnify = '⌕') {
  if (!record) return '<aside class="library-detail library-empty">Aucun document sélectionné.</aside>';
  const status = recordStatus(record), draft = record.draft;
  const explanation = status.className==='sent' ? `Un PDF enregistré de ce document a été accepté par Outlook le ${savedDate(sentDate(record))}. Le brouillon actuel peut différer du PDF envoyé. Les PDF restent conservés.` : status.className==='pdf' ? 'PDF enregistré. Aucun envoi confirmé dans l’historique local. Le brouillon actuel peut différer du PDF enregistré.' : 'Enregistré pour reprendre plus tard. Aucun PDF créé et aucun envoi confirmé dans l’historique local.';
  const deletion = canDeleteDraft(record) ? `<div class="delete-zone"><button type="button" class="plain-button danger" data-library-action="request-delete">${icon('trash')}Supprimer ce brouillon</button><small>Une confirmation sera demandée.</small></div>` : `<p class="draft-protection">${icon('lock')}<span>Ce document est émis ou possède un PDF. Il reste conservé.</span></p>`;
  return `<aside class="library-detail"><div class="library-detail-head"><h4>${escapeText(recordTitle(record))}</h4><button type="button" class="library-magnify" data-review-record aria-label="Agrandir l’aperçu du document">${magnify}</button></div><button type="button" class="library-paper" data-review-record aria-label="Voir le document en grand"><div class="library-detail-paper" aria-hidden="true">${renderPaper(draft)}</div></button>${badges(record)}<strong class="library-client">${escapeText(draft.client || 'Client à compléter')}</strong><small>${escapeText(savedDate(record.updatedAt))} · ${documentMoney(documentTotal(draft))}</small><p>${escapeText(explanation)}</p><button type="button" class="primary" data-review-record>${status.className==='draft'?'Reprendre le brouillon':'Ouvrir le document'}</button><button type="button" class="plain-button" data-record-history>Versions précédentes</button>${deletion}</aside>`;
}

// Date-only customer fields must not shift to the previous day in local time.
function paperDate(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return String(value);
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return String(value);
  return new Intl.DateTimeFormat('fr-CA', {day:'numeric', month:'long', year:'numeric', timeZone:'UTC'}).format(date);
}

/** Static saved snapshot, never hooked into the live editor's sync selectors. */
export function renderSavedPaper(draft, logo = '') {
  const location=documentLocation(draft);
  const invoice = draft.kind === 'facture', total = amounts(draft);
  const text = escapeText, money = documentMoney;
  const payments = paymentRows(draft).filter(payment => number(payment.amount) > 0);
  const rows = (draft.items || []).map(item => `<tr><td>${text(item.description)}</td><td>${text(item.quantity)}</td><td>${money(number(item.price))}</td><td>${money(round(number(item.quantity) * number(item.price)))}</td></tr>`).join('');
  const valueRow = (label, value, className = '') => `<div${className ? ` class="${className}"` : ''}><span>${label}</span><span>${money(value)}</span></div>`;
  return `<div class="paper doc1 saved-paper">
    <div class="paper-top"><div class="paper-logo"><div class="paper-mark" aria-hidden="true">${logo ? `<img src="${text(logo)}" alt="" width="374" height="339">` : ''}</div><div class="paper-name"><strong>ÉBÉNISTERIE</strong><small>DE L'HERMITAGE INC.</small></div></div><div class="paper-type">${invoice ? 'Facture' : 'Soumission'}${invoice ? `<small>Facture n° ${text(draft.issuedNumber ?? draft.invoiceNumber ?? '—')}</small>` : ''}</div></div>
    <div class="doc1-summary"><div><b>Projet</b><strong class="project-name">${text(draft.project)}</strong></div><div><b>Date du document</b><span>${text(paperDate(draft.date))}</span></div><div><b>${invoice ? 'Date limite de paiement' : 'Valide jusqu’au'}</b><span>${text(paperDate(invoice ? draft.dueDate : draft.validUntil))}</span></div></div>
    <div class="doc1-parties"><div class="doc1-party"><b>${invoice ? 'Facturé à' : 'Proposition pour'}</b><strong>${text(draft.client)}</strong><p><span>${text(draft.address)}</span>${draft.contact?.trim() ? `<br>Tél. ${text(formatPhone(draft.contact))}` : ''}${draft.email?.trim() ? `<br>Courriel : ${text(draft.email)}` : ''}</p>${location.address.trim() ? `<div class="doc1-ship"><b>${text(location.label)}</b><span>${text(location.address)}</span></div>` : ''}</div><div class="doc1-party"><b>Émis par</b><strong>Ébénisterie de l’Hermitage inc.</strong><p>68, chemin des guides<br>Ripon (Qc) J0V 1V0<br>(819) 428-7690</p></div></div>
    <table class="paper-table"><thead><tr><th>Description</th><th>Qté</th><th>Prix unitaire</th><th>Montant</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="doc1-closing"><div class="doc1-extras">${draft.notes?.trim() ? `<div class="doc1-note"><b>Note pour le client</b><p>${text(draft.notes)}</p></div>` : ''}${payments.length ? `<div class="doc1-payments"><b>${invoice ? 'Paiements reçus' : 'Dépôts demandés'}</b>${payments.map(payment => `<div class="payment-detail"><span>${text(paperDate(payment.date) || 'Date non précisée')}</span><strong>${money(round(number(payment.amount)))}</strong></div>`).join('')}</div>` : ''}</div><div class="paper-totals">${valueRow('Sous-total', total.subtotal)}${total.lines.map(line=>valueRow(taxLabel(line.code),line.amount)).join('') || valueRow('Taxes',null)}${valueRow('Total avec taxes', total.gross, 'grand')}${total.paid > 0 ? valueRow(invoice ? 'Total reçu' : 'Total des dépôts', total.paid) + valueRow('Balance', total.balance, 'balance') : ''}</div></div>
    <div class="doc1-footer">${taxRegistration(total.tax.province).map(label=>`<span>${label}</span>`).join('')}</div></div>`;
}

const clone = value => JSON.parse(JSON.stringify(value));
const versionLabel = version => version.type === 'export' ? (version.draft ? 'PDF créé' : 'Ancien PDF · consultation seulement') : 'Brouillon de récupération';
const versionDate = version => savedDate(version.createdAt) || 'Date non disponible';
const canRestore = version => Boolean(version?.restorable === true && version.draft);
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${{
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  facture: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M12 10v8m3-7h-4a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3H9"/>',
  soumission: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>'
}[name]}</svg>`;

/**
 * Main owns state application and the modal focus trap. Callbacks:
 * command(name, args) returns native data; transition(name, args, message)
 * applies a StateResponse and resolves true on success; flush() resolves false
 * if edits could not be saved. render() should mirror library.isOpen to main's
 * recentOpen before painting html(). No native commands run during html().
 */
export function createDocumentLibrary({ getRecords, getState, command, transition, flush, render, notice, logo = '', renderPdf = async (bytes, current) => (await import('./saved-pdf-preview.js')).renderSavedPdf(bytes,current) }) {
  let opened = false, searchOpen = false, newOpen = false, query = '', kind = 'all', selectedId = null;
  let history = null, review = null, restore = null, deletion = null, busy = false;
  let generation = 0, pdfRequest = 0;
  const paint = () => render();
  const fail = error => notice(`Action impossible : ${String(error?.message || error || 'Erreur inconnue')}`);
  const all = () => getRecords() || [];
  const results = () => filterDocuments(all(), kind, query);
  const selected = () => {
    const visible = results();
    return visible.find(record => record.id === selectedId) || visible[0] || null;
  };
  const paper = draft => draftPreview(draft);
  const disabled = condition => condition ? ' disabled' : '';
  const closeButton = action => `<button type="button" class="icon" data-library-action="${action}" aria-label="Fermer"${disabled(busy)}>${icon('close')}</button>`;
  const action = (name, label, primary = false, unavailable = false) => {
    const alias = { 'confirm-open': 'data-confirm-open-record', 'request-restore': 'data-restore-selected', 'confirm-restore': 'data-confirm-restore' }[name];
    return `<button type="button" class="${primary ? 'primary' : 'plain-button'}" data-library-action="${name}"${alias ? ` ${alias}` : ''}${disabled(busy || unavailable)}>${label}</button>`;
  };
  const version = () => history?.versions.find(entry => entry.id === history.selectedId) || null;
  function clearPdf() {
    pdfRequest++;
    if(history?.pdfPreview)releaseAfterMotion(history.pdfPreview.dispose);
    if (history) { history.pdfPreview = null; history.pdfError = ''; history.pdfLoading = false; }
  }
  function reset() {
    clearPdf(); generation++; history = null; review = null; restore = null; deletion = null;
  }
  function close() {
    if (busy) return false;
    reset(); opened = false; paint(); return true;
  }
  function open() {
    if (busy) return false;
    reset(); opened = true; searchOpen = false; newOpen = false; query = ''; kind = 'all';
    selectedId = all().find(record => record.id === getState()?.id)?.id || selected()?.id || null;
    paint(); return true;
  }
  function previewVersion() {
    const entry = version();
    if (!entry) return '<p class="library-empty">Aucune version sélectionnée.</p>';
    // An archived PDF is authoritative, including its saved output language.
    if (entry.path) {
      if (history.pdfLoading) return '<p role="status">Chargement du PDF enregistré…</p>';
      if (history.pdfError) return `<div role="alert"><p>${escapeText(history.pdfError)}</p>${action('retry-pdf', 'Réessayer')}</div>`;
      if (history.pdfPreview) return `<div class="saved-pdf-pages" role="group" aria-label="${escapeText(entry.filename || 'PDF enregistré')}">${history.pdfPreview.pages.map((page,index)=>`<img class="saved-pdf-page" src="${escapeText(page.url)}" width="${page.width}" height="${page.height}" style="--pdf-page-ratio:${page.width/page.height}" alt="Page ${index+1} sur ${history.pdfPreview.pages.length} du PDF enregistré">`).join('')}</div>`;
      return '<p role="status">PDF en attente de chargement.</p>';
    }
    return entry.draft ? paper(entry.draft) : '<p>Aucun aperçu enregistré pour cette version.</p>';
  }
  function versionSummary(entry) {
    return `<strong>${escapeText(versionLabel(entry))}</strong><small>${escapeText(versionDate(entry))}</small>${entry.filename ? `<small>${escapeText(entry.filename)}</small>` : ''}<small>${entry.language === 'en' ? 'Anglais · ' : entry.language === 'fr' ? 'Français · ' : ''}${entry.draft ? documentMoney(documentTotal(entry.draft)) : 'PDF sans brouillon enregistré'}</small>`;
  }
  function html() {
    if (!opened) return '';
    if (deletion) {
      const record = deletion.record;
      return `<div class="recent-backdrop delete-overlay"><section class="recent-panel restore-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-draft-title" aria-describedby="delete-draft-copy" aria-busy="${busy}"><header><h2 id="delete-draft-title">Supprimer ce brouillon ?</h2>${closeButton('cancel-delete')}</header><p id="delete-draft-copy">Ce brouillon et ses versions de récupération seront supprimés de l’application. Cette action est définitive.</p><div class="restore-summary"><strong>${escapeText(recordTitle(record))}</strong><small>${escapeText(record.draft.client || 'Client à compléter')} · ${record.draft.kind === 'facture' ? 'Facture' : 'Soumission'} · ${documentMoney(documentTotal(record.draft))}</small></div>${record.id === getState()?.id ? '<p>Un nouveau document vide du même type remplacera le brouillon ouvert.</p>' : ''}<footer>${action('cancel-delete', 'Annuler')}<button type="button" class="danger-fill" data-library-action="confirm-delete"${disabled(busy)}>Supprimer le brouillon</button></footer></section></div>`;
    }
    // One dialog at a time keeps focus, IDs and accessibility unambiguous.
    if (restore) {
      const entry = restore.version, issued = restore.record.draft.issuedNumber;
      return `<div class="recent-backdrop restore-overlay"><section class="recent-panel restore-dialog library-restore-confirm" role="dialog" aria-modal="true" aria-label="Confirmer la restauration" aria-busy="${busy}"><header><h2>Restaurer cette version ?</h2>${closeButton('cancel-restore')}</header><p>Cette version remplacera le brouillon actuel de ce document.</p><div class="restore-summary"><strong>${escapeText(recordTitle(restore.record))}</strong>${versionSummary(entry)}</div><ul><li>La version actuelle sera conservée comme brouillon de récupération.</li><li>Les versions précédentes et les PDF restent dans l’historique.</li><li>${issued ? `Le même numéro de facture, ${escapeText(issued)}, sera conservé.` : 'Aucun nouveau numéro de facture ne sera émis.'}</li></ul><footer>${action('cancel-restore', 'Annuler')}${action('confirm-restore', 'Confirmer la restauration', true)}</footer></section></div>`;
    }
    if (review) {
      return `<div class="recent-backdrop review-preview"><section class="recent-panel preview-dialog library-review" role="dialog" aria-modal="true" aria-label="Vérifier le document" aria-busy="${busy}"><header><div><h2>Vérifier le document</h2><small>${escapeText(recordTitle(review.record))} · ${escapeText(review.record.draft.client)}</small>${badges(review.record)}</div>${closeButton('close-preview')}</header><div class="large-paper-scroll"><div class="library-full-paper">${paper(review.record.draft)}</div></div><footer>${action('close-preview', 'Retour à la liste')}${action('confirm-open', 'Confirmer et ouvrir ce document', true)}</footer></section></div>`;
    }
    if (history) {
      const entry = version();
      const detail = entry ? `<div class="version-detail-head"><h4>Aperçu de la version</h4></div><div class="history-paper">${entry.path || !entry.draft ? previewVersion() : `<div class="library-detail-paper">${previewVersion()}</div>`}</div><p class="version-disclaimer">${!canRestore(entry) ? 'Consultation seulement : ce PDF ne contient pas de brouillon restaurable.' : ''}</p>` : '';
      return `<div class="recent-backdrop history-overlay"><section class="recent-panel history-dialog library-history" role="dialog" aria-modal="true" aria-label="Versions précédentes"><header><div><h2>Versions précédentes</h2><small>${escapeText(recordTitle(history.record))}</small></div>${closeButton('close-history')}</header><div class="history-body"><div class="version-list"><small>VERSIONS ENREGISTRÉES</small>${history.loading ? '<p role="status">Chargement des versions…</p>' : history.error ? `<p role="alert">${escapeText(history.error)}</p>${action('retry-history', 'Réessayer')}` : history.versions.length ? history.versions.map(item => `<button type="button" data-library-version="${escapeText(item.id)}" class="version-row ${item.id === history.selectedId ? 'selected' : ''}" aria-pressed="${item.id === history.selectedId}"><span class="version-dot"></span>${versionSummary(item)}</button>`).join('') : '<p>Aucune version précédente enregistrée.</p>'}<p>La restauration conserve la version actuelle et les versions précédentes dans l’historique.</p></div><div class="version-detail">${detail}</div></div><footer>${action('close-history', 'Retour aux documents')}<div class="history-actions">${action('request-restore', 'Restaurer cette version', true, !canRestore(entry))}</div></footer></section></div>`;
    }
    const record = selected(), visible = results();
    const filters = [['all', 'Tous'], ['facture', 'Factures'], ['soumission', 'Soumissions']];
    return `<div class="recent-backdrop library-backdrop"><section class="recent-panel library-panel library-dialog r3" role="dialog" aria-modal="true" aria-label="Documents récents"><header class="recent-head library-head"><h3>Documents récents</h3><div class="library-create"><button type="button" class="library-create-trigger" data-library-action="toggle-new" aria-expanded="${newOpen}" aria-controls="library-create-options"><span aria-hidden="true">＋</span>Nouveau</button>${newOpen ? `<div id="library-create-options" class="library-new-actions" role="group" aria-label="Créer un document"><button type="button" data-library-new="facture"${disabled(busy)}>Nouvelle facture</button><button type="button" data-library-new="soumission"${disabled(busy)}>Nouvelle soumission</button></div>` : ''}</div>${closeButton('close')}</header><div class="split-library library-body"><div class="library-left">${toolbarSearch()}<div class="library-filters filters" role="group" aria-label="Type de document">${filters.map(([value, label]) => `<button type="button" data-library-filter="${value}" class="${kind === value ? 'selected' : ''}" aria-pressed="${kind === value}" aria-label="${label} : ${filterDocuments(all(), value, query).length}" title="${label}">${icon(value)}<span class="filter-label">${label}</span><span class="filter-count">${filterDocuments(all(), value, query).length}</span></button>`).join('')}</div></div><div class="recent-list library-list">${all().length ? libraryRows(visible, record?.id, paper) : '<div class="library-empty">Aucun document enregistré.<small>Vos brouillons et PDF apparaîtront ici.</small></div>'}</div></div>${libraryDetail(record, paper, icon('search'))}</div></section></div>`;
  }
  function toolbarSearch() {
    return `<div class="library-toolbar ${searchOpen ? 'search-expanded' : ''}">${searchOpen
      ? `<div class="library-search search">${icon('search')}<input id="library-search-input" type="search" data-library-search data-recent-search aria-label="Rechercher un document" placeholder="Client, projet ou numéro" value="${escapeText(query)}"><button type="button" data-library-action="close-search" aria-label="Fermer la recherche" title="Fermer la recherche">${icon('close')}</button></div>`
      : `<button type="button" class="library-search-toggle" data-library-action="open-search" aria-label="Rechercher un document" title="Rechercher un document" aria-expanded="false">${icon('search')}</button>`}`;
  }
  function searchRects() {
    if (typeof document === 'undefined') return null;
    const toolbar = document.querySelector('.library-toolbar');
    if (!toolbar) return null;
    return Object.fromEntries([...toolbar.querySelectorAll('[data-library-filter]')].map(el => [el.dataset.libraryFilter, el.getBoundingClientRect()]));
  }
  function animateSearch(before) {
    if (!before || typeof document === 'undefined' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const options = { duration:240, easing:'cubic-bezier(.2,.8,.2,1)' };
    for (const el of document.querySelectorAll('[data-library-filter]')) {
      const old = before[el.dataset.libraryFilter], next = el.getBoundingClientRect();
      if (old) el.animate?.([{ transform:`translateX(${old.x - next.x}px)`, opacity:.65 }, { transform:'translateX(0)', opacity:1 }], options);
    }
    if (searchOpen) document.querySelector('.library-search')?.animate?.([
      { clipPath:'inset(0 calc(100% - 52px) 0 0 round 8px)', opacity:.65 },
      { clipPath:'inset(0 0 0 0 round 8px)', opacity:1 }
    ], options);
  }
  async function loadPdf() {
    clearPdf();
    const currentHistory = history, entry = version();
    if (!entry?.path) return;
    const request = pdfRequest, epoch = generation;
    currentHistory.pdfLoading = true; paint();
    try {
      const bytes = await command('read_document_pdf', { id: currentHistory.record.id, path: entry.path });
      if (!opened || epoch !== generation || request !== pdfRequest || history !== currentHistory) return;
      if (!(bytes instanceof Uint8Array) && !(Array.isArray(bytes) && bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255))) throw new Error('Réponse PDF invalide.');
      const data = new Uint8Array(bytes);
      if (data.length < 5 || String.fromCharCode(...data.subarray(0, 5)) !== '%PDF-') throw new Error('Le fichier enregistré n’est pas un PDF valide.');
      const isCurrent = () => opened && epoch === generation && request === pdfRequest && history === currentHistory;
      const preview = await renderPdf(data,isCurrent);
      if (!isCurrent()) { preview.dispose(); return; }
      currentHistory.pdfPreview = preview;
    } catch (error) {
      if (epoch !== generation || request !== pdfRequest || history !== currentHistory) return;
      currentHistory.pdfError = String(error?.message || error || 'Impossible de lire le PDF enregistré.');
    } finally {
      if (opened && epoch === generation && request === pdfRequest && history === currentHistory) { currentHistory.pdfLoading = false; paint(); }
    }
  }
  async function loadHistory(record) {
    clearPdf();
    const epoch = ++generation;
    history = { record: clone(record), versions: [], selectedId: null, loading: true, error: '', pdfPreview: null, pdfError: '', pdfLoading: false };
    review = null; restore = null; paint();
    try {
      const versions = await command('load_document_versions', { id: record.id });
      if (!opened || epoch !== generation) return;
      if (!Array.isArray(versions) || versions.some(entry => !entry || typeof entry.id !== 'string' || !entry.id || !['export', 'recovery'].includes(entry.type)) || new Set(versions.map(entry => entry.id)).size !== versions.length) throw new Error('Réponse des versions invalide.');
      history.versions = clone(versions); history.selectedId = versions[0]?.id || null;
      history.loading = false; paint(); await loadPdf();
    } catch (error) {
      if (opened && epoch === generation) { history.loading = false; history.error = String(error?.message || error); paint(); }
    }
  }
  async function mutate(name, args, message, guard = () => true) {
    busy = true; paint();
    try {
      if (!await flush() || !guard()) return;
      // Main applies backend state and returns a success boolean.
      if (await transition(name, args, message) === true) { reset(); opened = false; }
    } catch (error) { fail(error); }
    finally { busy = false; paint(); }
  }
  function handleInput(input) {
    if (!opened || history || review || restore || deletion || !input?.hasAttribute?.('data-library-search')) return false;
    const selection = [input.selectionStart, input.selectionEnd, input.selectionDirection];
    query = String(input.value ?? ''); selectedId = selected()?.id || null; paint();
    // Main repaints the entire app; keep search usable over consecutive keys.
    if (typeof document !== 'undefined') {
      const replacement = document.querySelector('[data-library-search]');
      replacement?.focus();
      if (replacement && Number.isInteger(selection[0]) && Number.isInteger(selection[1])) replacement.setSelectionRange(selection[0], selection[1], selection[2] || 'none');
    }
    return true;
  }
  async function handleClick(button) {
    if (!opened || !button?.hasAttribute) return false;
    const data = { ...button.dataset };
    for (const [attribute, name] of [['data-confirm-open-record', 'confirm-open'], ['data-restore-selected', 'request-restore'], ['data-confirm-restore', 'confirm-restore']]) {
      if (button.hasAttribute(attribute)) data.libraryAction = name;
    }
    const handled = ['data-library-action', 'data-select-record', 'data-review-record', 'data-record-history', 'data-library-filter', 'data-library-version', 'data-library-new', 'data-confirm-open-record', 'data-restore-selected', 'data-confirm-restore'].some(attribute => button.hasAttribute(attribute));
    if (!handled) return false;
    if (busy || button.disabled) return true;
    if (deletion) {
      if (data.libraryAction === 'cancel-delete') { deletion = null; paint(); if (typeof document !== 'undefined') document.querySelector('[data-library-action="request-delete"]')?.focus(); }
      else if (data.libraryAction === 'confirm-delete') {
        const pending = deletion.record;
        busy = true; paint();
        try {
          if (!await flush()) return true;
          const latest = all().find(record => record.id === pending.id);
          if (!canDeleteDraft(latest)) { deletion = null; notice('Ce brouillon n’est plus disponible pour la suppression.'); return true; }
          if (JSON.stringify(latest.draft) !== JSON.stringify(pending.draft)) { deletion.record = clone(latest); notice('Le brouillon a changé. Vérifiez les nouvelles informations avant de confirmer.'); return true; }
          if (await transition('delete_draft', { id: pending.id, expectedDraft: clone(pending.draft) }, 'Brouillon supprimé.') === true) {
            deletion = null; selectedId = results()[0]?.id || null;
          }
        } catch (error) { fail(error); }
        finally { busy = false; paint(); if (!deletion && typeof document !== 'undefined') document.querySelector('.library-row, [data-library-action="toggle-new"]')?.focus(); }
      }
      return true;
    }
    if (data.libraryAction === 'close') { close(); return true; }
    if (data.libraryAction === 'cancel-restore') { restore = null; paint(); return true; }
    if (restore) {
      if (data.libraryAction === 'confirm-restore') {
        const pending = restore;
        if (canRestore(pending.version)) await mutate('restore_document_version', { id: pending.record.id, versionId: pending.version.id }, 'Version précédente restaurée.');
      }
      return true;
    }
    if (data.libraryAction === 'close-preview') { review = null; paint(); return true; }
    if (data.libraryAction === 'request-restore') {
      const entry = version();
      if (canRestore(entry)) { restore = { record: clone(history.record), version: clone(entry) }; paint(); }
      return true;
    }
    if (review) {
      if (data.libraryAction === 'confirm-open' && review.type === 'record') {
        const pending = review.record;
        await mutate('open_draft', { id: pending.id }, 'Document repris.', () => {
          const latest = all().find(record => record.id === pending.id);
          if (!latest) { notice('Ce document n’est plus disponible.'); review = null; return false; }
          if (JSON.stringify(latest.draft) !== JSON.stringify(pending.draft)) { review.record = clone(latest); notice('Le document a changé. Vérifiez le nouvel aperçu avant de confirmer.'); return false; }
          return true;
        });
      } else if (data.libraryAction === 'retry-pdf') await loadPdf();
      return true;
    }
    if (history) {
      if (data.libraryAction === 'close-history') { clearPdf(); generation++; history = null; paint(); }
      else if (data.libraryAction === 'retry-history') await loadHistory(history.record);
      else if (data.libraryAction === 'retry-pdf') await loadPdf();
      else if (data.libraryVersion && history.versions.some(entry => entry.id === data.libraryVersion)) { clearPdf(); history.selectedId = data.libraryVersion; paint(); await loadPdf(); }
      return true;
    }
    if (data.libraryAction === 'request-delete') {
      if (canDeleteDraft(selected())) { deletion = { record: clone(selected()) }; paint(); if (typeof document !== 'undefined') document.querySelector('[data-library-action="cancel-delete"]:not([aria-label])')?.focus(); }
      return true;
    }
    if (data.libraryAction === 'toggle-new') { newOpen = !newOpen; paint(); return true; }
    if (['open-search', 'close-search'].includes(data.libraryAction)) {
      const before = searchRects();
      newOpen = false;
      searchOpen = data.libraryAction === 'open-search';
      if (!searchOpen) query = '';
      selectedId = selected()?.id || null; paint();
      animateSearch(before);
      if (typeof document !== 'undefined') document.querySelector(searchOpen ? '[data-library-search]' : '[data-library-action="open-search"]')?.focus();
      return true;
    }
    if (data.libraryFilter && ['all', 'facture', 'soumission'].includes(data.libraryFilter)) { newOpen = false; kind = data.libraryFilter; selectedId = selected()?.id || null; paint(); }
    else if (data.selectRecord && results().some(record => record.id === data.selectRecord)) { selectedId = data.selectRecord; paint(); }
    else if (button.hasAttribute('data-review-record') && selected()) { review = { type: 'record', record: clone(selected()) }; paint(); }
    else if (button.hasAttribute('data-record-history') && selected()) await loadHistory(selected());
    else if (['facture', 'soumission'].includes(data.libraryNew)) await mutate('new_draft', { kind: data.libraryNew }, 'Nouveau brouillon créé. Le précédent reste dans Documents récents.');
    return true;
  }
  return { html, open, close, handleClick, handleInput, get isOpen() { return opened; } };
}
