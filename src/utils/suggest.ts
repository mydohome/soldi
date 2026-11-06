import { Account, Category, Transaction, TransactionScope, TransactionType } from '../types';

const STOPWORDS = new Set([
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra', 'il', 'lo', 'la', 'i',
  'gli', 'le', 'un', 'uno', 'una', 'e', 'ed', 'o', 'del', 'dello', 'della', 'dei',
  'degli', 'delle', 'al', 'allo', 'alla', 'dal', 'the', 'of', 'and',
]);

export function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

const HALF_LIFE_DAYS = 120;

function recencyWeight(occurredOn: string, now: number): number {
  const t = occurredOn ? Date.parse(occurredOn) : NaN;
  if (Number.isNaN(t)) return 0.15;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.max(0.15, Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
}

export interface SuggestionResult {
  descriptions: string[];
  category: { id: string; name: string; color: string; confidence: number } | null;
  account: { id: string; name: string; color: string; confidence: number } | null;
}

export function buildSuggestions({
  transactions,
  note,
  type,
  scope,
  categories,
  accounts,
  now = Date.now(),
}: {
  transactions: Transaction[];
  note: string;
  type: TransactionType;
  scope: TransactionScope;
  categories: Category[];
  accounts: Account[];
  now?: number;
}): SuggestionResult {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const accById = new Map(accounts.map((a) => [a.id, a]));

  // Filter transactions matching type and optionally scope
  const rows = transactions.filter((t) => t.type === type);

  const queryTokens = tokenize(note);
  const queryText = String(note || '').trim().toLowerCase();
  const hasQuery = queryTokens.length > 0;

  // 1. Description autocomplete
  const seen = new Map<string, { count: number; last: number; starts: boolean }>();
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

  // 2. Category & Account vote
  const tokenMatch = (rowTok: string) =>
    queryTokens.some((qt) => rowTok === qt || rowTok.startsWith(qt) || qt.startsWith(rowTok));

  const catVotes = new Map<string, number>();
  const accVotes = new Map<string, number>();

  for (const r of rows) {
    let similarity: number;
    if (!hasQuery) {
      similarity = r.scope === scope ? 1 : 0.5;
    } else {
      const rowTokens = tokenize(r.note);
      if (rowTokens.length === 0) continue;
      const overlap = rowTokens.filter(tokenMatch).length;
      if (overlap === 0) continue;
      similarity = Math.min(1, overlap / queryTokens.length);
      if (String(r.note || '').trim().toLowerCase() === queryText) similarity = 1.5;
    }

    const w = similarity * recencyWeight(r.occurred_on, now);
    if (r.categoryId) {
      catVotes.set(r.categoryId, (catVotes.get(r.categoryId) || 0) + w);
    }
    if (r.accountId) {
      accVotes.set(r.accountId, (accVotes.get(r.accountId) || 0) + w);
    }
  }

  const gate = hasQuery
    ? { minConfidence: 0.34, minWeight: 0.3 }
    : { minConfidence: 0.4, minWeight: 0.8 };

  const topVote = <T extends { id: string; name: string; color: string }>(
    votes: Map<string, number>,
    byId: Map<string, T>
  ) => {
    let total = 0;
    let bestId: string | null = null;
    let bestWeight = 0;

    for (const [id, w] of votes.entries()) {
      total += w;
      if (w > bestWeight) {
        bestWeight = w;
        bestId = id;
      }
    }

    if (bestId == null || total === 0 || bestWeight < gate.minWeight) return null;
    const confidence = bestWeight / total;
    if (confidence < gate.minConfidence) return null;

    const meta = byId.get(bestId);
    if (!meta) return null;

    return {
      id: bestId,
      name: meta.name,
      color: meta.color,
      confidence: Math.round(confidence * 100) / 100,
    };
  };

  return {
    descriptions,
    category: topVote(catVotes, catById),
    account: topVote(accVotes, accById),
  };
}
