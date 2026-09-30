import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { createPdf } from '../web/pdf.js';
import { sampleDraft } from './fixtures.mjs';

// Read the saved PDF's text operators, not the renderer's cursor or layout helper.
async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes);
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return doc.getPages().map(page => {
    const contents = page.node.Contents();
    assert.ok(contents?.size() > 0, 'PDF page must have a content stream');
    const text = Array.from({ length: contents.size() }, (_, i) =>
      Buffer.from(decodePDFRawStream(doc.context.lookup(contents.get(i))).decode()).toString('latin1')).join('\n');
    const rows = [...text.matchAll(/BT\s([\s\S]*?)ET/g)].map(([, block]) => {
      const font = block.match(/\/(Helvetica[^\s]*) ([\d.]+) Tf/);
      const matrix = block.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
      const encoded = block.match(/<([\dA-Fa-f]+)> Tj/);
      assert.ok(font && matrix && encoded, 'Unsupported text operator: update the PDF inspector explicitly');
      const value = new TextDecoder('windows-1252').decode(Buffer.from(encoded[1], 'hex'));
      const size = Number(font[2]), x = Number(matrix[1]), y = Number(matrix[2]);
      const width = (font[1].includes('Bold') ? bold : normal).widthOfTextAtSize(value, size);
      return { text: value, x, right: x + width, top: 792 - y - size, bottom: 792 - y };
    });
    assert.ok(rows.length > 10, 'Empty extraction is not a passing PDF check');
    return rows;
  });
}

function draftFor(notes = 'NOTE001 confirmed.', payments = 1, items = 1) {
  const draft = sampleDraft('facture');
  draft.items = Array.from({ length: items }, (_, i) => ({ description: `WORK${i + 1}`, quantity: '1', price: '100' }));
  draft.notes = notes;
  draft.deposit = '';
  draft.payments = Array.from({ length: payments }, (_, i) => ({ amount: String(i + 1), date: `2026-09-${String(i % 28 + 1).padStart(2, '0')}` }));
  return draft;
}

function checkBounds(pages) {
  for (const [index, rows] of pages.entries()) {
    assert.ok(rows.some(row => row.text === `${index + 1} / ${pages.length}`), 'Correct page footer');
    for (const row of rows) {
      const footer = /(?:848045563 RT0001|1212260726 TQ0001|^\d+ \/ \d+$)/.test(row.text);
      assert.ok(row.x >= 41 && row.right <= 571, `Horizontal bounds: ${row.text}`);
      assert.ok(footer || row.bottom < 738, `Footer collision: ${row.text} at ${row.bottom}`);
    }
    for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
      const left = rows[a], right = rows[b];
      const overlapX = Math.min(left.right, right.right) - Math.max(left.x, right.x);
      const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      assert.ok(overlapX < .5 || overlapY < .5, `Overlapping text: ${left.text} / ${right.text}`);
    }
  }
}

test('saved PDF aligns the two-panel recap regardless of table height and language', async () => {
  await mkdir(new URL('../test-output/', import.meta.url), { recursive: true });
  for (const language of ['fr', 'en']) for (const [notes, payments] of [['NOTE001 confirmed.', 1], ['NOTE001 confirmed.', 0], ['', 2]]) {
    let previousTop;
    for (const items of [1, 2]) {
      const bytes = await createPdf(draftFor(notes, payments, items), { invoiceNumber: 2060, language });
      const pages = await inspect(bytes);
      assert.equal(pages.length, 1);
      const rows = pages[0];
      const extras = rows.filter(row => row.x < 300 && (row.text.startsWith('NOTE001') || /^(?:\d{2}\/09\/2026|2026-09-\d{2})$/.test(row.text)));
      assert.ok(extras.length > 0);
      const heading = rows.find(row => row.text === (notes ? (language === 'fr' ? 'NOTE POUR LE CLIENT' : 'NOTE FOR CUSTOMER') : (language === 'fr' ? 'PAIEMENTS REÇUS' : 'PAYMENTS RECEIVED')));
      const finalTotal = rows.find(row => row.text === (payments ? (language === 'fr' ? 'Balance' : 'Balance due') : language === 'fr' ? 'Total avec taxes' : 'Total incl. tax'));
      assert.ok(finalTotal, 'Final totals label must exist');
      const subtotal = rows.find(row => row.text === (language === 'fr' ? 'Sous-total' : 'Subtotal'));
      assert.ok(Math.abs(heading.top - subtotal.top) <= 2, 'Two panels start at the same height');
      assert.ok(finalTotal.top > subtotal.top);
      if (previousTop !== undefined) assert.ok(Math.abs(heading.top - previousTop) < .1, 'Adding work must not move recap upward');
      previousTop = heading.top;
      checkBounds(pages);
      if (notes && payments && items === 1) await writeFile(new URL(`../test-output/closing-${language}.pdf`, import.meta.url), bytes);
    }
  }
});

