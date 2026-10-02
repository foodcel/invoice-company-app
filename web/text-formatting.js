const asText = value => String(value ?? '');
const upperInitial = word => word.replace(/\p{L}/u, letter => letter.toLocaleUpperCase('fr-CA'));

/** Capitalize only the first project letter; keep the rest exactly as entered. */
export function formatProject(value) {
  return upperInitial(asText(value));
}

/** Capitalize name components, including after apostrophes/hyphens, without lowercasing identity or acronyms. */
export function formatClient(value) {
  return asText(value).replace(/[\p{L}\p{M}]+/gu, upperInitial);
}

const streetTypes = new Set(['rue', 'avenue', 'av', 'ave', 'boulevard', 'boul', 'blvd', 'chemin', 'ch', 'route', 'rang', 'montée', 'côte', 'allée', 'ruelle', 'place', 'impasse', 'autoroute']);
const connectors = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'au', 'aux', 'et', 'à', 'sur', 'sous', 'en', 'l', 'd']);
const unitLabels = new Set(['app', 'apt', 'appt', 'appartement', 'suite', 'bureau', 'unité', 'étage', 'local', 'case', 'casier', 'cp']);
const measurements = new Set(['mm', 'cm', 'm', 'km', 'm²', 'm³', 'pi', 'po', 'ft', 'in', 'kg', 'lb']);
const provinceCodes = new Set(['qc', 'on', 'bc', 'ab', 'mb', 'sk', 'nb', 'ns', 'pe', 'pei', 'nl', 'nt', 'nwt', 'nu', 'yt']);

/** French address capitalization only: no rewriting, spacing, accent repair or inferred facts. */
export function formatAddress(value) {
  return asText(value).replace(/[\p{L}\p{M}\d]+(?:[²³])?/gu, (word, offset, text) => {
    // Postal codes and mixed civic/unit identifiers retain every digit and separator.
    if (/\d/u.test(word)) {
      if (/^[a-z]\d[a-z](?:\d[a-z]\d)?$/i.test(word) || /^\d[a-z]\d$/i.test(word)) return word.toUpperCase();
      return word;
    }
    const lower = word.toLocaleLowerCase('fr-CA');
    const before = text.slice(0, offset);
    if (measurements.has(lower) && /\d[\s\u00a0]*$/u.test(before)) return word;
    if (provinceCodes.has(lower)) return word.toUpperCase();
    if (streetTypes.has(lower) || unitLabels.has(lower)) return lower;
    const lineStart = /(?:^|[\r\n])\s*$/u.test(before);
    if (connectors.has(lower) && !lineStart) return lower;
    return upperInitial(word);
  });
}
