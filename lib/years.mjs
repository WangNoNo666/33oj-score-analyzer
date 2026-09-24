/**
 * years.mjs — 年份筛选与归属
 *
 * OJ 上存在时间戳录入错误（例如标题写 2026、beginAt 却是 2036）。
 * 因此年份归属规则是：优先用 beginAt 的年份；
 * 若该年份不在所选范围内、但标题里出现了所选年份，则按标题归属并标记 dateSuspect。
 */

/** beginAt 的自然年份（本地时区）。 */
export const dateYear = (c) => new Date(c.begin * 1000).getFullYear();

/** 全部出现过的年份 → 场次统计。 */
export function availableYears(contests) {
  const m = new Map();
  for (const c of contests) {
    const y = dateYear(c);
    m.set(y, (m.get(y) || 0) + 1);
  }
  return [...m.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}

/**
 * 解析年份参数。
 * @param {string|number[]|'all'|null} spec  '2026' | '2024,2025,2026' | '2024-2026' | 'all' | null
 * @returns {number[]|'all'}
 */
export function parseYears(spec) {
  if (spec === null || spec === undefined || spec === '' || spec === 'all') return 'all';
  if (Array.isArray(spec)) return [...new Set(spec.map(Number).filter(Number.isInteger))].sort();
  const out = new Set();
  for (const part of String(spec).split(/[,，\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d{4})\s*[-~至]\s*(\d{4})$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let y = a; y <= b; y++) out.add(y);
    } else if (/^\d{4}$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(`无法识别的年份: ${part}（支持 2026、2024,2025、2024-2026、all）`);
    }
  }
  return out.size ? [...out].sort() : 'all';
}

/**
 * 按年份挑选比赛，并给每场打上 `year` / `yearSource` / `dateSuspect`。
 * @returns {{contests: Array, byTitle: Array, years: number[]|'all'}}
 */
export function selectContests(contests, spec, { titleFallback = true } = {}) {
  const years = parseYears(spec);
  const all = contests.map((c) => ({ ...c, year: dateYear(c), yearSource: 'date', dateSuspect: false }));
  if (years === 'all') {
    return { contests: all, byTitle: [], years: 'all' };
  }
  const picked = [];
  for (const c of all) {
    if (years.includes(c.year)) {
      picked.push(c);
      continue;
    }
    const hit = titleFallback ? years.find((y) => String(c.title).includes(String(y))) : null;
    if (hit) {
      picked.push({ ...c, year: hit, yearSource: 'title', dateSuspect: true });
    }
  }
  return { contests: picked, byTitle: picked.filter((c) => c.dateSuspect), years };
}