test('closing pagination preserves every note and date/amount pair above the footer', async () => {
  for (const [notesCount, paymentsCount] of [[11, 0], [12, 0], [0, 7], [0, 8], [6, 1], [7, 1], [48, 90]]) {
    const notes = Array.from({ length: notesCount }, (_, i) => `NOTE${String(i + 1).padStart(3, '0')} confirmed details END${String(i + 1).padStart(3, '0')}.`).join('\n');
    const bytes = await createPdf(draftFor(notes, paymentsCount), { invoiceNumber: 2060 });
    const pages = await inspect(bytes);
    checkBounds(pages);
    const rows = pages.flat();
    const printedNotes = rows.filter(row => row.x === 56 && !row.text.startsWith('NOTE POUR') && (row.text.startsWith('NOTE') || row.text.startsWith('END') || row.text.startsWith('confirmed'))).map(row => row.text).join(' ');
    assert.equal(printedNotes.replace(/\s+/g,' ').trim(), notes.replace(/\s+/g,' ').trim());
    const printedPayments = [];
    for (const page of pages) for (const row of page.filter(row => row.x === 73 && /^\d{2}\/09\/2026$/.test(row.text))) {
      const amount = page.find(other => other.x > 200 && Math.abs(other.top - row.top) < .1);
      assert.ok(amount, `Payment date ${row.text} has no matching amount`);
      printedPayments.push([row.text, amount.text]);
    }
    assert.deepEqual(printedPayments, Array.from({ length: paymentsCount }, (_, i) => [`${String(i % 28 + 1).padStart(2, '0')}/09/2026`, `${i + 1},00 $`]));
    assert.equal(rows.filter(row => row.text === 'Sous-total').length, 1, 'Totals appear once');
    assert.ok(pages.at(-1).some(row => row.text === 'Sous-total'), 'Totals on final page');
    for (const page of pages) for (const row of page.filter(row => /^(NOTE POUR LE CLIENT|PAIEMENTS REÇUS)/.test(row.text))) {
      assert.ok(page.some(other => other.top > row.top && (/^(NOTE\d{3}|Note détaillée)/.test(other.text) || /^\d{2}\/09\/2026$/.test(other.text))), 'Headings stay with content');
    }
    if (paymentsCount === 90) await writeFile(new URL('../test-output/closing-long.pdf', import.meta.url), bytes);
  }
});

test('every date/amount pair survives English and French quote/invoice histories, including max rows', async () => {
  for (const language of ['fr','en']) for (const kind of ['soumission','facture']) {
    const draft = draftFor(Array.from({length:70},(_,i)=>`NOTE${String(i).padStart(3,'0')}: A confirmed detail.`).join('\n'), 500);
    draft.kind = kind;
    const pages = await inspect(await createPdf(draft,{invoiceNumber:2060,language}));
    checkBounds(pages);
    const rows = pages.flat(), printed = [];
    for(const page of pages) for(const row of page.filter(row=>row.x===73)) {
      const amount=page.find(other=>other.x>200 && Math.abs(other.top-row.top)<.1);
      assert.ok(amount); printed.push([row.text,amount.text]);
    }
    const formatter=new Intl.NumberFormat(language==='en'?'en-CA':'fr-CA',{minimumFractionDigits:2,maximumFractionDigits:2});
    const money=n=>formatter.format(n).replace(/[\u00a0\u202f]/g,' ')+(language==='fr'?' $':'');
    assert.deepEqual(printed,draft.payments.map(p=>[language==='en'?p.date:p.date.split('-').reverse().join('/'),language==='en'?'$'+money(Number(p.amount)):money(Number(p.amount))]));
    assert.equal(rows.filter(r=>r.text===(language==='en'?'Subtotal':'Sous-total')).length,1);
    for(let i=0;i<70;i++) assert.equal(rows.filter(r=>r.text.startsWith(`NOTE${String(i).padStart(3,'0')}:`)).length,1);
    const final=pages.at(-1); assert.ok(final.some(r=>r.text.startsWith(language==='en'?'Detailed note : pages':'Note détaillée : pages')));
    assert.ok(final.some(r=>r.text.startsWith(language==='en'?'Earlier payments : pages':'Versements précédents : pages')));
  }
});

test('near-full recap moves below continuation header, with or without notes/payments', async () => {
  for(const lines of [0,35,38,39,40,41,42,44,50]) {
    const draft=draftFor(Array.from({length:lines},(_,i)=>`NOTE${i} brief.`).join('\n'),0,18);
    const pages=await inspect(await createPdf(draft,{invoiceNumber:2060}));
    checkBounds(pages);
    assert.ok(pages.at(-1).filter(r=>r.x===56).every(r=>r.top>=82),'Recap and continuation details below continued header');
  }
});

test('saved-PDF observer detects clipped and overlapping text', async () => {
  const pages=await inspect(await createPdf(draftFor(),{invoiceNumber:2060}));
  checkBounds(pages);
  const clipped=structuredClone(pages); clipped[0][0].bottom=790;
  assert.throws(()=>checkBounds(clipped),/Footer collision/);
  const overlapping=structuredClone(pages); overlapping[0].push({...overlapping[0][0]});
  assert.throws(()=>checkBounds(overlapping),/Overlapping text/);
});

test('large amounts fit beside the longer English balance label', async () => {
  const draft = draftFor('Confirmed details.', 3);
  draft.kind = 'soumission';
  draft.payments = [{amount:'1000000000',date:''},{amount:'1000000000',date:''},{amount:'1000000000',date:''}];
  checkBounds(await inspect(await createPdf(draft,{language:'en'})));
});

test('a long work description retains every word once across continuation pages', async () => {
  const draft = draftFor('',0);
  draft.items[0].description = Array.from({length:100},(_,i)=>`STEP${i}: Fabrication et ajustement selon les dimensions confirmées. END${i}.`).join('\n');
  const pages = await inspect(await createPdf(draft,{invoiceNumber:2060}));
  checkBounds(pages);
  const text = pages.flat().filter(r=>r.x===48 && !r.text.startsWith('LIGNE') && r.text!=='DESCRIPTION').map(r=>r.text).join(' ').replace(/\s+/g,' ').trim();
  assert.equal(text,draft.items[0].description.replace(/\s+/g,' ').trim());
});
