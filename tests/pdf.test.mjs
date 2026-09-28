import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createPdf, calculateTotals } from '../web/pdf.js';
import { sampleDraft, longDraft } from './fixtures.mjs';

const output = new URL('../test-output/', import.meta.url);

test('quote amounts and printable Letter PDF', async () => {
  const draft = sampleDraft();
  assert.deepEqual(calculateTotals(draft), {
    subtotal: 250, tps: 12.5, tvq: 24.94,
    total: 287.44, deposit: 30, balance: 257.44,
  });
  const bytes = await createPdf(draft, { language: 'fr' });
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 1);
  assert.deepEqual(document.getPage(0).getSize(), { width: 612, height: 792 });
  await mkdir(output, { recursive: true });
  await writeFile(new URL('quote-test.pdf', output), bytes);
});

test('long invoice paginates without a guessed line limit', async () => {
  const draft = longDraft();
  const bytes = await createPdf(draft, { invoiceNumber: 2060, language: 'fr' });
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() >= 2);
  for (const page of document.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  await mkdir(output, { recursive: true });
  await writeFile(new URL('invoice-long-test.pdf', output), bytes);
});

test('one long work description continues across Letter pages', async () => {
  const draft = sampleDraft('facture');
  draft.items = [{
    description: Array.from({ length: 24 }, (_, index) =>
      `Étape ${index + 1} : fabrication et installation selon les mesures indiquées par le client. Aucun autre travail n'est inclus.`).join('\n'),
    quantity: '1',
    price: '1250',
  }];
  const bytes = await createPdf(draft, { invoiceNumber: 2060, language: 'fr' });
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() >= 2);
  for (const page of document.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  await mkdir(output, { recursive: true });
  await writeFile(new URL('invoice-long-line-test.pdf', output), bytes);
});

test('customer output rejects missing facts and unreviewed English', async () => {
  const draft = sampleDraft('facture');
  await assert.rejects(createPdf(draft, {}), /Numéro de facture/);
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060, language: 'en' }), /anglais indisponible/);
  draft.items[0].quantity = '0';
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060 }), /Quantité/);
  draft.items[0].quantity = '2';
  draft.date = '2026-02-31';
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060 }), /Date invalide/);
});
