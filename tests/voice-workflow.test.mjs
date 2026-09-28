import assert from 'node:assert/strict';
import { createVoiceSession, releaseVoiceField, releaseVoiceItem, applyVoiceUpdate } from '../web/voice-workflow.js';

const draft = {
  id: 'draft-1', kind: 'facture', project: '', client: '', address: '123 rue déjà entrée',
  shipTo: '', contact: '', email: '', date: '2026-09-28', validUntil: '', dueDate: '', notes: '',
  items: [{ description: 'Travail déjà décrit', quantity: '2', price: '100' }]
};
const session = createVoiceSession(draft);
assert.equal(applyVoiceUpdate(draft, {
  project: 'Escalier en chêne', client: 'Nadine Vaillancourt', address: 'adresse inventée',
  dueDate: '2026-02-30', items: [{ description: 'Marches en chêne', quantity: '3', price: '250,50' }]
}, session), true);
assert.equal(draft.address, '123 rue déjà entrée', 'voice must preserve pre-existing address');
assert.equal(draft.dueDate, '', 'invalid date must be ignored');
assert.equal(draft.items[0].description, 'Travail déjà décrit', 'voice must preserve pre-existing work');
assert.equal(draft.items[1].description, 'Marches en chêne');
assert.equal(draft.items[1].price, '250,50');
assert.equal(draft.client, 'Nadine Vaillancourt');
releaseVoiceField(session, 'client');
draft.client = 'Correction manuelle';
applyVoiceUpdate(draft, { client: 'Autre interprétation', items: [{ description: 'Marches corrigées', quantity: '3', price: '250,50' }] }, session);
assert.equal(draft.client, 'Correction manuelle', 'manual correction owns the field');
assert.equal(draft.items.length, 2, 'repeated cumulative extraction must not duplicate items');
assert.equal(draft.items[1].description, 'Marches corrigées');
releaseVoiceItem(session, 1, 'description');
draft.items[1].description = 'Correction manuelle de la ligne';
applyVoiceUpdate(draft, { items: [{ description: 'Autre interprétation de la ligne', quantity: '3', price: '250,50' }] }, session);
assert.equal(draft.items[1].description, 'Correction manuelle de la ligne', 'manual line correction must persist');
const quantityDraft = { ...draft, id: 'draft-quantity', items: [{ description: '', quantity: '5', price: '' }] };
const quantitySession = createVoiceSession(quantityDraft);
applyVoiceUpdate(quantityDraft, { items: [{ description: 'Travail dicté', quantity: '2', price: '50' }] }, quantitySession);
assert.equal(quantityDraft.items[0].quantity, '5', 'quantity entered before dictation must remain');
assert.equal(quantityDraft.items[1].quantity, '2', 'dictated item must be appended');
console.log('Voice merge: pass');
