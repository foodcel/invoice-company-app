import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import { formatPhone, formatPhoneInput } from '../web/phone.js';

test('phone formatting handles Canadian numbers, country prefix and partial input', () => {
  for (const [input, expected] of [
    ['8196652508', '(819) 665-2508'], ['(819)665-2508', '(819) 665-2508'],
    ['6135550123', '(613) 555-0123'], ['1-613-555-0123', '1 (613) 555-0123'],
    ['+1 (819) 918-3647', '+1 (819) 918-3647'], ['+18199183647', '+1 (819) 918-3647'],
    ['819 918 3647', '(819) 918-3647'],
    ['8', '(8'], ['81', '(81'], ['819', '(819'], ['8199', '(819) 9'],
    ['819918', '(819) 918'], ['8199183', '(819) 918-3'],
    ['1', '1'], ['16', '1 (6'], ['1613', '1 (613'], ['16135', '1 (613) 5'], ['', ''],
    [null, ''], [undefined, ''], ['   ', ''],
    ['+32 2 555 1234', '+32 2 555 1234'], ['8199183647 poste 12', '8199183647 poste 12'],
    ['+33 1 23 45 67 89', '+33 1 23 45 67 89'], ['+44 20 7946 0958', '+44 20 7946 0958'],
    ['011 33 1 23', '011 33 1 23'], ['00 44 20', '00 44 20'],
    ['(819) 665-2508 ext. 123', '(819) 665-2508 ext. 123'], ['8196652508 x12', '8196652508 x12'],
    ['8196652508#12', '8196652508#12'], ['8196652508;ext=12', '8196652508;ext=12'],
    ['819665250812', '819665250812'], ['44966525081', '44966525081'],
  ]) {
    assert.equal(formatPhone(input), expected);
    assert.equal(formatPhone(expected), expected, 'Formatting must be idempotent');
  }
});

test('phone formatting keeps insertion caret beside its digit', () => {
  const input = { value: '8199183647', selectionStart: 5, setSelectionRange(a, b) { this.selection = [a, b]; } };
  formatPhoneInput(input);
  assert.equal(input.value, '(819) 918-3647');
  assert.deepEqual(input.selection, [8, 8]);
  input.value = '16132772711'; input.selectionStart = 11;
  formatPhoneInput(input);
  assert.deepEqual(input.selection, [16, 16]);
});

const editable = (value, start = value.length, end = start, direction = 'none') => ({
  value, selectionStart: start, selectionEnd: end, selectionDirection: direction,
  setSelectionRange(a, b, direction) {
    this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = direction;
  },
});

test('each typing and backspace step keeps the caret at the end of a partial number', () => {
  let raw = '';
  for (const digit of '8196652508') {
    const input = editable(raw + digit);
    formatPhoneInput(input);
    assert.equal(input.value.replace(/\D/g, ''), (raw + digit).replace(/\D/g, ''));
    assert.equal(input.selectionStart, input.value.length);
    raw = input.value;
  }
  assert.equal(raw, '(819) 665-2508');
  while (raw) {
    const previousDigits = raw.replace(/\D/g, '');
    const input = editable(raw.slice(0, -1));
    formatPhoneInput(input);
    assert.equal(input.value.replace(/\D/g, ''), previousDigits.slice(0, -1));
    assert.equal(input.selectionStart, input.value.length);
    raw = input.value;
  }
});

test('insertion and separator deletion anchor the caret to the same preceding digits', () => {
  const insertion = editable('(819) 965-2508', 7);
  formatPhoneInput(insertion);
  assert.equal(insertion.selectionStart, 7, 'An already formatted insertion stays put');
  for (const [value, caret, expected] of [
    ['(819) 6652508', 9, 9], // Backspace over a hyphen: next Backspace can reach a digit.
    ['(819 665-2508', 4, 4], // Backspace over the closing parenthesis.
    ['8196652508', 0, 0], ['8196652508', 3, 4], ['8196652508', 6, 9],
  ]) {
    const input = editable(value, caret);
    formatPhoneInput(input);
    assert.equal(input.value, '(819) 665-2508');
    assert.equal(input.selectionStart, expected, value);
    assert.equal(input.selectionEnd, expected);
  }
});

test('selection endpoints and backward direction survive reformatting', () => {
  const input = editable('8196652508', 3, 6, 'backward');
  formatPhoneInput(input);
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd).replace(/\D/g, ''), '665');
  assert.equal(input.selectionDirection, 'backward');
  const all = editable('16135550123', 0, 11, 'forward');
  formatPhoneInput(all);
  assert.equal(all.selectionStart, 0);
  assert.equal(all.selectionEnd, all.value.length);
  assert.equal(all.selectionDirection, 'forward');
});

test('selection direction is captured before changing the DOM value resets selection', () => {
  let value = '8196652508';
  const input = {
    get value() { return value; },
    set value(next) {
      value = next;
      this.selectionStart = this.selectionEnd = value.length;
      this.selectionDirection = 'none';
    },
    selectionStart: 3, selectionEnd: 6, selectionDirection: 'backward',
    setSelectionRange(a, b, direction) {
      this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = direction;
    },
  };
  formatPhoneInput(input);
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd).replace(/\D/g, ''), '665');
  assert.equal(input.selectionDirection, 'backward');
});

test('international/extension inputs are untouched and caret access is optional', () => {
  for (const value of ['+33 1 23 45', '8196652508 poste 7']) {
    const input = editable(value, 5, 8, 'backward');
    formatPhoneInput(input);
    assert.deepEqual([input.value, input.selectionStart, input.selectionEnd, input.selectionDirection], [value, 5, 8, 'backward']);
  }
  const input = {value: '8196652508'};
  formatPhoneInput(input);
  assert.equal(input.value, '(819) 665-2508');
});

test('phone oracles reject missing hyphens and collapsed selections in isolated copies', async () => {
  const source = await readFile(new URL('../web/phone.js', import.meta.url), 'utf8');
  for (const [anchor, replacement, verify] of [
    ['`-${local.slice(6)}`', '` ${local.slice(6)}`', module => assert.equal(module.formatPhone('8196652508'), '(819) 665-2508')],
    ['mapPosition(end)', 'mapPosition(caret)', module => {
      const input = editable('8196652508', 3, 6, 'backward'); module.formatPhoneInput(input);
      assert.equal(input.value.slice(input.selectionStart, input.selectionEnd).replace(/\D/g, ''), '665');
    }],
  ]) {
    assert.equal(source.split(anchor).length - 1, 1, 'Mutation must inject exactly once');
    const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(anchor, replacement)).toString('base64'));
    assert.throws(() => verify(broken), assert.AssertionError);
  }
});
