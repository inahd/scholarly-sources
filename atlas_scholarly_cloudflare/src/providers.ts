/** Public discovery only. Nothing here ingests or redistributes corpus texts. */
export const USER_AGENT = "AtlasScholarlySources/0.4 (read-only research)";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const portals = [
  { name: "Pāṇḍitya / SETI", url: "https://panditya.info/seti", role: "Sanskrit work-to-e-text discovery; API documented at https://panditya.info/api/docs", api: "live: seti_by_work" },
  { name: "Pandit Project", url: "https://panditproject.org/", role: "manuscripts, works, people and identifiers", api: "link only" },
  { name: "Muktabodha", url: "https://muktabodha.org/digital-library/", role: "Tantric texts and source catalogue", api: "link only" },
  { name: "GRETIL", url: "https://gretil.sub.uni-goettingen.de/", role: "Sanskrit electronic texts", api: "link only" },
  { name: "SARIT", url: "https://sarit.indology.info/", role: "critical and marked-up Indic editions", api: "link only" },
  { name: "VedaWeb", url: "https://vedaweb.uni-koeln.de/", role: "linguistically annotated Vedic material", api: "link only" },
  { name: "Wikidata", url: "https://www.wikidata.org/", role: "entity discovery", api: "live: find_catalog_entries" },
  { name: "Crossref", url: "https://api.crossref.org/", role: "scholarly publication metadata", api: "live: search_scholarly_literature" }
];

export class ProviderError extends Error {
  constructor(public provider: string, public kind: "unavailable" | "http_error" | "bad_content_type" | "bad_json" | "too_large", message: string, public httpStatus?: number) { super(message); }
}

