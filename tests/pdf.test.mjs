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

test('customer output rejects missing facts and creates an English invoice copy', async () => {
  const draft = sampleDraft('facture');
  await assert.rejects(createPdf(draft, {}), /Numéro de facture/);
  const english = structuredClone(draft);
  english.project = 'Oak staircase';
  english.notes = 'Installation included.';
  english.items[0].description = 'Build and install an oak staircase.';
  english.items[1].description = 'Delivery and installation.';
  const bytes = await createPdf(english, { invoiceNumber: 2060, language: 'en' });
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getTitle(), 'Invoice 2060');
  assert.deepEqual(document.getPage(0).getSize(), { width: 612, height: 792 });
  assert.deepEqual(calculateTotals(english), calculateTotals(draft));
  await mkdir(output, { recursive: true });
  await writeFile(new URL('invoice-english-test.pdf', output), bytes);
  draft.items[0].quantity = '0';
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060 }), /Quantité/);
  draft.items[0].quantity = '2';
  draft.date = '2026-02-31';
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060 }), /Date invalide/);
});

test('English quote keeps the French numeric facts on Letter paper', async () => {
  const french = sampleDraft('soumission');
  const english = structuredClone(french);
  english.project = 'Oak staircase';
  english.items[0].description = 'Build an oak staircase.';
  english.items[1].description = 'Delivery and installation.';
  const bytes = await createPdf(english, { language: 'en' });
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getTitle(), 'Quote');
  assert.deepEqual(document.getPage(0).getSize(), { width: 612, height: 792 });
  assert.deepEqual(calculateTotals(english), calculateTotals(french));
});

test('dated payments preserve taxes and produce French and English customer copies', async () => {
  const draft = sampleDraft('facture');
  draft.payments = [{ amount: '40,25', date: '2026-09-18' }, { amount: '15,50', date: '2026-09-25' }, { amount: '', date: '' }];
  assert.deepEqual(calculateTotals(draft), { subtotal: 250, tps: 12.5, tvq: 24.94, total: 287.44, deposit: 55.75, balance: 231.69 });
  await mkdir(output, { recursive: true });
  for (const language of ['fr', 'en']) {
    const bytes = await createPdf(draft, { invoiceNumber: 2060, language });
    const document = await PDFDocument.load(bytes);
    assert.equal(document.getPageCount(), 1);
    assert.deepEqual(document.getPage(0).getSize(), { width: 612, height: 792 });
    await writeFile(new URL(`payments-${language}-test.pdf`, output), bytes);
  }
  draft.payments[1].date = '2026-02-30';
  await assert.rejects(createPdf(draft, { invoiceNumber: 2060 }), /Date du paiement 2 invalide/);
});

test('long notes and 90 dated payments paginate on Letter pages', async () => {
  const draft = sampleDraft('facture');
  draft.notes = Array.from({ length: 48 }, (_, i) => `Note ${i + 1} : informations complémentaires confirmées par le client.`).join('\n');
  draft.payments = Array.from({ length: 90 }, (_, i) => ({ amount: String(i + 1), date: `2026-09-${String(i % 28 + 1).padStart(2, '0')}` }));
  assert.equal(calculateTotals(draft).deposit, 4095);
  const bytes = await createPdf(draft, { invoiceNumber: 2060 });
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() >= 4);
  for (const page of document.getPages()) assert.deepEqual(page.getSize(), { width: 612, height: 792 });
  await mkdir(output, { recursive: true });
  await writeFile(new URL('payments-long-test.pdf', output), bytes);
});
