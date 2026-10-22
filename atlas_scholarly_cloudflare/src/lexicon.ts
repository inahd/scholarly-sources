/** Source-qualified Sanskrit dictionary lookup via the C-SALT/Kosh APIs for the Cologne Digital Sanskrit Lexicon.
 *
 *  Verified contract (probed 2026-10-22; docs https://cceh.github.io/c-salt_sanskrit_data/, software https://github.com/cceh/kosh, MIT):
 *   GET https://api.c-salt.uni-koeln.de/dicts/                       -> {about, dicts:{<id>:{properties:[...], query_types:[...], size}}}
 *   GET https://api.c-salt.uni-koeln.de/dicts/<id>/restful/entries?field=<property>&query=<q>&query_type=<type>&size=<n>
 *        -> {data:{entries:[{id, headword_slp1, xml(TEI), sense?, re_headwords_slp1?, pageUri?, created}]}}
 *   REST spec: /dicts/<id>/restful/spec (field ∈ the dict's properties; query_type ∈ term|fuzzy|match|match_phrase|prefix|wildcard|regexp).
 *  Entries are TEI-P5. Sub-entries (<re>) are returned inside their parent's xml and are searchable via `re_headwords_slp1`:
 *  e.g. MW "nakṣatra" exists only as a sub-entry of the headword "nakz" (86 KB of XML) — so only the matching <re> is extracted.
 *  No definition, sense or etymology is generated here: text is the provider's, with markup stripped. */
import { ProviderError, queryJson, provenance, type FetchLike } from "./providers";
import { iastToSlp1, slp1ToIast, toIast, asciiToSlp1Regexp } from "./slp1";

export const KOSH = "https://api.c-salt.uni-koeln.de";
export const DICTS = {
  mw: { name: "A Sanskrit-English Dictionary", author: "Monier Monier-Williams", year: 1899, glossLanguage: "en" },
  ap90: { name: "The Practical Sanskrit-English Dictionary", author: "Vaman Shivaram Apte", year: 1890, glossLanguage: "en" },
  bhs: { name: "Buddhist Hybrid Sanskrit Grammar and Dictionary", author: "Franklin Edgerton", year: 1953, glossLanguage: "en" },
  vei: { name: "Vedic Index of Names and Subjects", author: "Arthur A. Macdonell & A. Berriedale Keith", year: 1912, glossLanguage: "en" },
  pwg: { name: "Sanskrit-Wörterbuch (Großes Petersburger Wörterbuch)", author: "Otto Böhtlingk & Rudolph Roth", year: 1855, glossLanguage: "de" },
  gra: { name: "Wörterbuch zum Rig-Veda", author: "Hermann Grassmann", year: 1873, glossLanguage: "de" }
} as const;
export type DictId = keyof typeof DICTS;
export const DICT_IDS = Object.keys(DICTS) as DictId[];

