// Versioned standard profiles. Historical drafts without a decision retain Québec.
export const TAX_RULE_VERSION = 'qc-on-2026-10-01';
const profiles = {
  QC: [{code:'GST',rateMillionths:50000},{code:'QST',rateMillionths:99750}],
  ON: [{code:'HST',rateMillionths:130000}],
};
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
export function addressProvince(address) {
  let text=normalize(address).trim();
  if (/\b(?:USA|US|UNITED STATES|ETATS[- ]UNIS|CALIFORNIA|CALIFORNIE)\b/.test(text)) return 'outside';
  // Street names are not province declarations.
  text=text.replace(/\b(?:RUE|STREET|ST|AVENUE|AVE|CHEMIN|ROAD|RD|BOULEVARD|BLVD)\s+(?:ONTARIO|QUEBEC)\b/g,'STREET');
  const clues=[...text.matchAll(/(?:^|[\s,(])(?:QUEBEC|QC|ONTARIO|ON)(?=$|[\s,)])/g)].map(m=>/QUEBEC|QC/.test(m[0])?'QC':'ON');
  if (new Set(clues).size>1) return null;
  text=text.replace(/[,\s]+CANADA\s*$/,'').trim();
  if (/\b(?:BC|BRITISH COLUMBIA|COLOMBIE[- ]BRITANNIQUE|AB|ALBERTA|MB|MANITOBA|SK|SASKATCHEWAN|NB|NEW BRUNSWICK|NOUVEAU[- ]BRUNSWICK|NS|NOVA SCOTIA|NOUVELLE[- ]ECOSSE|PE|PEI|PRINCE EDWARD ISLAND|NL|NEWFOUNDLAND|TERRE[- ]NEUVE|NT|NWT|NUNAVUT|NU|YUKON|YT)\b(?:\W+[A-Z]\d[A-Z]\s*\d[A-Z]\d)?[\s,)]*$/.test(text)) return 'outside';
  const match=/(?:^|[\s,(])(QUEBEC|QC|ONTARIO|ON)[\s,)]*(?:[A-Z]\d[A-Z]\s*\d[A-Z]\d)?\s*$/.exec(text);
  if (!match) return null;
  return /QUEBEC|QC/.test(match[1])?'QC':'ON';
}
export const newTax = () => ({schemaVersion:1,ruleVersion:TAX_RULE_VERSION,fulfillment:'installation',selection:'auto'});
export function documentLocation(draft,language='fr') {
  const en=language==='en',mode=draft.tax?.selection==='legacy'?'':draft.tax?.fulfillment;
  if(mode==='pickup')return {label:en?'Pickup at the workshop (Québec)':'Retrait à l’atelier (Québec)',address:'68, chemin des guides\nRipon (Qc) J0V 1V0'};
  return {label:mode==='installation'?(en?'Installation location':'Lieu d’installation'):(en?'Ship to':'Livrer à'),address:String(draft.shipTo||'')};
}
export function resolveTax(draft) {
  const source=draft.tax || {...newTax(),selection:'legacy'};
  const {fulfillment='installation',selection='legacy'}=source;
  let province=null,basis='',status='unresolved';
  if (selection==='QC'||selection==='ON') {province=selection;basis='manual';}
  else if (selection==='legacy') {province='QC';basis='legacy';}
  else if (fulfillment==='pickup') {province='QC';basis='shop';}
  else {basis=String(draft.shipTo||'').trim()?'shipTo':'address';province=addressProvince(draft[basis]);}
  if (province==='outside') {province=null;status='unsupported';}
  else if(province)status='resolved';
  return {schemaVersion:1,ruleVersion:TAX_RULE_VERSION,fulfillment,selection,province,basis,status,rates:(profiles[province]||[]).map(r=>({...r}))};
}
/** Call only at editable draft boundaries. Raw historical resolveTax stays unchanged.
 * Mutates draft.tax and returns its freshly resolved value, like updateTax.
 */
export function migrateEditableTax(draft) {
  const selection=draft.tax?.selection;
  if (selection==null || selection==='legacy') {
    draft.tax={...newTax(),...draft.tax,selection:'auto'};
  }
  draft.tax=resolveTax(draft);
  return draft.tax;
}
export function updateTax(draft, settings={}) {
  draft.tax={...(draft.tax||{...newTax(),selection:'legacy'}),...settings};
  draft.tax=resolveTax(draft);return draft.tax;
}
export function taxIssue(draft) {
  const tax=resolveTax(draft);
  try { calculateTaxTotals(draft); } catch(error) { return error.message; }
  if (tax.status==='unsupported')return 'Hors Québec/Ontario : préparer une facture personnalisée séparément.';
  if (tax.status!=='resolved')return 'Confirmer la province du chantier / de livraison : Québec ou Ontario.';
  if (tax.selection==='legacy' && (String(draft.shipTo||'').trim()?addressProvince(draft.shipTo):addressProvince(draft.address))!=='QC')return 'Québec conservé pour ce document existant. Confirmer Québec ou choisir Automatique / Ontario avant de créer un nouveau PDF.';
  return '';
}
export function taxLabel(code, language='fr') {
  return ({fr:{GST:'TPS (5 %)',QST:'TVQ (9,975 %)',HST:'TVH (13 %)'},en:{GST:'GST (5%)',QST:'QST (9.975%)',HST:'HST (13%)'}})[language][code];
}
export function taxRegistration(province,language='fr') {
  const english=language==='en';
  return province==='ON'?[`${english?'GST/HST':'TPS/TVH'} 848045563 RT0001`]:[`${english?'GST':'TPS'} 848045563 RT0001`,`${english?'QST':'TVQ'} 1212260726 TQ0001`];
}
export const numericAmount = value => {
  const parsed=Number(String(value??'').trim().replace(/[\s\u00a0\u202f]/g,'').replace(',','.'));
  return Number.isFinite(parsed)&&parsed>=0?parsed:0;
};
export function calculateTaxTotals(draft, paid=0) {
  const tax=resolveTax(draft);
  const subtotalCents=Math.round(((draft.items||[]).reduce((sum,r)=>sum+numericAmount(r.quantity)*numericAmount(r.price),0)+Number.EPSILON)*100);
  if(!Number.isSafeInteger(subtotalCents)||subtotalCents<0)throw new Error('Montant trop élevé pour le document.');
  const lines=tax.rates.map(rate=>({...rate,cents:Number((BigInt(subtotalCents)*BigInt(rate.rateMillionths)+500000n)/1000000n)}));
  const totalCents=subtotalCents+lines.reduce((sum,r)=>sum+r.cents,0);
  if(!Number.isSafeInteger(totalCents))throw new Error('Montant trop élevé pour le document.');
  const resolved=tax.status==='resolved';
  const get=code=>(lines.find(r=>r.code===code)?.cents||0)/100;
  return {tax,lines:lines.map(r=>({...r,amount:r.cents/100})),subtotal:subtotalCents/100,tps:get('GST'),tvq:get('QST'),hst:get('HST'),total:resolved?totalCents/100:null,deposit:paid,balance:resolved?Math.max(0,(totalCents-Math.round(paid*100))/100):null};
}
// Draft entry stays editable even when a partially entered amount cannot export.
export function previewTaxTotals(draft,paid=0) {
  try {return calculateTaxTotals(draft,paid);}catch(error){return {tax:resolveTax(draft),lines:[],subtotal:null,total:null,deposit:paid,balance:null,error:error.message};}
}
