/** Pāṇḍitya / Pandit title-to-work discovery.
 *
 *  Verified contracts (probed 2026-10-22, API v2.6.2, https://panditya.info/api/swagger.json):
 *   GET  /api/entities/works            -> [{"id":"105678","label":"Gaṇitakaumudī (105678)"}, ...]   (13,683 works; one 1.2 MB array)
 *        label grammar: <title> (<id>) followed by zero or more " [..]" groups; each group is either a date/era
 *        annotation ("[1750 (author)]", "[-400]") or a comma-separated list of alternative titles ("[A, B]"), possibly "[[A]]".
 *   POST /api/graph/subgraph {works:[id],hops:1} -> {graph:{nodes:[{id,type,label,aka,dates,discipline,etext_links,is_central}],
 *        edges:[{relationship,source,target}]}}   relationships seen: "source author wrote target work",
 *        "source base text inspired target commentary".
 *  Pandit's own front end links works as https://www.panditproject.org/node/<id>.
 *
 *  CPU note (Workers free tier, 10 ms): the 1.2 MB list is NOT JSON.parse'd. It is kept as raw text and scanned with a
 *  native RegExp built from the query; only the few matching records are parsed. */
import { ProviderError, queryJson, provenance, USER_AGENT, type FetchLike } from "./providers";
import { foldCompact, foldWords, strictKey, splitQuery, normalizeQuery, SEPARATORS, type QueryPart } from "./normalize";

export const PANDIT_API = "https://panditya.info/api";
export const PANDIT_NODE = "https://www.panditproject.org/node/";
const TTL_MS = 6 * 3600_000, MAX_WORKS_BYTES = 4_000_000;

/* ---------- raw works index (cached per isolate) ---------- */
let memo: { text: string; fetchedAt: number } | null = null;
let inflight: Promise<{ text: string; fetchedAt: number }> | null = null;
export const resetPanditCache = () => { memo = null; inflight = null; };
export async function worksIndex(doFetch: FetchLike = fetch): Promise<{ text: string; fetchedAt: number; cached: boolean }> {
  if (memo && Date.now() - memo.fetchedAt < TTL_MS) return { ...memo, cached: true };
  inflight ??= (async () => {
    let r: Response;
    try { r = await doFetch(`${PANDIT_API}/entities/works`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(25000) }); }
    catch (e) { throw new ProviderError("Pāṇḍitya", "unavailable", `Pāṇḍitya unreachable: ${(e as Error)?.name ?? "error"}`); }
    if (!r.ok) throw new ProviderError("Pāṇḍitya", "http_error", `Pāṇḍitya returned HTTP ${r.status}`, r.status);
    if (!(r.headers.get("content-type") ?? "").includes("json")) throw new ProviderError("Pāṇḍitya", "bad_content_type", "works list is not JSON", r.status);
    const text = await r.text();
    if (text.length > MAX_WORKS_BYTES) throw new ProviderError("Pāṇḍitya", "too_large", `works list exceeds ${MAX_WORKS_BYTES} characters`, r.status);
    if (!/^\s*\[\s*\{"id":\s*"\d+",\s*"label":/.test(text)) throw new ProviderError("Pāṇḍitya", "bad_json", "works list does not match the observed [{id,label}] shape; not interpreted", r.status);
    return (memo = { text, fetchedAt: Date.now() });
  })().finally(() => { inflight = null; });
  return { ...(await inflight), cached: false };
}

/* ---------- label grammar ---------- */
export type WorkRecord = { id: string; title: string; alternativeTitles: string[]; annotations: string[]; label: string };
const DATEISH = /^[\d\s–\-c.?()a-z]*\d[\d\s–\-c.?()a-z]*$/i;
export function parseLabel(id: string, label: string): WorkRecord | null {
  const m = /^(.*) \((\d+)\)((?: \[.*\])*)$/s.exec(label);
  if (!m || m[2] !== id) return null;
  const alts: string[] = [], notes: string[] = [];
  for (const g of m[3].matchAll(/\[((?:[^\[\]]|\[[^\]]*\])*)\]/g)) {
    const body = g[1].replace(/^\[|\]$/g, "").trim();
    if (!body) continue;
    if (DATEISH.test(body) && !/[a-zāīūṛḷṃḥśṣṭḍṇñṅ]{4,}/i.test(body.replace(/\(author\)/i, ""))) notes.push(body);
    else for (const a of body.split(/,\s+/)) if (a.trim()) alts.push(a.trim());
  }
  return { id, title: m[1], alternativeTitles: alts, annotations: notes, label };
}

