/** Parenthesize North American phone groups; preserve international prefixes/extensions. */
export function formatPhone(value) {
  const text = String(value ?? '');
  if (!/^[\d\s()+.-]*$/.test(text)) return text;
  const digits = text.replace(/\D/g, '');
  const plus = text.trim().startsWith('+');
  if (/^\s*(?:00|011)/.test(text) || digits.length > 11 || (digits.length === 11 && !digits.startsWith('1')) || (plus && !digits.startsWith('1'))) return text;
  if (!digits) return text.trim() === '' ? '' : text;
  const country = digits.startsWith('1');
  const local = country ? digits.slice(1) : digits;
  const prefix = country ? (plus ? '+1' : '1') : '';
  if (!local) return prefix;
  // Leave the area group open until the next digit arrives, so Backspace works naturally.
  const area = `(${local.slice(0, 3)}${local.length > 3 ? ')' : ''}`;
  const subscriber = local.slice(3, 6) + (local.length > 6 ? `-${local.slice(6)}` : '');
  return [prefix, area, subscriber].filter(Boolean).join(' ');
}

/** Keep caret/selection endpoints beside the same digits as punctuation changes. */
export function formatPhoneInput(input) {
  const text = input.value;
  const caret = input.selectionStart ?? text.length;
  const end = input.selectionEnd ?? caret;
  const direction = input.selectionDirection ?? 'none';
  const formatted = formatPhone(text);
  if (formatted === text) return;
  input.value = formatted;
  const mapPosition = caret => {
    if (caret === 0) return 0;
    if (caret === text.length) return formatted.length;
    const digitsBefore = text.slice(0, caret).replace(/\D/g, '').length;
    let position = 0, seen = 0;
    while (position < formatted.length && seen < digitsBefore) {
      if (/\d/.test(formatted[position])) seen++;
      position++;
    }
    return position;
  };
  input.setSelectionRange?.(mapPosition(caret), mapPosition(end), direction);
}
