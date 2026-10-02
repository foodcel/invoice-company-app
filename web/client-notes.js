// Never split legacy paragraphs, trim whitespace, or stringify customer data.
export const MAX_NOTE_ENTRIES = 500;
export const MAX_NOTES_BYTES = 50_000;
const bytes = value => new TextEncoder().encode(value).length;
const invalidControls = value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);

function copyRows(rows) {
  if (!Array.isArray(rows) || Array.from(rows).some(row => typeof row !== 'string')) {
    throw new TypeError('Les notes doivent être une liste de textes.');
  }
  return [...rows];
}

export function noteRows(draft) {
  if (draft.noteEntries !== undefined && draft.noteEntries !== null) return copyRows(draft.noteEntries);
  const legacy = draft.notes === undefined ? '' : draft.notes;
  if (typeof legacy !== 'string') throw new TypeError('La note existante doit être un texte.');
  return legacy === '' ? [] : [legacy];
}

export function notesMirror(rows) {
  return copyRows(rows).filter(row => row !== '').join('\n\n');
}

// Compute/validate before mutating; rejected input leaves the draft untouched.
export function setNoteRows(draft, rows) {
  const noteEntries = copyRows(rows);
  const notes = notesMirror(noteEntries);
  const issues = noteIssues({ noteEntries, notes });
  if (issues.length) throw new RangeError(issues[0].message);
  Object.assign(draft, { noteEntries, notes });
  return draft;
}

export function normalizeNoteRows(draft) {
  return setNoteRows(draft, noteRows(draft));
}

export function noteIssues(draft) {
  let rows;
  try { rows = noteRows(draft); }
  catch (error) { return [{ field: 'noteEntries', index: 0, message: error.message }]; }
  const issues = [];
  if (rows.length > MAX_NOTE_ENTRIES) issues.push({ field: 'noteEntries', index: 0, message: 'Maximum de 500 notes par document.' });
  rows.forEach((row, index) => {
    if (bytes(row) > MAX_NOTES_BYTES || invalidControls(row)) {
      issues.push({ field: 'noteEntries', index, message: `Note ${index + 1} trop longue ou contenant un caractère invalide.` });
    }
  });
  const mirror = notesMirror(rows);
  if (bytes(mirror) > MAX_NOTES_BYTES) issues.push({ field: 'notes', index: 0, message: 'Maximum de 50 000 octets de notes par document, séparateurs compris.' });
  if (draft.noteEntries !== undefined && draft.noteEntries !== null && draft.notes !== mirror) {
    issues.push({ field: 'notes', index: 0, message: 'Le texte des notes ne correspond pas à leurs entrées.' });
  }
  return issues;
}