/* ---------- regex recall over the raw text ---------- */
const VARIANT_CHARS: Record<string, string> = { a: "āĀáà", i: "īĪí", u: "ūŪú", e: "é", o: "ó", r: "ṛṝṚṜ", l: "ḷḹḻḶḸ", m: "ṃṁṂṀ", n: "ṅñṇṄÑṆ", t: "ṭṬ", d: "ḍḌ", s: "śṣŚṢ", h: "ḥḤ" };
const esc = (c: string) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
const SEP = "(?:[ \\-.'()_]|\\\\u(?:2010|2011|2019|2027|00b7|00a0))*(?:[\\u0300-\\u036f]|\\\\u03[0-6][0-9a-f])*";
export function recallPattern(compact: string): RegExp {
  const body = [...compact].map(c => { const v = VARIANT_CHARS[c]; return v ? `(?:${c}|${[...v].map(x => x + "|" + esc(x)).join("|")})` : c.replace(/[^a-z0-9]/g, ""); }).join(SEP);
  return new RegExp(body, "gi");
}
export function scanIndex(text: string, compactKey: string, cap = 400): { records: Array<{ id: string; label: string }>; truncated: boolean; skipped: number } {
  const re = recallPattern(compactKey); const found = new Map<number, { id: string; label: string }>(); let skipped = 0, m: RegExpExecArray | null, truncated = false;
  while ((m = re.exec(text))) {
    const s = text.lastIndexOf('{"id"', m.index); const e = text.indexOf('"}', m.index);
    if (s < 0 || e < 0) { skipped++; re.lastIndex = m.index + 1; continue; }
    if (!found.has(s)) { try { const o = JSON.parse(text.slice(s, e + 2)); if (typeof o.id === "string" && typeof o.label === "string") found.set(s, o); else skipped++; } catch { skipped++; } }
    if (found.size >= cap) { truncated = true; break; }
    re.lastIndex = e + 2;
  }
  return { records: [...found.values()], truncated, skipped };
}

/* ---------- scoring ---------- */
export type MatchBasis = { part: string; role: QueryPart["role"]; basis: string; matchedOn: "title" | "alternative_title"; lossy: boolean };
type PartScore = { score: number; basis: string; matchedOn: "title" | "alternative_title"; lossy: boolean };
const ASCII_WORD_RULES: Array<[RegExp, string]> = [[/ksh/g, "ks"], [/sh/g, "s"], [/chh/g, "ch"], [/ch/g, "c"], [/ri/g, "r"], [/aa/g, "a"], [/ii/g, "i"], [/uu/g, "u"], [/w/g, "v"]];
const wordVariants = (w: string, lossyAscii: boolean) => { const v = new Set([w]); if (lossyAscii) { v.add(ASCII_WORD_RULES.reduce((s, [r, t]) => s.replace(r, t), w)); for (const [r, t] of ASCII_WORD_RULES) v.add(w.replace(r, t)); } return [...v].filter(x => x.length >= 3); };

export function scorePart(part: QueryPart, rec: WorkRecord): PartScore | null {
  const asciiInput = part.norm.script === "ascii" || part.norm.script === "harvard_kyoto";
  const titles: Array<[string, "title" | "alternative_title"]> = [[rec.title, "title"], ...rec.alternativeTitles.map(a => [a, "alternative_title"] as [string, "alternative_title"])];
  let best: PartScore | null = null; const take = (s: PartScore) => { if (!best || s.score > best.score) best = s; };
  for (const [t, on] of titles) {
    const w = on === "title" ? 1 : 0.9, sk = strictKey(t), fk = foldCompact(t);
    if (part.norm.strictKeys.includes(sk)) { take({ score: 1 * w, basis: "exact_iast", matchedOn: on, lossy: false }); continue; }
    if (part.norm.foldedKeys.includes(fk)) { take(asciiInput ? { score: 0.85 * w, basis: "exact_after_diacritic_folding", matchedOn: on, lossy: true } : { score: 0.7 * w, basis: "equal_after_folding_but_diacritics_differ", matchedOn: on, lossy: true }); continue; }
    const keys = part.norm.foldedKeys.filter(k => k.length >= 4);
    const hit = keys.find(k => fk.includes(k));
    if (hit) { const strictHit = !asciiInput && part.norm.strictKeys.some(k => sk.includes(k)); take({ score: (0.35 + 0.45 * hit.length / fk.length + (strictHit ? 0.1 : 0)) * w, basis: strictHit ? "title_contains_query_iast" : "title_contains_query_folded", matchedOn: on, lossy: !strictHit }); continue; }
    if (part.words.length >= 2) {
      const ok = part.words.every(wd => wordVariants(wd, asciiInput).some(v => fk.includes(v)));
      if (ok) take({ score: 0.6 * w, basis: "all_words_any_order", matchedOn: on, lossy: true });
    }
  }
  return best;
}
const confidence = (s: number) => (s >= 0.9 ? "high" : s >= 0.6 ? "medium" : "low");

