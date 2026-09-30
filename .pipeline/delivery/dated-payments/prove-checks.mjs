import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { sampleDraft } from '../../../tests/fixtures.mjs';

const python = process.argv[2];
if (!python) throw new Error('Supply the Python executable with pdfplumber installed.');
const root = resolve('test-output/dated-payments-mutations');
await mkdir(root, { recursive: true });
const payments = await readFile('web/payments.js', 'utf8');
const pattern = 'if (Array.isArray(draft.payments)) return draft.payments;';
assert.ok(payments.includes(pattern), 'NOT_INJECTED: payment-total mutation');
await writeFile(join(root, 'payments.js'), payments.replace(pattern, 'if (Array.isArray(draft.payments)) return [];'));
const tests = await readFile('tests/payments.test.mjs', 'utf8');
await writeFile(join(root, 'payments.test.mjs'), tests.replace('../web/payments.js', './payments.js'));
const unit = spawnSync(process.execPath, ['--test', join(root, 'payments.test.mjs')], { encoding: 'utf8' });
assert.notEqual(unit.status, 0, 'Payment checks accepted an implementation that ignores every new row');
assert.match(unit.stdout + unit.stderr, /fail 2/);
console.log('MUTATION_CAUGHT rung=unit defect=ignore-payment-rows failing-tests=2');

// Independently check printed output, rather than checking a renderer label.
await writeFile(join(root, 'payments.js'), payments);
const source = await readFile('web/pdf.js', 'utf8');
const list = 'const payments = customerPayments(draft);';
assert.ok(source.includes(list), 'NOT_INJECTED: printed-payment mutation');
await writeFile(join(root, 'pdf.js'), source.replace(list, 'const payments = [];'));
const { createPdf } = await import(new URL('file:///' + join(root, 'pdf.js').replaceAll('\\', '/')));
const draft = sampleDraft('facture');
draft.payments = [{ amount: '40,25', date: '2026-09-18' }, { amount: '15,50', date: '2026-09-25' }];
await writeFile(join(root, 'payments-fr-test.pdf'), await createPdf(draft, { invoiceNumber: 2060 }));
for (const name of ['payments-en-test.pdf', 'payments-long-test.pdf']) await copyFile(join('test-output', name), join(root, name));
const pdf = spawnSync(python, ['.pipeline/delivery/dated-payments/verify-pdfs.py', root], { encoding: 'utf8' });
assert.notEqual(pdf.status, 0, 'PDF checker accepted output with every printed payment removed');
assert.match(pdf.stdout + pdf.stderr, /Missing payment date/);
console.log('MUTATION_CAUGHT rung=pdf-extraction defect=omit-printed-payment-details');
