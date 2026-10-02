import {
  PDFDocument, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, rectangle, clip, endPath, setWordSpacing,
} from 'pdf-lib';
import { paymentRows, paymentTotal, customerPayments } from './payments.js';
import { previewTaxTotals, numericAmount, calculateTaxTotals, taxIssue, taxLabel, taxRegistration, documentLocation } from './taxes.js';
import { formatPhone } from './phone.js';

// This is the existing mockup artwork. Only its wood-grain symbol is clipped
// into the PDF; the lettering in the PNG is never drawn.
const LOGO_PNG_BASE64 = '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';
const LOGO_CROP = { x: 134, y: 43, width: 108, height: 160 };

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 42;
const RIGHT = 570;
const FOOTER_TOP = 738;
const ITEM_BOTTOM = 715;
const ITEM_LINE = 13;

const ink = rgb(0.15, 0.19, 0.18);
const brown = rgb(0.43, 0.31, 0.25);
const muted = rgb(0.39, 0.44, 0.41);
const rule = rgb(0.84, 0.88, 0.85);

const LABELS = {
  fr: {
    common: {
      project: 'PROJET', documentDate: 'DATE DU DOCUMENT', billingAddress: 'Adresse de facturation',
      clientPhone: 'Téléphone du client', clientEmail: 'Courriel du client', shipTo: 'Livrer à',
      issuedBy: 'Émis par', phone: 'Tél.', email: 'Courriel :',
      description: 'DESCRIPTION', quantity: 'QTÉ', unitPrice: 'PRIX UNITAIRE', amount: 'MONTANT',
      line: 'LIGNE', continued: 'SUITE', subtotal: 'Sous-total',
      gst: 'TPS (5 %)', qst: 'TVQ (9,975 %)', total: 'Total avec taxes',
      noteDetails: 'Note détaillée', previousPayments: 'Versements précédents',
      note: 'NOTE POUR LE CLIENT', noDate: 'Aucune', paymentNoDate: 'Date non précisée', invoiceNumber: 'Facture n°',
      gstId: 'TPS', qstId: 'TVQ', subject: 'Document client',
    },
    soumission: {
      title: 'Soumission', party: 'Proposition pour', date: 'Valide jusqu’au',
      deposit: 'Total des dépôts', payments: 'DÉPÔTS DEMANDÉS', balance: 'Balance',
    },
    facture: {
      title: 'Facture', party: 'Facturé à', date: 'Date limite de paiement',
      deposit: 'Total reçu', payments: 'PAIEMENTS REÇUS', balance: 'Balance',
    },
  },
  en: {
    common: {
      project: 'PROJECT', documentDate: 'DOCUMENT DATE', billingAddress: 'Billing address',
      clientPhone: 'Client phone', clientEmail: 'Client email', shipTo: 'Ship to',
      issuedBy: 'Issued by', phone: 'Phone', email: 'Email:',
      description: 'DESCRIPTION', quantity: 'QTY', unitPrice: 'UNIT PRICE', amount: 'AMOUNT',
      line: 'LINE', continued: 'CONTINUED', subtotal: 'Subtotal',
      gst: 'GST (5%)', qst: 'QST (9.975%)', total: 'Total incl. tax',
      noteDetails: 'Detailed note', previousPayments: 'Earlier payments',
      note: 'NOTE FOR CUSTOMER', noDate: 'None', paymentNoDate: 'Date not specified', invoiceNumber: 'Invoice no.',
      gstId: 'GST', qstId: 'QST', subject: 'Customer document',
    },
    soumission: {
      title: 'Quote', party: 'Prepared for', date: 'Valid until',
      deposit: 'Total deposits', payments: 'DEPOSITS REQUESTED', balance: 'Balance after deposit',
    },
    facture: {
      title: 'Invoice', party: 'Bill to', date: 'Payment due',
      deposit: 'Total received', payments: 'PAYMENTS RECEIVED', balance: 'Balance due',
    },
  },
};

function roundCents(amount) {
  const cents = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error('Montant trop élevé pour le PDF.');
  return cents;
}

