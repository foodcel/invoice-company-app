import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {formatProject, formatClient, formatAddress} from '../web/text-formatting.js';

const projects = [
  ['cuisine en érable – phase II', 'Cuisine en érable – phase II'],
  ['  « ébénisterie ABC »', '  « Ébénisterie ABC »'],
  ['2026 : rénovation RDC', '2026 : Rénovation RDC'],
  ['Étagères IKEA / iPhone', 'Étagères IKEA / iPhone'],
  [null, ''], [undefined, ''], ['', ''], ['123', '123'],
];
const clients = [
  ['élodie tremblay', 'Élodie Tremblay'],
  ['jean-luc d’angelo', 'Jean-Luc D’Angelo'],
  ["anne-marie o'neill", "Anne-Marie O'Neill"],
  ['équipements ABC inc. / R&D (QC)', 'Équipements ABC Inc. / R&D (QC)'],
  ['les entreprises ÉBC et NASA', 'Les Entreprises ÉBC Et NASA'],
  ['  françois\tde la rivière\n& fils', '  François\tDe La Rivière\n& Fils'],
  ['e\u0301milie McDonald iPhone', 'E\u0301milie McDonald IPhone'],
  [null, ''], ['', ''],
];
const addresses = [
  ['68, chemin des guides\nripon (qc) j0v 1v0', '68, chemin des Guides\nRipon (QC) J0V 1V0'],
  ["123 rue de l'église\nmontréal (qc) h2x 1y4", "123 rue de l'Église\nMontréal (QC) H2X 1Y4"],
  ['42, boulevard rené-lévesque ouest, app. 2B\nquébec QC G1R 2B5', '42, boulevard René-Lévesque Ouest, app. 2B\nQuébec QC G1R 2B5'],
  ['10 avenue de la montagne\nsainte-anne-des-monts, qc', '10 avenue de la Montagne\nSainte-Anne-des-Monts, QC'],
  ['25 rue du moulin, unité 2b\ngatineau QC J8X1A1', '25 rue du Moulin, unité 2b\nGatineau QC J8X1A1'],
  ['  99\trang des érables\r\nle gardeur, qc j5z 1a1  ', '  99\trang des Érables\r\nLe Gardeur, QC J5Z 1A1  '],
  ['10 rue ABC, bureau 4 / 20 m² / 8 pi / 12 kg', '10 rue ABC, bureau 4 / 20 m² / 8 pi / 12 kg'],
  ['12 route 148, suite A-2\nottawa (on) k1a0b1', '12 route 148, suite A-2\nOttawa (ON) K1A0B1'],
  ['RUE DE LA PAIX\nMONTRÉAL QC H1A 1A1', 'rue de la PAIX\nMONTRÉAL QC H1A 1A1'],
  [null, ''], [undefined, ''], ['', ''],
];

const verify = (formatter, cases) => {
  for (const [input, expected] of cases) {
    assert.equal(formatter(input), expected, String(input));
    assert.equal(formatter(expected), expected, `Idempotent: ${expected}`);
    if (input != null) {
      const punctuation = text => String(text).replace(/[\p{L}\p{M}]/gu, '');
      assert.equal(punctuation(formatter(input)), punctuation(input), 'Digits, punctuation and whitespace must survive');
    }
  }
};

test('project capitalization changes only the first letter', () => verify(formatProject, projects));
test('French client names capitalize each component and preserve deliberate acronyms', () => verify(formatClient, clients));
test('French addresses retain lowercase street types, connectors and units with proper names capitalized', () => verify(formatAddress, addresses));

test('formatting oracles reject lost project details, lowercased acronyms and title-every-word addresses', async () => {
  const source = await readFile(new URL('../web/text-formatting.js', import.meta.url), 'utf8');
  for (const [anchor, replacement, name, cases] of [
    ['return upperInitial(asText(value));', "return upperInitial(asText(value)).split(' ')[0];", 'formatProject', projects],
    ["return asText(value).replace(/[\\p{L}\\p{M}]+/gu, upperInitial);", "return asText(value).toLowerCase().replace(/[\\p{L}\\p{M}]+/gu, upperInitial);", 'formatClient', clients],
    ['if (connectors.has(lower) && !lineStart) return lower;', 'if (connectors.has(lower) && !lineStart) return upperInitial(word);', 'formatAddress', addresses],
  ]) {
    assert.equal(source.split(anchor).length - 1, 1, 'Mutation must inject exactly once');
    const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(anchor, replacement)).toString('base64'));
    assert.throws(() => verify(broken[name], cases), assert.AssertionError);
  }
});