export type Candidate = {
  rank: number; panditWorkId: string; title: string; alternativeTitles: string[]; annotations: string[];
  score: number; confidence: "high" | "medium" | "low"; matchBasis: MatchBasis[]; partial: boolean;
  providerUrl: string; ambiguousWith: string[]; providerRecord: { id: string; label: string };
};

export async function findWorks(query: string, opts: { limit?: number } = {}, doFetch: FetchLike = fetch) {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 15);
  const { parts, connector } = splitQuery(query);
  const idx = await worksIndex(doFetch);
  // Recall: compact keys of every part, plus per-word keys for multi-word parts.
  const keysFor = (p: QueryPart) => [...new Set([...p.norm.foldedKeys, ...(p.words.length >= 2 ? p.words.flatMap(w => wordVariants(w, p.norm.script === "ascii" || p.norm.script === "harvard_kyoto")) : [])])].filter(k => k.length >= 3);
  const pool = new Map<string, WorkRecord>(); let truncated = false, skipped = 0;
  for (const p of parts) for (const k of keysFor(p)) {
    const r = scanIndex(idx.text, k); truncated ||= r.truncated; skipped += r.skipped;
    for (const rec of r.records) if (!pool.has(rec.id)) { const pr = parseLabel(rec.id, rec.label); if (pr) pool.set(rec.id, pr); else skipped++; }
  }
  const base = parts[0], comm = parts[1];
  let commentaryOnly = 0; const scored: Array<{ rec: WorkRecord; score: number; basis: MatchBasis[]; partial: boolean }> = [];
  for (const rec of pool.values()) {
    const b = scorePart(base, rec), c = comm ? scorePart(comm, rec) : null;
    if (!b || b.score < 0.3) { if (c && c.score >= 0.3) commentaryOnly++; continue; }
    const basis: MatchBasis[] = [{ part: base.text, role: base.role, basis: b.basis, matchedOn: b.matchedOn, lossy: b.lossy }];
    let score = b.score, partial = false;
    if (comm) {
      if (c && c.score >= 0.3) { score = Math.min(1, b.score * 0.75 + c.score * 0.25 + 0.05); basis.push({ part: comm.text, role: comm.role, basis: c.basis, matchedOn: c.matchedOn, lossy: c.lossy }); }
      else { score = b.score * 0.75; partial = true; }
    }
    scored.push({ rec, score: Math.round(score * 1000) / 1000, basis, partial });
  }
  scored.sort((a, b) => b.score - a.score || a.rec.title.length - b.rec.title.length || Number(a.rec.id) - Number(b.rec.id));
  const byFold = new Map<string, string[]>();
  for (const s of scored) { const f = foldCompact(s.rec.title); byFold.set(f, [...(byFold.get(f) ?? []), s.rec.id]); }
  const candidates: Candidate[] = scored.slice(0, limit).map((s, i) => ({
    rank: i + 1, panditWorkId: s.rec.id, title: s.rec.title, alternativeTitles: s.rec.alternativeTitles, annotations: s.rec.annotations,
    score: s.score, confidence: confidence(s.score), matchBasis: s.basis, partial: s.partial, providerUrl: PANDIT_NODE + s.rec.id,
    ambiguousWith: (byFold.get(foldCompact(s.rec.title)) ?? []).filter(id => id !== s.rec.id), providerRecord: { id: s.rec.id, label: s.rec.label }
  }));
  const strong = candidates.filter(c => c.score >= 0.85);
  const ambiguity = candidates.some(c => c.ambiguousWith.length) ? { kind: "homonymous_titles", note: "Distinct Pandit works share this title after folding; they were not merged. Use panditWorkId to choose.", groups: [...new Set(candidates.filter(c => c.ambiguousWith.length).map(c => [c.panditWorkId, ...c.ambiguousWith].sort().join(",")))] }
    : strong.length > 1 ? { kind: "multiple_strong_matches", note: "More than one work matches strongly; none was preferred.", groups: [strong.map(c => c.panditWorkId).join(",")] } : null;
  const warnings = [...new Set(parts.flatMap(p => p.norm.warnings))];
  if (truncated) warnings.push("Index scan reached its candidate cap; results may be incomplete.");
  return {
    ...provenance("Pāṇḍitya", "GET /api/entities/works (title index, scanned locally)", 200),
    status: candidates.length ? "ok" : "no_candidates",
    query: { submitted: query, connector, parts: parts.map(p => ({ text: p.text, role: p.role, script: p.norm.script, strict: p.norm.strict, strictKeys: p.norm.strictKeys, foldedKeys: p.norm.foldedKeys, variants: p.norm.variants })) },
    indexFetchedAt: new Date(idx.fetchedAt).toISOString(), indexCached: idx.cached, indexSize: { works: 13683, note: "approximate; count is from the 2026-10-22 probe" },
    candidates, totalMatched: scored.length, commentaryNameOnlyMatches: commentaryOnly, ambiguity, warnings,
    note: candidates.length ? "Candidates are title matches in the Pandit work list, ranked by match basis. A match is not proof that the work is the one intended: check title, authors and relations."
      : `No Pandit work title matches the base title${commentaryOnly ? ` (${commentaryOnly} works matched the commentary name only and were not listed)` : ""}. This is not evidence that the work does not exist elsewhere.`
  };
}

