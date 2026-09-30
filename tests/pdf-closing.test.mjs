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

test('saved PDF bottom-aligns notes and payments beside totals regardless of table height', async () => {
  await mkdir(new URL('../test-output/', import.meta.url), { recursive: true });
  for (const language of ['fr', 'en']) for (const [notes, payments] of [['NOTE001 confirmed.', 1], ['NOTE001 confirmed.', 0], ['', 2]]) {
    let previousBottom;
    for (const items of [1, 2]) {
      const bytes = await createPdf(draftFor(notes, payments, items), { invoiceNumber: 2060, language });
      const pages = await inspect(bytes);
      assert.equal(pages.length, 1);
      const rows = pages[0];
      const extras = rows.filter(row => row.x < 300 && (row.text.startsWith('NOTE001') || /^(?:\d{2}\/09\/2026|2026-09-\d{2})$/.test(row.text)));
      assert.ok(extras.length > 0);
      const bottom = Math.max(...extras.map(row => row.bottom));
      const finalTotal = rows.find(row => row.text === (payments ? (language === 'fr' ? 'Balance' : 'Balance due') : language === 'fr' ? 'Total avec taxes' : 'Total incl. tax'));
      assert.ok(finalTotal, 'Final totals label must exist');
      assert.ok(Math.abs(bottom - finalTotal.bottom) <= 2, `Closing block is not bottom-aligned: ${bottom} vs ${finalTotal.bottom}`);
      if (previousBottom !== undefined) assert.ok(Math.abs(bottom - previousBottom) < .1, 'Adding work must not move closing block upward');
      previousBottom = bottom;
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
    const printedNotes = rows.filter(row => /^NOTE\d{3}/.test(row.text)).map(row => row.text);
    assert.deepEqual(printedNotes, notes ? notes.split('\n') : []);
    const printedPayments = [];
    for (const page of pages) for (const row of page.filter(row => row.x === 42 && /^\d{2}\/09\/2026$/.test(row.text))) {
      const amount = page.find(other => other.x > 200 && other.right <= 292 && Math.abs(other.top - row.top) < .1);
      assert.ok(amount, `Payment date ${row.text} has no matching amount`);
      printedPayments.push([row.text, amount.text]);
    }
    assert.deepEqual(printedPayments, Array.from({ length: paymentsCount }, (_, i) => [`${String(i % 28 + 1).padStart(2, '0')}/09/2026`, `${i + 1},00 $`]));
    assert.equal(rows.filter(row => row.text === 'Sous-total').length, 1, 'Totals appear once');
    assert.ok(pages.at(-1).some(row => row.text === 'Sous-total'), 'Totals on final page');
    for (const page of pages) for (const row of page.filter(row => /^(NOTE POUR LE CLIENT|PAIEMENTS REÇUS)/.test(row.text))) {
      assert.ok(page.some(other => other.top > row.top && (/^NOTE\d{3}/.test(other.text) || /^\d{2}\/09\/2026$/.test(other.text))), 'Headings stay with content');
    }
    if (paymentsCount === 90) await writeFile(new URL('../test-output/closing-long.pdf', import.meta.url), bytes);
  }
});
