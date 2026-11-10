// Names as Rave Monitor compares them. Shared by the API Worker (follows), the alerts step
// (pipeline/notify.js) and, as a copy, the site (site/app.js); test/keys.test.js checks they agree.

export const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Record labels and promoters: no case, accents, apostrophes or punctuation, & as 'and'.
export const lkey = s => norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Artists: the same, except that letters in any script count, so a name in Japanese still has a key.
export const akey = s => norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The key a follow of this kind compares by. A venue's key is its directory id, given as is. */
export function followKey(kind, name, venueId) {
  if (kind === 'venue') return /^[a-z0-9][a-z0-9-]{0,119}$/.test(String(venueId || '')) ? String(venueId) : '';
  if (kind === 'artist') return akey(name).slice(0, 120);
  return lkey(name).slice(0, 120);
}