const MAX_BYTES = 400_000;
export async function queryJson(provider: string, url: string, doFetch: FetchLike = fetch, timeoutMs = 12000, init: { method?: string; body?: string; contentType?: string } = {}): Promise<{ data: unknown; httpStatus: number }> {
  let response: Response;
  try {
    response = await doFetch(url, { method: init.method ?? "GET", body: init.body, headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(init.contentType ? { "Content-Type": init.contentType } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(provider, "unavailable", `${provider} unreachable: ${(e as Error)?.name ?? "error"}`);
  }
  if (!response.ok) throw new ProviderError(provider, "http_error", `${provider} returned HTTP ${response.status}`, response.status);
  const ctype = response.headers.get("content-type") ?? "";
  if (!ctype.includes("json")) throw new ProviderError(provider, "bad_content_type", `${provider} returned content-type "${ctype}"`, response.status);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new ProviderError(provider, "too_large", `${provider} response exceeds ${MAX_BYTES} characters`, response.status);
  try { return { data: JSON.parse(text), httpStatus: response.status }; }
  catch { throw new ProviderError(provider, "bad_json", `${provider} returned invalid JSON`, response.status); }
}

export const provenance = (provider: string, endpoint: string, httpStatus: number | null) =>
  ({ provider, endpoint, httpStatus, retrievedAt: new Date().toISOString() });

/* ---------- Wikidata ---------- */
export function catalogUrl(query: string): string {
  const u = new URL("https://www.wikidata.org/w/api.php");
  u.searchParams.set("action", "wbsearchentities");
  u.searchParams.set("format", "json");
  u.searchParams.set("language", "en");
  u.searchParams.set("limit", "10");
  u.searchParams.set("search", query);
  u.searchParams.set("origin", "*");
  return u.toString();
}
export async function findCatalog(query: string, doFetch: FetchLike = fetch) {
  const url = catalogUrl(query);
  const { data, httpStatus } = await queryJson("Wikidata", url, doFetch);
  const x = data as { search?: Array<{ id: string; label?: string; description?: string; concepturi: string }> };
  if (!x || !Array.isArray(x.search)) throw new ProviderError("Wikidata", "bad_json", "Wikidata response lacks a `search` array", httpStatus);
  return { ...provenance("Wikidata", "wbsearchentities", httpStatus), query, status: "discovery_only_not_text_witness",
    results: x.search.map(v => ({ id: v.id, title: v.label ?? "", description: v.description ?? "", url: v.concepturi })) };
}

/* ---------- Crossref ---------- */
/** Publication kinds kept; everything else (peer-review, posted-content, dataset, component, ...) is excluded server-side. */
export const CROSSREF_TYPES = ["journal-article", "book", "book-chapter", "monograph", "edited-book", "proceedings-article", "dissertation", "reference-entry"];
/** Titles that are structural book parts, not scholarship on their own. */
const FRONT_MATTER = /^(index|introduction|bibliography|preface|foreword|contents|table of contents|acknowledg(e)?ments?|notes|glossary|abbreviations|appendix|front matter|back matter|title page|cover|frontmatter|backmatter|references|epilogue|afterword|list of (figures|illustrations|contributors))\b/i;
export function researchUrl(query: string): string {
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("query.bibliographic", query);
  u.searchParams.set("filter", CROSSREF_TYPES.map(t => `type:${t}`).join(","));
  u.searchParams.set("rows", "25");
  u.searchParams.set("select", "DOI,title,author,issued,URL,publisher,type,container-title,score");
  return u.toString();
}
type CrossrefItem = { DOI: string; title?: string[]; URL: string; type?: string; publisher?: string; issued?: { "date-parts"?: number[][] }; "container-title"?: string[]; author?: Array<{ given?: string; family?: string; name?: string }>; score?: number };
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOP = new Set(["the", "of", "and", "with", "an", "a", "in", "on", "to", "for", "from", "sanskrit", "commentary", "manuscript", "text", "study"]);
export function queryTerms(query: string): string[] { return (fold(query).match(/[a-z]{3,}/g) ?? []).filter(t => !STOP.has(t)); }

/** Keep items whose title or container title contains at least half of the distinctive query terms
 *  (and always the first term when the query has one or two terms), and drop structural front/back matter. */
export function relevantCrossref<T extends { title: string; container?: string; type?: string }>(query: string, entries: T[]): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length / 2);
  return entries.filter(e => {
    if (FRONT_MATTER.test(e.title.trim())) return false;
    const hay = fold(`${e.title} ${e.container ?? ""}`);
    return terms.filter(t => hay.includes(t)).length >= need;
  });
}
export async function findScholarship(query: string, doFetch: FetchLike = fetch) {
  const url = researchUrl(query);
  const { data, httpStatus } = await queryJson("Crossref", url, doFetch);
  const items = (data as { message?: { items?: CrossrefItem[] } })?.message?.items;
  if (!Array.isArray(items)) throw new ProviderError("Crossref", "bad_json", "Crossref response lacks message.items", httpStatus);
  const results = items.map(v => ({
    doi: v.DOI, title: v.title?.[0] ?? "", container: v["container-title"]?.[0] ?? "", url: v.URL, type: v.type ?? "", publisher: v.publisher ?? "",
    year: v.issued?.["date-parts"]?.[0]?.[0] ?? null,
    authors: (v.author ?? []).slice(0, 6).map(a => a.name ?? [a.given, a.family].filter(Boolean).join(" ")), score: v.score ?? null
  }));
  const seen = new Set<string>();
  const matches = relevantCrossref(query, results).filter(r => (seen.has(r.doi) ? false : (seen.add(r.doi), true))).slice(0, 10);
  // Front/back-matter parts are not scholarship, but the book they belong to may be a lead. Reported separately and unverified.
  const parts = new Map<string, number>();
  for (const r of results) if (r.container && FRONT_MATTER.test(r.title.trim()) && !matches.some(m => m.doi === r.doi)) parts.set(r.container, (parts.get(r.container) ?? 0) + 1);
  const relatedWorks = [...parts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, partsReturned]) => ({ title, partsReturned }));
  return { ...provenance("Crossref", "works", httpStatus), query, status: "bibliographic_metadata_only", typesRequested: CROSSREF_TYPES,
    returned: results.length, matched: matches.length, results: matches,
    relatedWorks, relatedWorksNote: "Books whose front/back-matter parts Crossref ranked for this query. Their own titles were not checked against the query: unverified leads.",
    note: matches.length === 0 ? "No title-relevant publications; this is not evidence that scholarship or manuscripts do not exist." : "Title-matched bibliographic leads only. No verified passage evidence." };
}

