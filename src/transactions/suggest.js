'use strict';

/**
 * Local, dependency-free suggestion model for the "nuovo movimento" form.
 *
 * It learns only from the user's own transaction history (no external service):
 *  - description autocomplete: past notes that match what's being typed,
 *    ranked by prefix match, then frequency, then recency;
 *  - category / account: a recency-weighted vote over past movements whose
 *    note shares words with the one being typed. With an empty note it falls
 *    back to the user's dominant category/account for that type+scope.
 */

const STOPWORDS = new Set([
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'il', 'lo', 'la', 'i',
  'gli', 'le', 'un', 'uno', 'una', 'e', 'ed', 'o', 'del', 'dello', 'della', 'dei',
  'degli', 'delle', 'al', 'allo', 'alla', 'dal', 'the', 'of', 'and',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

const HALF_LIFE_DAYS = 120;

function recencyWeight(occurredOn, now) {
  const t = occurredOn ? Date.parse(occurredOn) : NaN;
  if (Number.isNaN(t)) return 0.15;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.max(0.15, Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
}

function topVote(votes, byId, { minConfidence, minWeight }) {
  let total = 0;
  let bestId = null;
  let bestWeight = 0;
  for (const [id, w] of votes) {
    total += w;
    if (w > bestWeight) {
      bestWeight = w;
      bestId = id;
    }
  }
  if (bestId == null || total === 0 || bestWeight < minWeight) return null;
  const confidence = bestWeight / total;
  if (confidence < minConfidence) return null;
  const meta = byId.get(String(bestId));
  if (!meta) return null;
  return {
    id: String(bestId),
    name: meta.name,
    color: meta.color,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * @param {object}   opts
 * @param {Array}    opts.rows      {note, category_id, account_id, occurred_on}, newest first
 * @param {string}   opts.note      what the user has typed so far
 * @param {Map}      opts.catById   String(id) -> {id, name, color}
 * @param {Map}      opts.accById   String(id) -> {id, name, color}
 * @param {Date}     [opts.now]
 */
function buildSuggestions({ rows, note, catById, accById, now = new Date() }) {
  const queryTokens = tokenize(note);
  const queryText = String(note || '').trim().toLowerCase();
  const hasQuery = queryTokens.length > 0;

  // ---- description autocomplete -------------------------------------------
  const seen = new Map(); // exact note text -> {count, last, starts}
  for (const r of rows) {
    const text = String(r.note || '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (queryText && !(lower.includes(queryText) || queryTokens.every((t) => lower.includes(t)))) {
      continue;
    }
    const cur = seen.get(text) || { count: 0, last: 0, starts: lower.startsWith(queryText) };
    cur.count += 1;
    const at = r.occurred_on ? Date.parse(r.occurred_on) : 0;
    if (at > cur.last) cur.last = at;
    seen.set(text, cur);
  }
  const descriptions = [...seen.entries()]
    .sort(
      (a, b) =>
        Number(b[1].starts) - Number(a[1].starts) ||
        b[1].count - a[1].count ||
        b[1].last - a[1].last
    )
    .slice(0, 6)
    .map(([text]) => text);

  // ---- category / account vote ------------------------------------------
  const tokenMatch = (rowTok) =>
    queryTokens.some((qt) => rowTok === qt || rowTok.startsWith(qt) || qt.startsWith(rowTok));

  const catVotes = new Map();
  const accVotes = new Map();
  for (const r of rows) {
    let similarity;
    if (!hasQuery) {
      similarity = 1; // pure prior: "what you usually pick" for this type+scope
    } else {
      const rowTokens = tokenize(r.note);
      if (rowTokens.length === 0) continue;
      const overlap = rowTokens.filter(tokenMatch).length;
      if (overlap === 0) continue;
      similarity = Math.min(1, overlap / queryTokens.length);
      if (String(r.note || '').trim().toLowerCase() === queryText) similarity = 1.5;
    }
    const w = similarity * recencyWeight(r.occurred_on, now);
    if (r.category_id != null) catVotes.set(r.category_id, (catVotes.get(r.category_id) || 0) + w);
    if (r.account_id != null) accVotes.set(r.account_id, (accVotes.get(r.account_id) || 0) + w);
  }

  const gate = hasQuery
    ? { minConfidence: 0.34, minWeight: 0.4 }
    : { minConfidence: 0.4, minWeight: 1 };

  return {
    descriptions,
    category: topVote(catVotes, catById, gate),
    account: topVote(accVotes, accById, gate),
  };
}

module.exports = { buildSuggestions, tokenize };
