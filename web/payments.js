// New rows are authoritative, including an explicitly empty list. The scalar
// deposit is only a fallback for documents saved before dated payments existed.
export function paymentRows(draft) {
  if (Array.isArray(draft.payments)) return draft.payments;
  const legacy = String(draft.deposit ?? '');
  return legacy.trim() ? [{ amount: legacy, date: '' }] : [];
}

function parsedAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw)) return null;
  const number = Number(raw.replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000 ? number : null;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function paymentIssues(draft) {
  const rows = paymentRows(draft), issues = [];
  if (rows.length > 500) issues.push({ index: 0, field: 'amount', message: 'Maximum de 500 paiements par document.' });
  rows.forEach((row, index) => {
    const raw = String(row?.amount ?? '').trim();
    const date = String(row?.date ?? '');
    if ((raw && parsedAmount(raw) === null) || (!raw && date)) {
      issues.push({ index, field: 'amount', message: `Montant du paiement ${index + 1} invalide.` });
    }
    if (date && !validDate(date)) issues.push({ index, field: 'date', message: `Date du paiement ${index + 1} invalide.` });
  });
  return issues;
}

export function paymentTotal(draft) {
  return paymentRows(draft).reduce((cents, row) => {
    const number = parsedAmount(row?.amount);
    return cents + (number === null ? 0 : Math.round((number + Number.EPSILON) * 100));
  }, 0) / 100;
}

export function customerPayments(draft) {
  const issues = paymentIssues(draft);
  if (issues.length) throw new Error(issues[0].message);
  return paymentRows(draft).filter(row => parsedAmount(row?.amount) > 0)
    .map(row => ({ amount: Math.round((parsedAmount(row.amount) + Number.EPSILON) * 100) / 100, date: row.date || '' }));
}
