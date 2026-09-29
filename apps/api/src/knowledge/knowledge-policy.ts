/**
 * Wave 8 Knowledge suggest heuristic (pure, unit-tested).
 *
 * Suggest-only and explicitly labeled: token overlap between a ticket's
 * symptom text and the current version text of tenant knowledge items.
 * No embeddings, no pg_trgm (deferred by task constraint) — plain
 * normalized token matching with stopword filtering, so results are
 * explainable (`matchedTerms`) and never presented as verified answers.
 */

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,que,de,da,do,das,dos,em,no,na,nos,nas,um,uma,por,para,com,como,se,os,as,o,e,é,ao,aos,seu,sua,nao,não,mais,muito,esta,este,isso,isto,ele,ela,eles,elas,foi,ser,tem,ha,há,meu,minha,quando,onde,qual,quais,entre,sobre,após,antes,depois,at,by,from,is,are,was,were,be,been,has,have,had,will,would,can,could,should,not,no,yes,do,does,did,this,that,these,those,then,than,so,such,only,also,into,over,after,before,between,my,your,his,her,its,our,their,what,which,who,whom,when,where,why,how".split(
    ",",
  ),
);

export function tokenize(text: string): string[] {
  const terms = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

export interface SuggestCandidate {
  id: string;
  text: string;
}

/**
 * Rank candidates by distinct matched-term overlap. Returns at most `limit`
 * entries with a positive score, ordered by score desc. Pure and
 * deterministic — the SQL layer pre-filters with ILIKE; this ranks.
 */
export function rankSuggestions(
  queryTerms: string[],
  candidates: SuggestCandidate[],
  limit: number,
): Array<{ id: string; score: number; matchedTerms: string[] }> {
  const query = new Set(queryTerms);
  const scored = candidates.map((c) => {
    const haystack = ` ${c.text.toLowerCase()} `;
    const matched = [...query].filter((t) => haystack.includes(t));
    return { id: c.id, score: matched.length, matchedTerms: matched.sort() };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(limit, 0));
}

/**
 * Wave 15 freshness (pure, unit-tested).
 *
 * `freshness_score` decays exponentially with the age of the item's last
 * update and recovers slightly with recent successful use: an item nobody
 * touched or used for a long time sinks toward 0, a freshly verified or
 * recently used item stays near 1. The refresh command recomputes this
 * for every item (manual POST — no scheduler); items at or below the
 * threshold flip VERIFIED → DEGRADED so the list can surface them.
 */

export const FRESHNESS_HALF_LIFE_DAYS = 180;
export const FRESHNESS_DEGRADED_THRESHOLD = 0.3;
export const FRESHNESS_USE_BOOST_CAP = 0.2;
export const FRESHNESS_USE_BOOST_PER_HIT = 0.02;

export function computeFreshnessScore(args: {
  ageDays: number;
  halfLifeDays?: number;
  recentUseCount?: number;
}): number {
  const halfLife = args.halfLifeDays ?? FRESHNESS_HALF_LIFE_DAYS;
  const uses = Math.max(args.recentUseCount ?? 0, 0);
  const age = Math.max(args.ageDays, 0);
  const decay = Math.exp((-age * Math.LN2) / Math.max(halfLife, 1));
  const boost = Math.min(FRESHNESS_USE_BOOST_CAP, uses * FRESHNESS_USE_BOOST_PER_HIT);
  const score = Math.min(1, decay + boost);
  return Math.round(score * 10000) / 10000;
}

export function isDegradedScore(score: number): boolean {
  return score <= FRESHNESS_DEGRADED_THRESHOLD;
}
