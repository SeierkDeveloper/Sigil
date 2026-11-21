// Client-side search. It runs where the plaintext already is: in the browser for
// the dashboard and inside the connector on the user's own machine.

export interface Searchable {
  id: string;
  title: string;
  tags: string[];
  /** The full body in the dashboard, the snippet in the connector. */
  text: string;
  editedAt: string;
}

export interface SearchHit<T> {
  item: T;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Each item's title, tags and text, lower-cased and without accents, kept per
 * item object while it lives: typing in the search box looks at the same items
 * again and again.
 */
const FLAT = new WeakMap<object, { source: string; flat: string }>();

function flatText(item: Searchable): string {
  const source = item.text;
  const hit = FLAT.get(item);
  if (hit && hit.source === source) return hit.flat;
  const flat = `${item.title}\n${item.tags.join(" ")}\n${source}`.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  FLAT.set(item, { source, flat });
  return flat;
}

/**
 * Scores every item against the query. Each query term must appear somewhere
 * (title, tag or text, prefix match allowed); title and tag matches weigh more.
 * An empty query returns everything, newest first.
 */
export function search<T extends Searchable>(items: T[], query: string, limit = Infinity): SearchHit<T>[] {
  const terms = [...new Set(tokenize(query))];
  const byRecent = (a: SearchHit<T>, b: SearchHit<T>) => (a.item.editedAt < b.item.editedAt ? 1 : a.item.editedAt > b.item.editedAt ? -1 : 0);

  if (terms.length === 0) {
    return items.map((item) => ({ item, score: 0 })).sort(byRecent).slice(0, limit);
  }

  const phrase = query.trim().toLowerCase();
  if (items.length >= INDEX_FROM) return indexedSearch(items, terms, phrase, byRecent, limit);
  const hits: SearchHit<T>[] = [];
  for (const item of items) {
    // A quick look first: every term must occur somewhere in the item's text. Most items fail here, without being split into words.
    const flat = flatText(item);
    if (!terms.every((t) => flat.includes(t))) continue;
    const titleTokens = tokenize(item.title);
    const tagTokens = item.tags.flatMap(tokenize);
    const textTokens = tokenize(item.text);
    let score = 0;
    let all = true;
    for (const term of terms) {
      const inTitle = titleTokens.some((t) => t === term) ? 6 : titleTokens.some((t) => t.startsWith(term)) ? 4 : 0;
      const inTags = tagTokens.some((t) => t === term) ? 5 : tagTokens.some((t) => t.startsWith(term)) ? 3 : 0;
      let inText = 0;
      for (const t of textTokens) {
        if (t === term) inText += 1;
        else if (t.startsWith(term)) inText += 0.5;
        if (inText >= 5) break;
      }
      if (inTitle + inTags + inText === 0) {
        all = false;
        break;
      }
      score += inTitle + inTags + inText;
    }
    if (!all) continue;
    if (phrase.length > 2 && item.title.toLowerCase().includes(phrase)) score += 4;
    hits.push({ item, score });
  }
  return hits.sort((a, b) => b.score - a.score || byRecent(a, b)).slice(0, limit);
}

// ---------------------------------------------------------------- a word index for big vaults

/** From this many items, search builds a word index once and answers each keystroke from it. */
export const INDEX_FROM = 2000;

interface WordIndex {
  n: number;
  /** token -> item positions (title, tags), and token -> [position, count, position, count, ...] (text). */
  title: Map<string, number[]>;
  tags: Map<string, number[]>;
  text: Map<string, number[]>;
}

const INDEXES = new WeakMap<object, WordIndex>();

function wordIndex(items: Searchable[]): WordIndex {
  const hit = INDEXES.get(items);
  if (hit && hit.n === items.length) return hit;
  const idx: WordIndex = { n: items.length, title: new Map(), tags: new Map(), text: new Map() };
  const listOf = (map: Map<string, number[]>, token: string) => {
    let list = map.get(token);
    if (!list) map.set(token, (list = []));
    return list;
  };
  const counts = new Map<string, number>();
  items.forEach((item, i) => {
    for (const t of new Set(tokenize(item.title))) listOf(idx.title, t).push(i);
    for (const t of new Set(item.tags.flatMap(tokenize))) listOf(idx.tags, t).push(i);
    counts.clear();
    for (const t of tokenize(item.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) listOf(idx.text, t).push(i, c);
  });
  INDEXES.set(items, idx);
  return idx;
}

/** The same scores as the plain search, from the index: titles 6 or 4, tags 5 or 3, text 1 a word and 0.5 a prefix, up to 5. */
function indexedSearch<T extends Searchable>(items: T[], terms: string[], phrase: string, byRecent: (a: SearchHit<T>, b: SearchHit<T>) => number, limit: number): SearchHit<T>[] {
  const idx = wordIndex(items);
  const n = items.length;
  let total: Float64Array | null = null;
  for (const term of terms) {
    const title = new Float64Array(n);
    const tags = new Float64Array(n);
    const text = new Float64Array(n);
    for (const [token, list] of idx.title) {
      const w = token === term ? 6 : token.startsWith(term) ? 4 : 0;
      if (w) for (const i of list) if (title[i] < w) title[i] = w;
    }
    for (const [token, list] of idx.tags) {
      const w = token === term ? 5 : token.startsWith(term) ? 3 : 0;
      if (w) for (const i of list) if (tags[i] < w) tags[i] = w;
    }
    for (const [token, list] of idx.text) {
      const w = token === term ? 1 : token.startsWith(term) ? 0.5 : 0;
      if (w) for (let k = 0; k < list.length; k += 2) text[list[k]] += w * list[k + 1];
    }
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const sum = title[i] + tags[i] + Math.min(text[i], 5);
      // Every term must be found somewhere: an item without this one drops out (-1).
      next[i] = sum === 0 || (total && total[i] < 0) ? -1 : (total ? total[i] : 0) + sum;
    }
    total = next;
  }
  const hits: SearchHit<T>[] = [];
  for (let i = 0; i < n; i++) {
    if (!total || total[i] <= 0) continue;
    let score = total[i];
    if (phrase.length > 2 && items[i].title.toLowerCase().includes(phrase)) score += 4;
    hits.push({ item: items[i], score });
  }
  return hits.sort((a, b) => b.score - a.score || byRecent(a, b)).slice(0, limit);
}
