import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPhone, formatPhoneInput } from '../web/phone.js';

test('phone formatting handles Canadian numbers, country prefix and partial input', () => {
  for (const [input, expected] of [
    ['6132772711', '613 277 2711'], ['1-613-277-2711', '1 613 277 2711'],
    ['+1 (819) 918-3647', '1 819 918 3647'], ['819 918 3647', '819 918 3647'],
    ['8199', '819 9'], ['1613', '1 613'], ['', ''],
    ['+32 2 555 1234', '+32 2 555 1234'], ['8199183647 poste 12', '8199183647 poste 12'],
  ]) assert.equal(formatPhone(input), expected);
});

test('phone formatting keeps insertion caret beside its digit', () => {
  const input = { value: '8199183647', selectionStart: 5, setSelectionRange(a, b) { this.selection = [a, b]; } };
  formatPhoneInput(input);
  assert.equal(input.value, '819 918 3647');
  assert.deepEqual(input.selection, [6, 6]);
  input.value = '16132772711'; input.selectionStart = 11;
  formatPhoneInput(input);
  assert.deepEqual(input.selection, [14, 14]);
});