function amount(value, label, { positive = false, optional = false } = {}) {
  const input = String(value ?? '').trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (optional && !input) return 0;
  if (!input || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) {
    throw new Error(`${label} invalide.`);
  }
  const number = Number(input);
  if (!Number.isFinite(number) || (positive && number <= 0)) {
    throw new Error(`${label} invalide.`);
  }
  return number;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} obligatoire pour le PDF.`);
  return text;
}

function displayDate(value, required = true, language = 'fr') {
  if (!value && !required) return LABELS[language].common.noDate;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error('Date invalide pour le PDF.');
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month || date.getUTCDate() !== +day) {
    throw new Error('Date invalide pour le PDF.');
  }
  return language === 'en' ? `${year}-${month}-${day}` : `${day}/${month}/${year}`;
}

function readItems(draft) {
  if (!Array.isArray(draft.items)) throw new Error('Au moins une ligne de travail est requise.');
  const items = [];
  draft.items.forEach((item, index) => {
    const description = String(item?.description ?? '').trim();
    const rawPrice = String(item?.price ?? '').trim();
    if (!description && !rawPrice) return;
    if (!description) throw new Error(`Description obligatoire à la ligne ${index + 1}.`);
    const quantity = amount(item?.quantity, `Quantité de la ligne ${index + 1}`, { positive: true });
    const price = amount(item?.price, `Prix de la ligne ${index + 1}`);
    items.push({ description, quantity, price, lineNumber: index + 1, pageBreakBefore: item.pageBreakBefore === true });
  });
  if (!items.length) throw new Error('Au moins une ligne de travail est requise.');
  return items;
}

// Kept pure so the frontend can compare its preview with the PDF amounts.
export function calculateTotals(draft) {
  readItems(draft);
  customerPayments(draft);
  return Object.freeze(calculateTaxTotals(draft, paymentTotal(draft)));
}

const money = (value, language = 'fr') => value === null ? (language === 'en' ? 'To confirm' : 'À confirmer') : new Intl.NumberFormat(language === 'en' ? 'en-CA' : 'fr-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 2,
}).format(value);

// pdf-lib's built-in font uses WinAnsi. It covers French accents and the bullet
// glyph. Convert only unsupported characters to readable alternatives.
function pdfText(value, font) {
  const input = String(value ?? '').normalize('NFC')
    .replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/[\u00a0\u202f]/g, ' ').replace(/[\u200b\u2060]/g, '')
    .replace(/[\u2010-\u2015]/g, '-').replace(/\u2028|\u2029/g, '\n');
  let output = '';
  for (const char of input) {
    if (char === '\n') { output += char; continue; }
    if (char < ' ' || char === '\u007f') continue;
    try { font.encodeText(char); output += char; }
    catch {
      const decomposed = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      for (const part of decomposed) {
        try { font.encodeText(part); output += part; }
        catch { output += '?'; }
      }
    }
  }
  return output;
}

// Standard-font Tj drawing uses glyph advances without pair kerning.
function glyphWidth(text, font, size) {
  return Array.from(text).reduce((sum, char) => sum + font.widthOfTextAtSize(char, size), 0);
}

function wrapText(value, font, size, width, description = false) {
  const lines = [];
  const append = (text, justify = false) => lines.push(description ? {text, justify} : text);
  const measure = text => glyphWidth(text, font, size);
  const splitLong = word => {
    let piece = '';
    const pieces = [];
    for (const char of word) {
      if (piece && measure(piece + char) > width) {
        pieces.push(piece); piece = '';
      }
      piece += char;
    }
    if (piece) pieces.push(piece);
    return pieces;
  };
  for (const paragraph of pdfText(value, font).split('\n')) {
    if (!paragraph.trim()) { append(''); continue; }
    const bullet = /^([•‣▪◦*-])\s+/.test(paragraph) ? '  ' : '';
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) { append(line, true); line = bullet; }
      for (const piece of splitLong(word)) {
        const next = line.trim() ? `${line} ${piece}` : line + piece;
        if (measure(next) <= width) line = next;
        else { if (line.trim()) append(line, true); line = bullet + piece; }
      }
    }
    append(line);
  }
  return lines;
}

function drawText(page, value, x, top, font, size, color = ink) {
  const text = pdfText(value, font);
  if (text) page.drawText(text, { x, y: PAGE_H - top - size, font, size, color });
}

function drawRight(page, value, right, top, font, size, color = ink) {
  const text = pdfText(value, font);
  drawText(page, text, right - glyphWidth(text, font, size), top, font, size, color);
}

function drawRule(page, top, x1 = LEFT, x2 = RIGHT, color = rule, thickness = 0.8) {
  page.drawLine({ start: { x: x1, y: PAGE_H - top }, end: { x: x2, y: PAGE_H - top }, color, thickness });
}

function drawLines(page, lines, x, top, font, size, leading, color = ink) {
  lines.forEach((line, index) => drawText(page, line.text ?? line, x, top + index * leading, font, size, color));
}

function drawDescriptionLines(page, lines, x, top, font, size, leading, width, color = ink) {
  lines.forEach((line, index) => {
    const indent = line.text.match(/^ */)[0];
    const text = line.text.slice(indent.length);
    const gaps = (text.match(/ /g) || []).length;
    const indentWidth = font.widthOfTextAtSize(indent, size);
    const extra = width - indentWidth - glyphWidth(text, font, size);
    if (gaps && extra !== 0 && (line.justify || extra < 0)) {
      // Scope PDF text state so justification cannot affect numeric columns.
      page.pushOperators(pushGraphicsState(), setWordSpacing(extra / gaps));
      drawText(page, text, x + indentWidth, top + index * leading, font, size, color);
      page.pushOperators(popGraphicsState());
    } else {
      drawText(page, line.text, x, top + index * leading, font, size, color);
    }
  });
}

function drawLogo(page, image) {
  const x = LEFT + 1;
  const top = 24;
  const scale = 0.24;
  const { x: cropX, y: cropY, width, height } = LOGO_CROP;
  page.pushOperators(
    pushGraphicsState(),
    rectangle(x, PAGE_H - top - height * scale, width * scale, height * scale),
    clip(), endPath(),
  );
  page.drawImage(image, {
    x: x - cropX * scale,
    y: PAGE_H - top + cropY * scale - image.height * scale,
    width: image.width * scale,
    height: image.height * scale,
  });
  page.pushOperators(popGraphicsState());
}

function drawHeader(page, context, first) {
  const { normal, bold, logo, labels, number } = context;
  if (first) {
    drawLogo(page, logo);
    drawText(page, 'ÉBÉNISTERIE', 84, 24, bold, 17, brown);
    drawText(page, "DE L'HERMITAGE INC.", 84, 48, bold, 10, brown);
    drawRight(page, labels.title, RIGHT, 25, bold, 28);
    if (number !== null) drawRight(page, `${labels.invoiceNumber} ${number}`, RIGHT, 58, normal, 10, muted);
    drawRule(page, 76, LEFT, RIGHT, brown, 1.7);
    return 88;
  }
  drawText(page, "Ébénisterie de l'Hermitage inc.", LEFT, 42, bold, 11, brown);
  drawRight(page, number === null ? `${labels.title} · ${labels.continued.toLowerCase()}` :
    `${labels.invoiceNumber} ${number} · ${labels.continued.toLowerCase()}`,
    RIGHT, 42, normal, 10, muted);
  drawRule(page, 65, LEFT, RIGHT, brown, 1.2);
  return 82;
}

function drawSummary(page, draft, context, top) {
  const { normal, bold, labels } = context;
  const project = String(draft.project ?? '').trim();
  const projectLines = project ? wrapText(project, bold, 12, 246) : [];
  drawText(page, labels.project, LEFT, top, bold, 9, brown);
  drawLines(page, projectLines, LEFT, top + 17, bold, 12, 15);
  drawText(page, labels.documentDate, 316, top, bold, 9, brown);
  drawText(page, displayDate(draft.date, true, context.language), 316, top + 18, bold, 11);
  drawText(page, labels.date.toUpperCase(), 435, top, bold, 9, brown);
  drawText(page, displayDate(context.kind === 'facture' ? draft.dueDate : draft.validUntil,
    context.kind !== 'facture', context.language), 435, top + 18, bold, 11);
  const bottom = top + Math.max(40, 20 + projectLines.length * 15);
  drawRule(page, bottom);
  return bottom + 12;
}

function partyContent(draft, context) {
  const { normal, bold, labels } = context;
  const client = wrapText(draft.client, bold, 12, 225);
  const address = wrapText(draft.address, normal, 10, 225, true);
  const contact = draft.contact?.trim() ? wrapText(`${labels.phone} ${formatPhone(draft.contact)}`, normal, 10, 225) : [];
  const email = draft.email?.trim() ? wrapText(`${labels.email} ${draft.email}`, normal, 10, 225) : [];
  const location=documentLocation(draft,context.language);
  const ship = location.address.trim() ? wrapText(location.address, normal, 10, 225, true) : [];
  return { client, address, contact, email, ship };
}

function partyHeight(info) {
  const clientHeight = 23 + info.client.length * 15 + 2 +
    (info.address.length + info.contact.length + info.email.length) * 12 + 10;
  const companyHeight = info.ship.length ? 94 + info.ship.length * 12 + 8 : 88;
  return Math.max(88, clientHeight, companyHeight);
}

function drawParties(page, draft, context, top) {
  const { normal, bold, labels } = context;
  const info = partyContent(draft, context);
  const leftX = LEFT;
  const rightX = 311;
  const width = 259;
  const height = partyHeight(info);
  for (const x of [leftX, rightX]) {
    page.drawRectangle({ x, y: PAGE_H - top - height, width, height, borderColor: rule, borderWidth: 0.8 });
  }
  let y = top + 8;
  drawText(page, labels.party.toUpperCase(), leftX + 13, y, bold, 9, brown);
  y += 15;
  drawLines(page, info.client, leftX + 13, y, bold, 12, 15);
  y += info.client.length * 15 + 2;
  for (const lines of [info.address, info.contact, info.email]) {
    if (lines === info.address) drawDescriptionLines(page, lines, leftX + 13, y, normal, 10, 12, 225, muted);
    else drawLines(page, lines, leftX + 13, y, normal, 10, 12, muted);
    y += lines.length * 12;
  }
  drawText(page, labels.issuedBy.toUpperCase(), rightX + 13, top + 8, bold, 9, brown);
  drawText(page, "Ébénisterie de l'Hermitage inc.", rightX + 13, top + 23, bold, 11);
  drawLines(page, ['68, chemin des guides', 'Ripon (Qc) J0V 1V0', '(819) 428-7690'], rightX + 13, top + 38, normal, 10, 12, muted);
  if (info.ship.length) {
    drawRule(page, top + 74, rightX + 13, rightX + width - 13);
    drawText(page, labels.shipTo.toUpperCase(), rightX + 13, top + 80, bold, 9, brown);
    drawDescriptionLines(page, info.ship, rightX + 13, top + 94, normal, 10, 12, 225, muted);
  }
  return top + height + 12;
}

// Very long names, addresses or project text use a full-width flow instead of
// letting the mockup's two-column cards run off a Letter page.
function drawFlowDetails(doc, draft, context, initialPage, initialTop) {
  const { normal, bold, labels, kind } = context;
  let page = initialPage;
  let cursor = initialTop;
  const next = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursor = drawHeader(page, context, false);
  };
  const field = (label, value) => {
    if (!String(value ?? '').trim()) return;
    const lines = wrapText(value, normal, 10.5, RIGHT - LEFT, true);
    if (cursor + 38 > ITEM_BOTTOM) next();
    drawText(page, label.toUpperCase(), LEFT, cursor, bold, 9, brown);
    cursor += 18;
    for (const line of lines) {
      if (cursor + 15 > ITEM_BOTTOM) next();
      drawDescriptionLines(page, [line], LEFT, cursor, normal, 10.5, 15, RIGHT - LEFT);
      cursor += 15;
    }
    cursor += 12;
  };
  field(labels.project, draft.project);
  field(labels.documentDate, displayDate(draft.date, true, context.language));
  field(labels.date, displayDate(kind === 'facture' ? draft.dueDate : draft.validUntil,
    kind !== 'facture', context.language));
  field(labels.party, draft.client);
  field(labels.billingAddress, draft.address);
  field(labels.clientPhone, formatPhone(draft.contact));
  field(labels.clientEmail, draft.email);
  field(labels.shipTo, documentLocation(draft,context.language).address);
  field(labels.issuedBy, "Ébénisterie de l'Hermitage inc.\n68, chemin des guides\nRipon (Qc) J0V 1V0\n(819) 428-7690");
  return { page, cursor };
}

function drawTableHeader(page, context, top) {
  const { bold, labels } = context;
  drawText(page, labels.description, LEFT + 6, top + 5, bold, 9, brown);
  drawText(page, labels.quantity, 341, top + 5, bold, 9, brown);
  drawRight(page, labels.unitPrice, 466, top + 5, bold, 9, brown);
  drawRight(page, labels.amount, RIGHT, top + 5, bold, 9, brown);
  drawRule(page, top + 22, LEFT, RIGHT, brown, 1.3);
  return top + 23;
}

function drawItem(page, context, item, lines, top, showNumbers, continuationLine = null) {
  const { normal, bold, labels, language } = context;
  const cueHeight = continuationLine === null ? 0 : 17;
  const height = Math.max(26, lines.length * ITEM_LINE + 13 + cueHeight);
  if (continuationLine !== null) {
    drawText(page, `${labels.line} ${continuationLine} · ${labels.continued}`, LEFT + 6, top + 8, bold, 8.5, brown);
  }
  drawDescriptionLines(page, lines, LEFT + 6, top + 8 + cueHeight, normal, 10.5, ITEM_LINE, 276);
  if (showNumbers) {
    const quantity = new Intl.NumberFormat(language === 'en' ? 'en-CA' : 'fr-CA', { maximumFractionDigits: 6 }).format(item.quantity);
    const qtyWidth = glyphWidth(pdfText(quantity, normal), normal, 10);
    drawText(page, quantity, 355 - qtyWidth / 2, top + 8, normal, 10);
    drawRight(page, money(item.price, language), 466, top + 8, normal, 10);
    drawRight(page, money(item.chargeCents / 100, language), RIGHT, top + 8, normal, 10);
  }
  drawRule(page, top + height, LEFT, RIGHT, rule, 0.6);
  return top + height;
}

function pageReference(label, first, last, language) {
  const range = first === last ? `page ${first}` : language === 'en' ? `pages ${first}-${last}` : `pages ${first} à ${last}`;
  return `${label} : ${range}.`;
}

// The same measured geometry drives page allocation and editor admission.
function identityHeight(draft, context) {
  const projectLines = String(draft.project || '').trim() ? wrapText(draft.project, context.bold, 12, 246).length : 0;
  return 88 + Math.max(40, 20 + projectLines * 15) + 12 + partyHeight(partyContent(draft, context)) + 12 + 23;
}

function closingHeight(notes, payments, paymentPointer = false) {
  const left = 28 + (notes.length ? 18 + notes.length * 14 + 18 : 0)
    + (payments.length ? 18 + payments.length * 24 : 0) + (paymentPointer ? 28 : 0);
  return Math.max(payments.length ? 164 : 125, left);
}

function measureLayout(draft, context) {
  let tableTop = identityHeight(draft, context);
  // Unbounded legacy identity fields are preserved on detail pages. Work pages
  // repeat compact references to that identity rather than clipping its text.
  const identityOverflow = tableTop + 43 + 12 + 164 > 724;
  if (identityOverflow) tableTop = 88 + 52 + 76 + 23;
  const allPayments = customerPayments(draft);
  const originalNotes = String(draft.notes || '').trim() ? wrapText(draft.notes, context.normal, 10, 219, true) : [];
  const maximumClosing = 724 - tableTop - 43 - 12;
  const supportOverflow = closingHeight(originalNotes, allPayments) > maximumClosing;
  // Reference width has room for any realistic page count. Actual references
  // are wrapped and checked again before the final work page is rendered.
  const notes = supportOverflow && originalNotes.length ? [{text:context.labels.noteDetails + ' : pages 000000-000000.', justify:false}] : originalNotes;
  const payments = supportOverflow ? allPayments.slice(-3) : allPayments;
  const previousPayments = supportOverflow ? allPayments.slice(0, -3) : [];
  const height = closingHeight(notes, payments, previousPayments.length > 0);
  const finalCapacity = Math.max(0, 724 - height - 12 - tableTop);
  return {tableTop, identityOverflow, originalNotes, allPayments, notes, payments, previousPayments, supportOverflow, height,
    regularCapacity:ITEM_BOTTOM - tableTop, finalCapacity};
}

function drawWorkIdentity(page, draft, context, layout, identityReference) {
  let cursor = drawHeader(page, context, true);
  if (!layout.identityOverflow) {
    cursor = drawSummary(page, draft, context, cursor);
    cursor = drawParties(page, draft, context, cursor);
  } else {
    // Complete original values are on the referenced pages; do not truncate.
    drawText(page, context.labels.project, LEFT, cursor, context.bold, 9, brown);
    drawText(page, identityReference, LEFT, cursor + 17, context.bold, 12);
    drawText(page, context.labels.documentDate, 316, cursor, context.bold, 9, brown);
    drawText(page, displayDate(draft.date, true, context.language), 316, cursor + 18, context.bold, 11);
    drawText(page, context.labels.date.toUpperCase(), 435, cursor, context.bold, 9, brown);
    drawText(page, displayDate(context.kind === 'facture' ? draft.dueDate : draft.validUntil,
      context.kind !== 'facture', context.language), 435, cursor + 18, context.bold, 11);
    cursor += 52;
    drawText(page, context.labels.party.toUpperCase(), LEFT, cursor, context.bold, 9, brown);
    drawText(page, identityReference, LEFT, cursor + 17, context.bold, 12);
    drawText(page, context.labels.issuedBy.toUpperCase(), 311, cursor, context.bold, 9, brown);
    drawText(page, "Ébénisterie de l'Hermitage inc.", 311, cursor + 17, context.bold, 11);
    drawLines(page, ['68, chemin des guides', 'Ripon (Qc) J0V 1V0', '(819) 428-7690'], 311, cursor + 34, context.normal, 10, 12, muted);
    cursor += 76;
  }
  return drawTableHeader(page, context, cursor);
}

function rowHeight(lines, continued = false) {
  return Math.max(26, lines.length * ITEM_LINE + 13 + (continued ? 17 : 0));
}

function planWorkPages(items, context, layout) {
  if (layout.finalCapacity < 26 || layout.regularCapacity < 43) throw new Error('Espace insuffisant pour le travail et les totaux.');
  const chunks = [];
  let runningAmount = 0, previousCents = 0;
  for (let item of items) {
    // Cumulative cent rounding reconciles page sums with the unchanged overall
    // calculator, even for fractional quantities/unit prices with half cents.
    runningAmount += item.quantity * item.price;
    const cumulativeCents = roundCents(runningAmount);
    item = {...item, chargeCents:cumulativeCents - previousCents};
    previousCents = cumulativeCents;
    const lines = wrapText(item.description, context.normal, 10.5, 276, true);
    let at = 0;
    while (at < lines.length) {
      const continued = at > 0;
      const capacity = Math.floor((layout.regularCapacity - 13 - (continued ? 17 : 0)) / ITEM_LINE);
      const chunk = lines.slice(at, at + capacity);
      chunks.push({item, lines:chunk, continued, showNumbers:!continued,
        pageBreakBefore:at === 0 && item.pageBreakBefore, height:rowHeight(chunk, continued)});
      at += chunk.length;
    }
  }
  // Legacy rows larger than the admitted final-page capacity can continue,
  // but every word and the charge occur exactly once. New entry uses the API
  // below and explicit manual continuation instead of this compatibility path.
  const last = chunks.at(-1);
  if (last.height > layout.finalCapacity) {
    const count = Math.floor((layout.finalCapacity - 30) / ITEM_LINE);
    if (count < 1) throw new Error('Espace insuffisant pour une description et les totaux.');
    const split = last.lines.length - count;
    const ending = {...last, lines:last.lines.slice(split), continued:true, showNumbers:false, pageBreakBefore:true};
    last.lines = last.lines.slice(0, split); last.height = rowHeight(last.lines, last.continued);
    ending.height = rowHeight(ending.lines, true); chunks.push(ending);
  }
  let finalStart = chunks.length - 1, finalHeight = chunks[finalStart].height;
  while (finalStart > 0 && !chunks[finalStart].pageBreakBefore && finalHeight + chunks[finalStart - 1].height <= layout.finalCapacity) {
    finalStart--; finalHeight += chunks[finalStart].height;
  }
  const pages = []; let rows = [], height = 0;
  for (const chunk of chunks.slice(0, finalStart)) {
    if (rows.length && (chunk.pageBreakBefore || height + chunk.height > layout.regularCapacity)) {
      pages.push(rows); rows = []; height = 0;
    }
    rows.push(chunk); height += chunk.height;
  }
  const finalRows = chunks.slice(finalStart);
  // A single page is possible only if the entire ending group fits its recap.
  if (rows.length && !finalRows[0].pageBreakBefore && height + finalHeight <= layout.finalCapacity) pages.push([...rows, ...finalRows]);
  else {if (rows.length) pages.push(rows); pages.push(finalRows);}
  return pages;
}

// Supporting data precedes the final work page, which always owns the recap.
function drawSupportingDetails(doc, draft, context, layout) {
  const {normal, bold, labels, language} = context;
  let page, cursor = ITEM_BOTTOM;
  const next = () => {page = doc.addPage([PAGE_W, PAGE_H]); cursor = drawHeader(page, context, false);};
  let notesFirst = 0, notesLast = 0, paymentsFirst = 0, paymentsLast = 0;
  if (layout.originalNotes.length) {
    const lines = wrapText(draft.notes, normal, 10.5, 500, true);
    next(); notesFirst = doc.getPageCount();
    drawText(page, labels.note, 56, cursor + 8, bold, 9, muted); cursor += 31;
    for (const line of lines) {
      if (cursor + 15 > ITEM_BOTTOM) {next(); drawText(page, `${labels.note} · ${labels.continued}`, 56, cursor + 8, bold, 9, muted); cursor += 31;}
      drawDescriptionLines(page, [line], 56, cursor, normal, 10.5, 15, 500, muted); cursor += 15;
    }
    notesLast = doc.getPageCount(); cursor += 25;
  }
  if (layout.previousPayments.length) {
    if (cursor + 60 > ITEM_BOTTOM) next();
    paymentsFirst = doc.getPageCount();
    drawText(page, labels.payments, 56, cursor + 8, bold, 9, muted); cursor += 35;
    let lastDot = null;
    for (const payment of layout.previousPayments) {
      if (cursor + 24 > ITEM_BOTTOM) {next(); drawText(page, `${labels.payments} · ${labels.continued}`, 56, cursor + 8, bold, 9, muted); cursor += 35; lastDot = null;}
      const dotY = PAGE_H - cursor - 5;
      if (lastDot !== null) page.drawLine({start:{x:61,y:lastDot},end:{x:61,y:dotY},thickness:1,color:rule});
      page.drawCircle({x:61,y:dotY,size:3,color:muted});
      drawText(page, payment.date ? displayDate(payment.date, true, language) : labels.paymentNoDate, 73, cursor, normal, 10, muted);
      drawRight(page, money(payment.amount, language), RIGHT - 14, cursor, bold, 10);
      lastDot = dotY; cursor += 24;
    }
    paymentsLast = doc.getPageCount();
  }
  return {
    notes:notesFirst ? wrapText(pageReference(labels.noteDetails, notesFirst, notesLast, language), normal, 10, 219, true) : [],
    paymentPointer:paymentsFirst ? pageReference(labels.previousPayments, paymentsFirst, paymentsLast, language) : '',
  };
}

function drawTimelineClosing(page, cursor, context, totals, layout, references) {
  const {normal, bold, labels, language} = context;
  const gray = rgb(.42,.45,.44), border = rgb(.83,.85,.84), white = rgb(1,1,1);
  const notes = layout.supportOverflow ? references.notes : layout.notes;
  const payments = layout.payments, paymentPointer = references.paymentPointer || '';
  const height = closingHeight(notes, payments, !!paymentPointer);
  const top = 724 - height;
  if (cursor + 12 > top) throw new Error('Le plan PDF dépasse la zone réservée aux totaux.');
  const box = (x,w) => page.drawSvgPath(`M 7 0 H ${w-7} Q ${w} 0 ${w} 7 V ${height-7} Q ${w} ${height} ${w-7} ${height} H 7 Q 0 ${height} 0 ${height-7} V 7 Q 0 0 7 0 Z`, {x,y:PAGE_H-top,color:white,borderColor:border,borderWidth:.7});
  const text = (s,x,t,size=10,font=normal,color=ink) => drawText(page,s,x,t,font,size,color);
  const right = (s,x,t,size=10,font=normal,width=120) => {
    const fitted = Math.min(size, width / glyphWidth(pdfText(s,font),font,1));
    drawRight(page,s,x,t,font,fitted);
  };
  const line = t => drawRule(page,t,315,556,border,.6);
  if (notes.length || payments.length) box(42,247);
  box(301,269);
  let leftTop = top + 16;
  if (notes.length) {
    text(labels.note,56,leftTop,8.5,bold,gray); leftTop += 19;
    drawDescriptionLines(page,notes,56,leftTop,normal,10,14,219,gray); leftTop += notes.length*14;
    if (payments.length) {drawRule(page,leftTop+9,56,275,border,.6); leftTop += 23;}
  }
  if (payments.length) {
    text(labels.payments,56,leftTop,8.5,bold,gray); leftTop += 22;
    if (paymentPointer) {text(paymentPointer,56,leftTop,9,normal,gray); leftTop += 26;}
    const firstDot = PAGE_H-leftTop-5;
    page.drawLine({start:{x:61,y:firstDot},end:{x:61,y:firstDot-(payments.length-1)*24},thickness:1,color:border});
    payments.forEach((payment,i) => {
      const t = leftTop+i*24;
      page.drawCircle({x:61,y:PAGE_H-t-5,size:3,color:gray,borderColor:white,borderWidth:1});
      text(payment.date ? displayDate(payment.date,true,language) : labels.paymentNoDate,73,t,10,normal,gray);
      right(money(payment.amount,language),275,t,10,bold,112);
    });
  }
  const rows = [[labels.subtotal,totals.subtotal],...totals.lines.map(tax=>[taxLabel(tax.code,language),tax.amount])];
  if (!totals.tax.province) rows.push([language === 'en' ? 'Taxes to confirm' : 'Taxes à confirmer',null]);
  rows.forEach(([label,amount],i)=>{text(label,315,top+17+i*19,10,normal,gray);right(money(amount,language),556,top+17+i*19);});
  line(top+73);
  text(labels.total,315,top+85,11.5,bold);right(money(totals.total,language),556,top+85,12,bold,109);
  if (totals.deposit>0) {
    text(labels.deposit,315,top+110,10,normal,gray);right(money(totals.deposit,language),556,top+110);
    line(top+height-40);
    text(labels.balance,315,top+height-28,11.5,bold);right(money(totals.balance,language),556,top+height-28,12,bold,109);
  }
}

async function descriptionMeasurement(draft) {
  const doc = await PDFDocument.create();
  const [normal,bold] = await Promise.all([doc.embedFont(StandardFonts.Helvetica),doc.embedFont(StandardFonts.HelveticaBold)]);
  // Admission must be safe for either output language and for incomplete
  // editable drafts. The preview uses the same payment sanitization.
  const capacities = ['fr','en'].map(language => {
    const kind = draft?.kind === 'facture' ? 'facture' : 'soumission';
    const labels = {...LABELS[language].common,...LABELS[language][kind]};
    const safeDraft = previewDraft(draft || {}, language);
    const layout = measureLayout(safeDraft,{normal,bold,labels,language,kind});
    return layout.finalCapacity;
  });
  const maxHeight = Math.max(0,Math.min(...capacities)-13);
  return {normal,maxHeight,maxLines:Math.max(0,Math.floor(maxHeight/ITEM_LINE))};
}

/** Actual 10.5pt/276pt wrapping capacity for one row plus the final recap.
 * maxHeight is the description's line-box budget in points (excludes padding).
 * Both languages are reserved; no PDF, invoice number, or draft is written.
 */
export async function measureDescriptionCapacity(draft) {
  const {maxLines,maxHeight} = await descriptionMeasurement(draft);
  return {maxLines,maxHeight};
}

/** Empty text fits; callers separately validate a required description. */
export async function descriptionFitsPage(draft,text) {
  const {normal,maxLines} = await descriptionMeasurement(draft);
  return wrapText(text,normal,10.5,276,true).length <= maxLines;
}

function previewDraft(draft, language) {
  return {...draft,
    project:draft.project?.trim() || (language === 'en' ? 'Project name' : 'Nom du projet'),
    client:draft.client?.trim() || (language === 'en' ? 'Client name' : 'Nom du client'),
    address:draft.address?.trim() || (language === 'en' ? 'Billing address' : 'Adresse de facturation'),
    payments:paymentRows(draft).filter(row=>numericAmount(row.amount)>0 && numericAmount(row.amount)<=1e9).map(row=>{
      let date=row.date || '';try {if(date)displayDate(date);} catch {date='';}
      return {...row,amount:String(numericAmount(row.amount)),date};
    }),
  };
}

function drawFooters(doc, context) {
  const { normal, labels } = context;
  const count = doc.getPageCount();
  doc.getPages().forEach((page, index) => {
    drawRule(page, FOOTER_TOP);
    const registrations = taxRegistration(context.taxProvince,context.language);
    if (registrations.length < 2) registrations.push(taxRegistration('QC',context.language)[1]);
    registrations.forEach((label,i)=>drawText(page,label,i===0?LEFT:231,750,normal,8.5,muted));
    drawRight(page, `${index + 1} / ${count}`, RIGHT, 750, normal, 8.5, muted);
  });
}

/** Render the supplied draft as-is; the caller is responsible for the selected customer text. */
export async function createPdf(draft, { invoiceNumber = null, language = 'fr', preview = false } = {}) {
  if (language !== 'fr' && language !== 'en') throw new Error('Langue PDF non prise en charge.');
  if (!draft || (draft.kind !== 'soumission' && draft.kind !== 'facture')) throw new Error('Type de document invalide.');
  const kind = draft.kind;
  const labels = { ...LABELS[language].common, ...LABELS[language][kind], shipTo:documentLocation(draft,language).label };
  const number = kind === 'facture' && Number(invoiceNumber) > 0 ? Number(invoiceNumber) : null;
  if (!preview && kind === 'facture' && (!Number.isSafeInteger(number) || number <= 0 || invoiceNumber === null || invoiceNumber === '')) {
    throw new Error('Numéro de facture valide requis pour le PDF.');
  }
  let items, totals;
  if (preview) {
    totals = previewTaxTotals(draft, paymentTotal(draft));
    const original = draft;
    draft = previewDraft(draft, language);
    items = (original.items || []).map((item,index) => ({description:item.description?.trim() || '—', quantity:numericAmount(item.quantity),price:numericAmount(item.price),lineNumber:index+1,pageBreakBefore:item.pageBreakBefore === true}))
      .filter((item,index) => original.items[index].description?.trim() || String(original.items[index].price || '').trim());
    if (!items.length) items = [{description:language === 'en' ? 'No items added' : 'Aucun article ajouté',quantity:0,price:0,lineNumber:1}];
  } else {
    requiredText(draft.project, 'Nom du projet');
    requiredText(draft.client, 'Nom du client');
    requiredText(draft.address, 'Adresse de facturation');
    items = readItems(draft);
    const taxError = taxIssue(draft); if (taxError) throw new Error(taxError);
    totals = calculateTotals(draft);
  }
  displayDate(draft.date, true, language);
  displayDate(kind === 'facture' ? draft.dueDate : draft.validUntil, kind !== 'facture', language);
  const doc = await PDFDocument.create();
  doc.setTitle(`${labels.title}${number === null ? '' : ` ${number}`}`);
  doc.setAuthor("Ébénisterie de l'Hermitage inc.");
  doc.setCreator("Ébénisterie de l'Hermitage inc.");
  doc.setSubject(labels.subject);
  doc.setKeywords([]);
  const [normal, bold, logo] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedPng(LOGO_PNG_BASE64),
  ]);
  const context = { normal, bold, logo, labels, language, kind, number, taxProvince:totals.tax.province };
  const layout = measureLayout(draft, context);
  const workPages = planWorkPages(items, context, layout);
  let identityReference = '';
  if (layout.identityOverflow) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    drawFlowDetails(doc, draft, context, page, drawHeader(page, context, true));
    identityReference = pageReference(labels.project,1,doc.getPageCount(),language);
  }
  let references = {notes:[],paymentPointer:''};
  workPages.forEach((rows,index) => {
    const final = index === workPages.length - 1;
    if (final && layout.supportOverflow) references = drawSupportingDetails(doc,draft,context,layout);
    const page = doc.addPage([PAGE_W,PAGE_H]);
    let cursor = drawWorkIdentity(page,draft,context,layout,identityReference);
    for (const row of rows) cursor = drawItem(page,context,row.item,row.lines,cursor,row.showNumbers,row.continued ? row.item.lineNumber : null);
    if (final) drawTimelineClosing(page,cursor,context,totals,layout,references);
  });
  drawFooters(doc, context);
  return new Uint8Array(await doc.save());
}
