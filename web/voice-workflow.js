const editableFields = ['project', 'client', 'address', 'shipTo', 'contact', 'email', 'date', 'validUntil', 'dueDate', 'notes'];
const dateFields = new Set(['date', 'validUntil', 'dueDate']);
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};
const validNumber = value => /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value) && Number.isFinite(Number(value.replace(',', '.')));

export function createVoiceSession(draft) {
  const eligible = new Set(editableFields.filter(key => !String(draft[key] ?? '').trim()));
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (draft.date === localToday && !String(draft.project || '').trim() && !String(draft.client || '').trim()) eligible.add('date');
  // An unused line can be filled; all existing work and prices are retained.
  const last = draft.items.at(-1);
  const itemStart = last && !String(last.description || '').trim() && !String(last.price || '').trim() &&
    (!String(last.quantity || '').trim() || String(last.quantity).trim() === '1')
    ? draft.items.length - 1 : draft.items.length;
  return { draftId: draft.id, eligible, itemStart, voiceCount: 0, releasedItems: new Set(), transcript: '' };
}

export function releaseVoiceField(session, field) { session?.eligible.delete(field); }
export function releaseVoiceItem(session, index, key) { session?.releasedItems.add(`${index}:${key}`); }

export function applyVoiceUpdate(draft, update, session) {
  if (!session || draft.id !== session.draftId || !update || typeof update !== 'object') return false;
  let changed = false;
  for (const key of editableFields) {
    if (!session.eligible.has(key)) continue;
    if (key === 'validUntil' && draft.kind !== 'soumission') continue;
    if (key === 'dueDate' && draft.kind !== 'facture') continue;
    const proposed = update[key];
    if (typeof proposed !== 'string') continue;
    const value = proposed.trim();
    if (!value || value.length > 5000 || (dateFields.has(key) && !validDate(value))) continue;
    if (draft[key] !== value) { draft[key] = value; changed = true; }
  }
  if (Array.isArray(update.items)) {
    for (const [index, item] of update.items.slice(0, 30).entries()) {
      const description = typeof item?.description === 'string' ? item.description.trim() : '';
      if (!description || description.length > 20000) continue;
      const target = session.itemStart + index;
      while (target >= draft.items.length) draft.items.push({ description: '', quantity: '1', price: '' });
      const row = draft.items[target];
      if (!session.releasedItems.has(`${target}:description`) && row.description !== description) { row.description = description; changed = true; }
      const quantity = typeof item.quantity === 'string' ? item.quantity.trim() : '';
      if (quantity && !session.releasedItems.has(`${target}:quantity`) && validNumber(quantity) && Number(quantity.replace(',', '.')) > 0 && row.quantity !== quantity) {
        row.quantity = quantity; changed = true;
      }
      const price = typeof item.price === 'string' ? item.price.trim() : '';
      if (price && !session.releasedItems.has(`${target}:price`) && validNumber(price) && row.price !== price) { row.price = price; changed = true; }
      session.voiceCount = Math.max(session.voiceCount, index + 1);
    }
  }
  return changed;
}
