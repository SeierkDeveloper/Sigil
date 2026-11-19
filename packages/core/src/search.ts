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
  const hits: SearchHit<T>[] = [];
  for (const item of items) {
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