/* ---------- relations ---------- */
type GNode = { id: string; type: string; label: string; aka?: string; dates?: string; discipline?: string | null; etext_links?: unknown; is_central?: boolean };
type GEdge = { relationship: string; source: string; target: string };
export async function workRelations(workId: string, doFetch: FetchLike = fetch) {
  const { data, httpStatus } = await queryJson("Pāṇḍitya", `${PANDIT_API}/graph/subgraph`, doFetch, 15000, { method: "POST", body: JSON.stringify({ works: [workId], hops: 1 }), contentType: "application/json" });
  const g = (data as { graph?: { nodes?: GNode[]; edges?: GEdge[] } })?.graph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || !g.nodes.every(n => typeof n?.id === "string" && typeof n?.type === "string" && typeof n?.label === "string") || !g.edges.every(e => typeof e?.relationship === "string" && typeof e?.source === "string" && typeof e?.target === "string"))
    throw new ProviderError("Pāṇḍitya", "bad_json", "subgraph response does not match the observed {graph:{nodes,edges}} shape; not interpreted", httpStatus);
  const node = new Map(g.nodes.map(n => [n.id, n]));
  const slim = (n: GNode) => ({ id: n.id, label: n.label, ...(n.aka ? { aka: n.aka } : {}), ...(n.dates ? { dates: n.dates } : {}), ...(n.type === "work" ? { hasEtextLinks: !!n.etext_links } : {}) });
  const cap = 20; const authors: unknown[] = [], commentaries: unknown[] = [], baseTexts: unknown[] = []; const seen = new Set<string>(); let more = 0;
  for (const e of g.edges) {
    if (e.source !== workId && e.target !== workId) continue;
    seen.add(e.relationship);
    const other = node.get(e.source === workId ? e.target : e.source); if (!other) continue;
    const row = { ...slim(other), relationship: e.relationship, edge: { source: e.source, target: e.target } };
    const bucket = e.relationship === "source author wrote target work" && e.target === workId ? authors
      : e.relationship === "source base text inspired target commentary" ? (e.source === workId ? commentaries : baseTexts) : null;
    if (!bucket) continue; if (bucket.length >= cap) { more++; continue; } bucket.push(row);
  }
  const c = g.nodes.find(n => n.id === workId);
  return { provider: "Pāṇḍitya", endpoint: "POST /api/graph/subgraph", httpStatus, workId, found: !!c,
    work: c ? { ...slim(c), discipline: c.discipline ?? null } : null, authors, commentaries, baseTexts, relationshipsSeen: [...seen],
    nodeCount: g.nodes.length, edgeCount: g.edges.length, truncatedItems: more,
    note: authors.length ? undefined : "Pandit records no author edge for this work; absence here is not evidence of anonymity." };
}
export { normalizeQuery };