/* ---------- TEI helpers (no DOM in Workers: nesting-aware tag scanning) ---------- */
export function elements(xml: string, tag: string, opts: { topLevelOnly?: boolean } = {}): Array<{ attrs: string; inner: string; start: number; end: number }> {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])([^>]*?)(/?)>`, "g"); const out: Array<{ attrs: string; inner: string; start: number; end: number }> = [];
  const stack: Array<{ attrs: string; at: number; innerStart: number }> = []; let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const closing = m[1] === "/", selfClose = m[3] === "/";
    if (selfClose) { if (!opts.topLevelOnly || stack.length === 0) out.push({ attrs: m[2], inner: "", start: m.index, end: re.lastIndex }); continue; }
    if (!closing) stack.push({ attrs: m[2], at: m.index, innerStart: re.lastIndex });
    else { const o = stack.pop(); if (!o) continue; if (!opts.topLevelOnly || stack.length === 0) out.push({ attrs: o.attrs, inner: xml.slice(o.innerStart, m.index), start: o.at, end: re.lastIndex }); }
  }
  return out.sort((a, b) => a.start - b.start);
}
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`).exec(attrs)?.[1];
/** Markup → text: notes dropped (their ids are harvested separately), source citations bracketed, the SLP1 half of <choice> kept. */
export function teiText(xml: string): string {
  return decode(xml.replace(/<note\b[\s\S]*?<\/note>/g, "").replace(/<reg\b[^>]*ana="as0"[^>]*>[\s\S]*?<\/reg>/g, "")
    .replace(/<cit\b[^>]*type="literary_source"[^>]*>([\s\S]*?)<\/cit>/g, (_m, i: string) => ` [${i.replace(/<[^>]+>/g, "").trim()}] `)
    .replace(/<(?:lb|pb|milestone|g)\b[^>]*\/>/g, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").replace(/\s+([,.;:)\]])/g, "$1").replace(/([(\[])\s+/g, "$1").trim();
}
const harvestL = (xml: string) => [...xml.matchAll(/<idno\b[^>]*ana="L"[^>]*>([^<]+)<\/idno>/g)].map(m => m[1]);
const harvestPages = (xml: string) => [...xml.matchAll(/<ref\b[^>]*type="facs"[^>]*>([^<]+)<\/ref>/g)].map(m => m[1]);

export type SenseOut = { n: string | null; text: string; lNumbers: string[]; pages: string[] };
export type EntryOut = {
  dictionary: { id: string; name: string; author: string; year: number; glossLanguage: string };
  entryId: string; matchedVia: "headword" | "sub_entry"; subEntryId: string | null; parent: { entryId: string; headwordSlp1: string } | null;
  headwordSlp1: string; headwordIast: string; homonymNumber: string | null; level: string | null;
  lNumbers: string[]; pages: string[]; grammar: string[]; senses: SenseOut[]; derivedHeadwordCount: number; derivedHeadwords: string[];
  textIsMarkupStrippedProviderText: true; teiLength: number; facsimileUrl: string | null; providerRequest: string;
};
const MAX_SENSES = 12, MAX_TEXT = 1200;
function parseBody(inner: string, own: string): { senses: SenseOut[]; grammar: string[]; derived: string[] } {
  // Own content = before the first nested <re>; top-level <sense> blocks only (PWG nests numbered sub-senses inside).
  const cut = own.search(/<re\b/); const body = cut >= 0 ? own.slice(0, cut) : own;
  const senses = elements(body, "sense", { topLevelOnly: true }).slice(0, MAX_SENSES).map(s => ({ n: attr(s.attrs, "n") ?? null, text: teiText(s.inner).slice(0, MAX_TEXT), lNumbers: harvestL(s.inner), pages: harvestPages(s.inner) }));
  const grammar = [...new Set(elements(body, "gramGrp", { topLevelOnly: false }).map(g => teiText(g.inner)).filter(Boolean))].slice(0, 6);
  const derived = elements(own, "re", { topLevelOnly: true }).map(r => /<orth\b[^>]*>([^<]+)<\/orth>/.exec(r.inner)?.[1] ?? "").filter(Boolean);
  return { senses, grammar, derived };
}
export function entryFromTei(dict: DictId, doc: { id: string; headword_slp1?: string; xml: string; pageUri?: string }, via: { slp1: string; mode: "headword" | "sub_entry" }, req: string): EntryOut[] {
  const meta = { id: dict, ...DICTS[dict] };
  const mk = (xml: string, entryId: string, hw: string, parent: EntryOut["parent"], subId: string | null, attrsStr: string): EntryOut => {
    const b = parseBody(xml, xml); const n = attr(attrsStr, "n");
    return { dictionary: meta, entryId, matchedVia: via.mode, subEntryId: subId, parent, headwordSlp1: hw, headwordIast: slp1ToIast(hw), homonymNumber: n && /^\d+$/.test(n) && n.length <= 3 ? n : null, level: attr(attrsStr, "ana") ?? null,
      lNumbers: harvestL(xml.slice(0, cutIdx(xml))).slice(0, 12), pages: [...new Set(harvestPages(xml.slice(0, cutIdx(xml))))].slice(0, 6), grammar: b.grammar, senses: b.senses,
      derivedHeadwordCount: b.derived.length, derivedHeadwords: b.derived.slice(0, 20), textIsMarkupStrippedProviderText: true, teiLength: doc.xml.length, facsimileUrl: doc.pageUri ?? null, providerRequest: req };
  };
  const cutIdx = (x: string) => { const i = x.search(/<re\b/); return i >= 0 ? i : x.length; };
  if (via.mode === "headword") { const root = elements(doc.xml, "entry")[0]; if (!root) return []; return [mk(root.inner, doc.id, doc.headword_slp1 ?? via.slp1, null, null, root.attrs)]; }
  // sub-entry: every <re> (any depth) whose key1 orth equals the SLP1 form
  return elements(doc.xml, "re").filter(r => new RegExp(`<orth\\b[^>]*ana="key1"[^>]*>${via.slp1}</orth>`).test(r.inner.slice(0, 400)))
    .map(r => mk(r.inner, doc.id, via.slp1, { entryId: doc.id, headwordSlp1: doc.headword_slp1 ?? "" }, attr(r.attrs, "xml:id") ?? null, r.attrs));
}

/* ---------- provider access ---------- */
let catMemo: { at: number; dicts: Record<string, { properties: string[] }> } | null = null;
export const resetLexiconCache = () => { catMemo = null; };
async function catalogue(doFetch: FetchLike) {
  if (catMemo && Date.now() - catMemo.at < 6 * 3600_000) return catMemo.dicts;
  const { data, httpStatus } = await queryJson("C-SALT/Kosh", `${KOSH}/dicts/`, doFetch, 15000);
  const d = (data as { dicts?: Record<string, { properties?: string[] }> })?.dicts;
  if (!d || typeof d !== "object" || !Object.values(d).every(x => Array.isArray(x?.properties))) throw new ProviderError("C-SALT/Kosh", "bad_json", "dictionary catalogue does not match the observed {dicts:{id:{properties}}} shape", httpStatus);
  catMemo = { at: Date.now(), dicts: d as Record<string, { properties: string[] }> }; return catMemo.dicts;
}
const entriesUrl = (dict: string, field: string, q: string, type: string, size: number) => `${KOSH}/dicts/${dict}/restful/entries?${new URLSearchParams({ field, query: q, query_type: type, size: String(size) })}`;
async function fetchEntries(dict: DictId, field: string, q: string, type: string, size: number, doFetch: FetchLike) {
  const url = entriesUrl(dict, field, q, type, size);
  const { data, httpStatus } = await queryJson("C-SALT/Kosh", url, doFetch, 20000);
  const e = (data as { data?: { entries?: Array<{ id: string; xml: string; headword_slp1?: string; pageUri?: string }> } })?.data?.entries;
  if (!Array.isArray(e) || !e.every(x => typeof x?.id === "string" && typeof x?.xml === "string")) throw new ProviderError("C-SALT/Kosh", "bad_json", "entries response does not match the observed {data:{entries:[{id,xml}]}} shape", httpStatus);
  return { entries: e, url, httpStatus };
}
export const providerFail = (e: unknown) => e instanceof ProviderError ? { status: e.kind === "unavailable" ? "provider_unavailable" : "provider_error", kind: e.kind, httpStatus: e.httpStatus ?? null, message: e.message } : { status: "provider_error", kind: "internal", httpStatus: null, message: String((e as Error)?.message ?? e).slice(0, 200) };

export type LookupArgs = { word: string; dictionaries?: DictId[]; max_entries?: number; scheme?: "auto" | "slp1" };
export async function lookupWord(args: LookupArgs, doFetch: FetchLike = fetch) {
  const dicts = [...new Set(args.dictionaries?.length ? args.dictionaries : (["mw", "ap90", "pwg"] as DictId[]))];
  const size = Math.min(Math.max(args.max_entries ?? 5, 1), 10);
  const warnings: string[] = [];
  // Input → SLP1 candidates (exact), or a folded regexp for plain ASCII.
  let slp1: string | null = null, regexp: string | null = null, script: string, iast: string | null = null;
  if (args.scheme === "slp1") { if (!/^[A-Za-z]{1,40}$/.test(args.word)) throw new RangeError("scheme=slp1 expects ASCII letters only"); slp1 = args.word; script = "slp1"; iast = slp1ToIast(slp1); }
  else {
    const t = toIast(args.word); script = t.script; warnings.push(...t.warnings);
    if (t.iast) { const c = iastToSlp1(t.iast); if (c.slp1) { slp1 = c.slp1; iast = t.iast; } else throw new RangeError(`cannot map to SLP1: ${c.unmapped.join(" ")}`); }
    else { regexp = asciiToSlp1Regexp(args.word); if (!regexp) throw new RangeError("word must be 2-40 ASCII letters, IAST, Harvard-Kyoto or Devanāgarī"); }
  }
  const cat = await catalogue(doFetch);
  const perDict: Array<Record<string, unknown>> = []; const all: EntryOut[] = [];
  await Promise.all(dicts.map(async d => {
    const props = cat[d]?.properties ?? [];
    if (!cat[d]) { perDict.push({ dictionary: d, status: "dictionary_not_offered_by_provider" }); return; }
    const jobs: Array<{ field: string; q: string; type: string; mode: "headword" | "sub_entry" }> = slp1
      ? [{ field: "headword_slp1", q: slp1, type: "term", mode: "headword" }, ...(props.includes("re_headwords_slp1") ? [{ field: "re_headwords_slp1", q: slp1, type: "term", mode: "sub_entry" as const }] : [])]
      : [{ field: "headword_slp1", q: regexp!, type: "regexp", mode: "headword" }];
    const found: EntryOut[] = []; const requests: string[] = []; let failure: unknown = null; const seen = new Set<string>();
    await Promise.all(jobs.map(async j => {
      try {
        const r = await fetchEntries(d, j.field, j.q, j.type, size, doFetch); requests.push(r.url);
        for (const doc of r.entries) for (const e of entryFromTei(d, doc, { slp1: slp1 ?? doc.headword_slp1 ?? "", mode: j.mode }, r.url)) { const k = `${e.entryId}|${e.subEntryId}`; if (!seen.has(k)) { seen.add(k); found.push(e); } }
      } catch (e) { failure = e; }
    }));
    if (failure && !found.length) perDict.push({ dictionary: d, ...providerFail(failure), requests });
    else perDict.push({ dictionary: d, status: found.length ? "entries_found" : "no_entry", entryCount: found.length, queriedFields: jobs.map(j => `${j.field}:${j.type}`), requests, ...(failure ? { partialFailure: providerFail(failure) } : {}),
      ...(found.length ? {} : { note: `No entry for this form in ${d.toUpperCase()} (${DICTS[d].name}) via the C-SALT index. That is a statement about this index, not about the language.` }) });
    all.push(...found);
  }));
  const order = (e: EntryOut) => [dicts.indexOf(e.dictionary.id as DictId), e.matchedVia === "headword" ? 0 : 1, Number(e.homonymNumber ?? 0), e.entryId] as const;
  all.sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : 1); });
  const homonyms = dicts.map(d => { const es = all.filter(e => e.dictionary.id === d); const hw = new Map<string, EntryOut[]>(); for (const e of es) hw.set(e.headwordSlp1, [...(hw.get(e.headwordSlp1) ?? []), e]);
    return [...hw].filter(([, v]) => v.length > 1).map(([h, v]) => ({ dictionary: d, headwordSlp1: h, count: v.length, entryIds: v.map(e => e.subEntryId ?? e.entryId), note: "Separate homonymous entries in the source; not merged." })); }).flat();
  const failed = perDict.filter(p => /provider_/.test(String(p.status))).length;
  return {
    ...provenance("C-SALT/Kosh (Cologne Digital Sanskrit Lexicon)", "GET /dicts/<id>/restful/entries", 200),
    status: all.length ? (failed ? "partial" : "ok") : failed === dicts.length ? "providers_failed" : failed ? "partial_not_found" : "not_found",
    query: { submitted: args.word, script, iast, slp1, matchedAs: slp1 ? "exact SLP1 headword / sub-entry headword" : "folded ASCII pattern (lossy: several SLP1 letters per ASCII letter)", regexp: regexp ?? undefined },
    layers: {
      lexical: { type: "dictionary_entries", entries: all, homonyms, dictionariesQueried: dicts, dictionariesAvailable: DICT_IDS, note: "Definitions are the source dictionaries' own text with markup stripped; none was generated, merged or ranked by sense." },
      morphological: { type: "morphological_analysis", status: "not_requested", note: "A dictionary headword is not a grammatical analysis. Use analyze_form for provider-generated candidates." },
      contextual: { type: "contextual_interpretation", status: "not_provided", note: "This service gives no reading-in-context; choosing between senses needs the passage." }
    },
    perDictionary: perDict, warnings,
    licensing: { status: "not_stated_by_provider_api", note: "The C-SALT API and data repository state no licence for the dictionary data (the Kosh software is MIT). Cite the original dictionary and check Cologne's terms before reuse." },
    attribution: dicts.map(d => `${DICTS[d].author}, ${DICTS[d].name} (${DICTS[d].year}); digitized by the Cologne Digital Sanskrit Lexicon, served by C-SALT.`)
  };
}
