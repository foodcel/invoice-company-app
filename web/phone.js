/** Space North American phone groups; preserve international numbers/extensions. */
export function formatPhone(value) {
  const text = String(value ?? '');
  if (!/^[\d\s()+.-]*$/.test(text)) return text;
  const digits = text.replace(/\D/g, '');
  if (digits.length > 11 || (digits.length === 11 && !digits.startsWith('1')) || (text.trim().startsWith('+') && !digits.startsWith('1'))) return text;
  const country = digits.startsWith('1');
  const local = country ? digits.slice(1) : digits;
  return [country ? '1' : '', local.slice(0, 3), local.slice(3, 6), local.slice(6)].filter(Boolean).join(' ');
}

/** Keep the caret beside the same digit when spaces are inserted or removed. */
export function formatPhoneInput(input) {
  const text = input.value;
  const caret = input.selectionStart ?? text.length;
  const digitsBefore = text.slice(0, caret).replace(/\D/g, '').length;
  const formatted = formatPhone(text);
  if (formatted === text) return;
  input.value = formatted;
  let position = 0, seen = 0;
  while (position < formatted.length && seen < digitsBefore) {
    if (/\d/.test(formatted[position])) seen++;
    position++;
  }
  if (caret === text.length) position = formatted.length;
  input.setSelectionRange?.(position, position);
}