/* ---------- Pāṇḍitya / SETI ----------
 * Contract taken from the provider's own Swagger document (https://panditya.info/api/swagger.json, API v2.6.2):
 *   GET /api/seti/by_work?ids=<comma-separated numeric Pandit work IDs>
 * Observed (not documented) response shape, which this parser validates before use:
 *   { "<workId>": { "<collection>": [url,...] | { "<format label>": [url,...] } } }
 * Unknown IDs are silently omitted; if no ID is known the API answers HTTP 400 {"error":"No valid work IDs provided"}.
 * Labels: GET /api/entities/labels?ids=... -> [{id,label}] (best effort). */
export const SETI_BASE = "https://panditya.info/api";
export const SETI_MAX_IDS = 20;
export type SetiLink = { format: string | null; url: string };
export type SetiCollection = { collection: string; links: SetiLink[] };

export function setiUrl(path: "seti/by_work" | "entities/labels", ids: number[]): string {
  const u = new URL(`${SETI_BASE}/${path}`);
  u.searchParams.set("ids", ids.join(","));
  return u.toString().replace(/%2C/g, ",");
}
const isUrlList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
/** Returns null when the shape is not exactly the observed one. */
export function parseSetiByWork(data: unknown): Map<string, SetiCollection[]> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const out = new Map<string, SetiCollection[]>();
  for (const [id, byCollection] of Object.entries(data)) {
    if (!/^\d+$/.test(id) || typeof byCollection !== "object" || byCollection === null || Array.isArray(byCollection)) return null;
    const collections: SetiCollection[] = [];
    for (const [collection, value] of Object.entries(byCollection)) {
      if (isUrlList(value)) collections.push({ collection, links: value.map(url => ({ format: null, url })) });
      else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const links: SetiLink[] = [];
        for (const [format, urls] of Object.entries(value)) { if (!isUrlList(urls)) return null; urls.forEach(url => links.push({ format, url })); }
        collections.push({ collection, links });
      } else return null;
    }
    out.set(id, collections);
  }
  return out;
}
export async function setiByWork(workIds: number[], doFetch: FetchLike = fetch) {
  const ids = [...new Set(workIds)];
  if (ids.length === 0 || ids.length > SETI_MAX_IDS || ids.some(n => !Number.isInteger(n) || n <= 0)) throw new RangeError(`work_ids must be 1..${SETI_MAX_IDS} positive integers`);
  const endpoint = "GET /api/seti/by_work?ids=";
  const url = setiUrl("seti/by_work", ids);
  let parsed: { data: unknown; httpStatus: number };
  try { parsed = await queryJson("Pāṇḍitya/SETI", url, doFetch, 15000); }
  catch (e) {
    if (e instanceof ProviderError && e.httpStatus === 400) {
      // Documented 400: "No IDs provided or other error". Observed body for all-unknown IDs: "No valid work IDs provided".
      return { ...provenance("Pāṇḍitya/SETI", endpoint, 400), status: "no_entries_for_ids", requestedIds: ids, works: [],
        note: "SETI has no e-text entry for any requested ID (HTTP 400). This says nothing about whether texts exist elsewhere." };
    }
    throw e;
  }
  const map = parseSetiByWork(parsed.data);
  if (!map) throw new ProviderError("Pāṇḍitya/SETI", "bad_json", "SETI response does not match the observed {workId:{collection:[urls]}} shape; not interpreted", parsed.httpStatus);
  let labels = new Map<string, string>();
  let labelStatus: "ok" | "unavailable" = "ok";
  try {
    const l = await queryJson("Pāṇḍitya/SETI", setiUrl("entities/labels", ids.filter(i => map.has(String(i)))), doFetch, 10000);
    if (Array.isArray(l.data)) for (const r of l.data as Array<{ id?: unknown; label?: unknown }>) if (typeof r?.id === "string" && typeof r?.label === "string") labels.set(r.id, r.label);
  } catch { labelStatus = "unavailable"; }
  const works = ids.map(id => ({ workId: id, label: labels.get(String(id)) ?? null, seti: map.has(String(id)), collections: map.get(String(id)) ?? [] }));
  return { ...provenance("Pāṇḍitya/SETI", endpoint, parsed.httpStatus), status: "ok", requestedIds: ids, labelStatus, works,
    note: "Links are SETI-registered e-text locations for the Pandit work ID; not verified readings, and absence of a work means only 'not in SETI'." };
}
