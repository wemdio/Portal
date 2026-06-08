/**
 * Live HH areas search. The full api.hh.ru/areas tree is ~14k nodes (regions →
 * cities → districts) — too big to bake into the client bundle, so the server
 * fetches + caches it and searches it per query. These are the pure, framework-
 * free helpers (unit-tested separately); the caching/fetch lives in the route.
 */
export interface HhAreaNode {
  id: string | number;
  name: string;
  areas?: HhAreaNode[];
}

export interface HhAreaHit {
  id: string;
  name: string;
  /** Parent region name for disambiguation; '' for top-level regions / federal cities. */
  region: string;
}

/**
 * Flatten the HH "Россия" subtree into a flat list. Top-level nodes (regions and
 * federal cities like Москва/Санкт-Петербург) get region=''; every descendant
 * carries its top-level region's name so duplicate city names can be told apart.
 */
export function flattenHhAreas(root: HhAreaNode): HhAreaHit[] {
  const out: HhAreaHit[] = [];
  for (const top of root.areas ?? []) {
    out.push({ id: String(top.id), name: top.name, region: '' });
    const stack: HhAreaNode[] = [...(top.areas ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as HhAreaNode;
      out.push({ id: String(node.id), name: node.name, region: top.name });
      for (const child of node.areas ?? []) stack.push(child);
    }
  }
  return out;
}

/**
 * Rank areas for a query: exact name → prefix → substring, shorter names first
 * (so "Сочи" beats "Сочинский район" for "соч"). Returns at most `limit` hits.
 */
export function searchHhAreas(flat: HhAreaHit[], query: string, limit = 25): HhAreaHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: { hit: HhAreaHit; score: number }[] = [];
  for (const hit of flat) {
    const n = hit.name.toLowerCase();
    let score: number | null = null;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.includes(q)) score = 2;
    if (score !== null) scored.push({ hit, score });
  }

  scored.sort((a, b) => a.score - b.score || a.hit.name.length - b.hit.name.length);
  return scored.slice(0, limit).map((s) => s.hit);
}
