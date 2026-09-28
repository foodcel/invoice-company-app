export function sampleDraft(kind = 'soumission') {
  return {
    id: `test-${kind}`,
    kind,
    date: '2026-09-28',
    validUntil: '2026-10-28',
    dueDate: '',
    project: 'Armoire de démonstration',
    client: 'Client Démo',
    address: '10, rue Exemple\nQuébec (Qc) G1A 0A1',
    shipTo: '20, rue Livraison\nQuébec (Qc) G1A 0A2',
    contact: '(418) 555-0100',
    email: 'client@example.test',
    notes: 'Première note pour le client.\nDeuxième note.',
    deposit: '30,00',
    invoiceNumber: 2060,
    issuedNumber: null,
    items: [
      { description: 'Fabrication d’une armoire en chêne blanc de 3 1/2 po.\nFinition selon la couleur choisie par le client.', quantity: '2', price: '100,00' },
      { description: 'Livraison et installation.', quantity: '1', price: '50,00' },
    ],
  };
}

export function longDraft(kind = 'facture') {
  const draft = sampleDraft(kind);
  draft.items = Array.from({ length: 24 }, (_, index) => ({
    description: `Étape ${index + 1} : ` + 'Fabrication, ajustement et installation des éléments décrits par le client. '.repeat(8),
    quantity: '1',
    price: '12,50',
  }));
  return draft;
}
