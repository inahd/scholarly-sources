/** Internet Archive printed-book discovery.
 *  Verified contract (probed 2026-10-22): GET https://archive.org/advancedsearch.php?q=<solr>&rows=N&output=json&fl[]=...
 *  -> {response:{numFound,start,docs:[{identifier,title,creator,date,mediatype,language,licenseurl,...}]}}.
 *  Items are scans of printed books; the provider metadata does not say whether a record is an edition, a translation,
 *  a study or a reprint, so none of that is asserted. Nothing is downloaded. */
import { ProviderError, queryJson, provenance, type FetchLike } from "./providers";
import { foldCompact, foldWords, type QueryPart } from "./normalize";

const GENRE_SUFFIX = ["tantra", "sutra", "siddhanta", "samhita", "sastra", "purana", "upanisad", "kaumudi", "gita", "kosa", "karika", "darpana"];
/** Phrase clauses for the title field: the typed words, and (for one long compact token) a split before a known genre suffix. */
export function titleClauses(part: QueryPart): string[] {
  const out = new Set<string>(); const words = foldWords(part.norm.strict);
  if (words.length) out.add(words.join(" "));
  for (const k of part.norm.foldedKeys) {
    if (words.length === 1 && k.length > 8) for (const s of GENRE_SUFFIX) if (k.endsWith(s) && k.length > s.length + 3) out.add(`${k.slice(0, -s.length)} ${s}`);
    if (words.length === 1) out.add(k);
  }
  return [...out].filter(c => /^[a-z0-9 ]{3,80}$/.test(c)).slice(0, 5);
}
export function archiveUrl(clauses: string[], rows: number): string {
  const u = new URL("https://archive.org/advancedsearch.php");
  u.searchParams.set("q", `title:(${clauses.map(c => `"${c}"`).join(" OR ")}) AND mediatype:texts`);
  u.searchParams.set("rows", String(rows)); u.searchParams.set("output", "json");
  for (const f of ["identifier", "title", "creator", "date", "language", "licenseurl", "publisher", "description"]) u.searchParams.append("fl[]", f);
  return u.toString();
}
type IaDoc = { identifier: string; title?: string | string[]; creator?: string | string[]; date?: string; language?: string | string[]; licenseurl?: string; publisher?: string | string[]; description?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("; ") : v ?? "");
export async function searchArchive(base: QueryPart, commentary: QueryPart | undefined, rows = 8, doFetch: FetchLike = fetch) {
  const clauses = titleClauses(base);
  if (!clauses.length) return { ...provenance("Internet Archive", "advancedsearch", null), status: "query_too_short", items: [], note: "No usable title clause could be built." };
  const url = archiveUrl(clauses, Math.min(Math.max(rows, 1), 15));
  const { data, httpStatus } = await queryJson("Internet Archive", url, doFetch, 20000);
  const resp = (data as { response?: { numFound?: number; docs?: IaDoc[] } })?.response;
  if (!resp || !Array.isArray(resp.docs) || typeof resp.numFound !== "number" || !resp.docs.every(d => typeof d?.identifier === "string"))
    throw new ProviderError("Internet Archive", "bad_json", "advancedsearch response does not match the observed {response:{numFound,docs}} shape", httpStatus);
  const ck = commentary ? commentary.norm.foldedKeys[0] : null;
  const items = resp.docs.map(d => {
    const title = one(d.title), hay = foldCompact(`${title} ${one(d.description).slice(0, 4000)}`);
    return { identifier: d.identifier, title, creator: one(d.creator), date: d.date ?? null, language: one(d.language), publisher: one(d.publisher), licenseUrl: d.licenseurl ?? null,
      detailsUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`, commentaryTermInMetadata: ck && ck.length >= 4 ? hay.includes(ck) : null };
  });
  return { ...provenance("Internet Archive", "GET /advancedsearch.php", httpStatus), status: items.length ? "ok" : "no_items", titleClauses: clauses, numFound: resp.numFound, items,
    note: "Scans of printed books matched on title. Whether a record is an edition, translation, study or reprint is not stated by the provider; rights are as listed by the provider (often unstated)." };
}
