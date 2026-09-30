import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentRows, paymentTotal, paymentIssues, customerPayments } from '../web/payments.js';

test('legacy deposits remain undated and explicit payment rows never double count or resurrect them', () => {
  const legacy = { deposit: '4000,00' };
  assert.deepEqual(paymentRows(legacy), [{ amount: '4000,00', date: '' }]);
  assert.equal(paymentTotal(legacy), 4000);
  const current = { ...legacy, payments: [{ amount: '1500', date: '2026-09-25' }, { amount: '500', date: '' }] };
  assert.equal(paymentTotal(current), 2000);
  assert.deepEqual(customerPayments(current).map(p => p.date), ['2026-09-25', '']);
  assert.equal(paymentTotal({ ...legacy, payments: [] }), 0);
  assert.equal(paymentTotal({ ...legacy, payments: [{ amount: '', date: '' }] }), 0);
});

test('payments round separately, ignore unused rows, and reject invalid or incomplete entries', () => {
  const draft = { payments: [{ amount: '0,105', date: '2026-09-18' }, { amount: '0,105', date: '2026-09-25' }, { amount: '', date: '' }] };
  assert.equal(paymentTotal(draft), .22);
  assert.equal(customerPayments(draft).length, 2);
  for (const row of [{ amount: '-1', date: '' }, { amount: 'abc', date: '' }, { amount: '1e3', date: '' }, { amount: '1000000001', date: '' }, { amount: '1', date: '2026-02-30' }, { amount: '', date: '2026-09-18' }]) {
    assert.ok(paymentIssues({ payments: [row] }).length);
    assert.throws(() => customerPayments({ payments: [row] }));
  }
  assert.ok(paymentIssues({ payments: Array.from({ length: 501 }, () => ({ amount: '', date: '' })) }).length);
});
