/** Grammar evidence: Pāṇinian sūtra lookup and provider-generated morphological candidates. No morphology is computed here.
 *
 *  Pāṇini data — github.com/sanskrit/ashtadhyayi (no licence stated in its GitHub metadata), raw files, probed 2026-10-22:
 *   data/sutrANi.tsv                          "index<TAB>sutra" rows, e.g. "6.1.88<TAB>वृद्धिरेचि"            (247 KB; cached)
 *   padachcheda/pada-A.P/A.P.N.txt            "वृद्धिः १/१ एचि ७/१"       word + case/number as given by the repository
 *   anuvritti/pada-A.P/A.P.N.txt              "आत् ५/१ [6.1.87]"          carried-over words and the sūtra they come from
 *   adhikara/pada-A.P/A.P.N.txt               " संहितायाम् [6.1.71]  एकः पूर्वपरयोः [6.1.84] "
 *   full_sutra/pada-A.P/A.P.N.txt             the sūtra with anuvṛtti words supplied — a derived reading, NOT Pāṇini's text
 *  Per-sūtra files are missing for some sūtras (404): reported as not_provided, never filled in.
 *  Commentaries (Kāśikā, Bālamanoramā, ...) are multi-megabyte corpora on ashtadhyayi.com's data repository; they are linked, not retrieved.
 *
 *  Morphology — Sanskrit Heritage Platform lemmatizer, https://sanskrit.inria.fr/cgi-bin/SKT/sktlemmatizer.cgi?lex=SH&q=<form>&t=SL&c=<category>
 *  (form in SLP1; category ∈ Noun Pron Verb Part Inde Absya Abstvaa Voca Iic Ifc Iiv Piic). HTML out: "<form> lemmatizes as: [lemma]{analysis | analysis}"
 *  or "<form> not found as a <category> form". Alternatives are returned exactly as given. */
import { ProviderError, USER_AGENT, provenance, type FetchLike } from "./providers";
import { toIast, iastToDeva, iastToSlp1 } from "./slp1";
import { findWorks } from "./pandit";
import { setiByWork } from "./providers";

const RAW = "https://raw.githubusercontent.com/sanskrit/ashtadhyayi/master";
const DEVDIG = "०१२३४५६७८९";
const asciiDigits = (s: string) => s.replace(/[०-९]/g, c => String(DEVDIG.indexOf(c)));
export const SUTRA_REF = /^\s*(\d{1,2})\s*[.,\/:\-\s]\s*(\d{1,2})\s*[.,\/:\-\s]\s*(\d{1,3})\s*$/;
/** Plain ASCII with no diacritics is valid IAST when read literally; it is NOT guessed at (no ā/ś/ṣ/ṭ is inferred). */
const literalIast = (word: string) => { const t = toIast(word); return t.iast ? { iast: t.iast, warnings: t.warnings } : /^[A-Za-z'’\s]+$/.test(word) ? { iast: word.toLowerCase().replace(/\s+/g, " "), warnings: ["Plain ASCII was read literally as IAST; long vowels, ś/ṣ and retroflex letters are not inferred."] } : { iast: null, warnings: t.warnings }; };

async function getText(provider: string, url: string, doFetch: FetchLike, maxChars: number, timeout = 15000): Promise<{ status: number; text: string | null }> {
  let r: Response;
  try { r = await doFetch(url, { headers: { Accept: "text/plain, text/html", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new ProviderError(provider, "unavailable", `${provider} unreachable: ${(e as Error)?.name ?? "error"}`); }
  if (r.status === 404) return { status: 404, text: null };
  if (!r.ok) throw new ProviderError(provider, "http_error", `${provider} returned HTTP ${r.status}`, r.status);
  const t = await r.text(); if (t.length > maxChars) throw new ProviderError(provider, "too_large", `${provider} response exceeds ${maxChars} characters`, r.status);
  return { status: r.status, text: t };
}

let tableMemo: { at: number; text: string } | null = null;
export const resetGrammarCache = () => { tableMemo = null; };
async function sutraTable(doFetch: FetchLike): Promise<string> {
  if (tableMemo && Date.now() - tableMemo.at < 24 * 3600_000) return tableMemo.text;
  const { text } = await getText("sanskrit/ashtadhyayi", `${RAW}/data/sutrANi.tsv`, doFetch, 600_000, 25000);
  if (!text || !text.startsWith("index\tsutra\n") || !/\n1\.1\.1\t/.test(text)) throw new ProviderError("sanskrit/ashtadhyayi", "bad_json", "sūtra table does not match the observed 'index<TAB>sutra' format; not interpreted");
  tableMemo = { at: Date.now(), text }; return text;
}
const compactDeva = (s: string) => s.replace(/[\s‌‍]+/g, "");
export const sutraAt = (table: string, ref: string) => { const i = table.indexOf(`\n${ref}\t`); if (i < 0) return null; const e = table.indexOf("\n", i + 1); return table.slice(i + ref.length + 2, e < 0 ? undefined : e).trim() || null; };

/* ---------- parsers for the small per-sūtra files (raw text is always returned too) ---------- */
export const parsePadaccheda = (raw: string) => [...asciiDigits(raw).matchAll(/(\S+)\s+(\d\/\d)/g)].map(m => ({ pada: m[1], caseNumber: m[2] }));
export const parseAnuvritti = (raw: string) => [...asciiDigits(raw).matchAll(/(\S+)\s+(\d\/\d)?\s*\[(\d\.\d\.\d{1,3})\]/g)].map(m => ({ word: m[1], caseNumber: m[2] ?? null, fromSutra: m[3] }));
export const parseAdhikara = (raw: string) => [...asciiDigits(raw).matchAll(/([^\[\]]+?)\s*\[(\d\.\d\.\d{1,3})\]/g)].map(m => ({ adhikara: m[1].trim(), fromSutra: m[2] })).filter(x => x.adhikara);

export async function findRule(args: { rule: string; link_works?: boolean }, doFetch: FetchLike = fetch) {
  const q = args.rule.trim(); const table = await sutraTable(doFetch);
  const refm = SUTRA_REF.exec(asciiDigits(q));
  let candidates: Array<{ ref: string; sutra: string; matchBasis: string }> = []; let mode: string; let asciiWarnings: string[] = [];
  if (refm) {
    mode = "sutra_number"; const ref = `${refm[1]}.${refm[2]}.${Number(refm[3])}`; const s = sutraAt(table, ref);
    if (s) candidates = [{ ref, sutra: s, matchBasis: "exact_sutra_number" }];
  } else {
    mode = "sutra_text"; const t = literalIast(q); let deva: string | null = null;
    if (/[ऀ-ॿ]/.test(q)) deva = compactDeva(q); else if (t.iast) deva = iastToDeva(t.iast.replace(/\s+/g, ""));
    if (!deva) throw new RangeError("rule text must be IAST, Harvard-Kyoto or Devanāgarī (plain ASCII cannot identify a sūtra); or give a number like 6.1.88");
    asciiWarnings = t.warnings;
    const lines = table.split("\n").slice(1);
    for (const l of lines) { const tab = l.indexOf("\t"); if (tab < 0) continue; const ref = l.slice(0, tab), s = l.slice(tab + 1).trim(), c = compactDeva(s);
      if (c === deva) candidates.push({ ref, sutra: s, matchBasis: "exact_sutra_text" });
      else if (deva.length >= 6 && (c.includes(deva) || (c.length >= 6 && deva.includes(c)))) candidates.push({ ref, sutra: s, matchBasis: "partial_sutra_text" }); }
    candidates.sort((a, b) => (a.matchBasis === b.matchBasis ? 0 : a.matchBasis === "exact_sutra_text" ? -1 : 1)); candidates = candidates.slice(0, 10);
  }
  const base = { ...provenance("sanskrit/ashtadhyayi (GitHub raw files)", "data/sutrANi.tsv + per-sūtra files", 200), query: { submitted: args.rule, mode, warnings: asciiWarnings } };
  if (!candidates.length) return { ...base, status: "not_found", rules: [], note: "No sūtra in the repository's table matches. Pāṇini numbering is adhyāya.pāda.sūtra (1.1.1 to 8.4.68)." };
  const exact = candidates.filter(c => c.matchBasis.startsWith("exact"));
  if (mode === "sutra_text" && exact.length !== 1) return { ...base, status: exact.length > 1 ? "ambiguous" : "partial_matches_only", candidates, note: exact.length > 1 ? "The same sūtra text occurs at several places; none was chosen." : "No sūtra equals this text; partial containment matches are listed, none selected." };
  const pick = candidates[0]; const [a, p] = pick.ref.split("."); const dir = `pada-${a}.${p}`;
  const kinds = ["padachcheda", "anuvritti", "adhikara", "full_sutra"] as const;
  const files = await Promise.all(kinds.map(async k => { const url = `${RAW}/${k}/${dir}/${pick.ref}.txt`; try { const r = await getText("sanskrit/ashtadhyayi", url, doFetch, 4000); return [k, { url, status: r.status === 404 ? "not_provided_for_this_sutra" : "retrieved", raw: r.text?.replace(/\s+$/, "") ?? null }] as const; } catch (e) { return [k, { url, status: "provider_error", raw: null, message: (e as Error).message }] as const; } }));
  const F = Object.fromEntries(files) as Record<(typeof kinds)[number], { url: string; status: string; raw: string | null }>;
  const anu = F.anuvritti.raw ? parseAnuvritti(F.anuvritti.raw) : [], adh = F.adhikara.raw ? parseAdhikara(F.adhikara.raw) : [];
  const related = [...new Set([...anu.map(x => x.fromSutra), ...adh.map(x => x.fromSutra)])].map(r => ({ ref: r, sutra: sutraAt(table, r) }));
  const linkedWork = args.link_works !== false ? await linkWork("Aṣṭādhyāyī", doFetch) : { status: "not_requested" };
  return {
    ...base, status: "ok", candidates: candidates.length > 1 ? candidates : undefined,
    rule: { id: pick.ref, system: "Pāṇini Aṣṭādhyāyī", adhyaya: Number(a), pada: Number(p), sutraNumber: Number(pick.ref.split(".")[2]), sutra: pick.sutra, sutraIast: undefined, matchBasis: pick.matchBasis,
      sourceLocator: { repository: "https://github.com/sanskrit/ashtadhyayi", tableUrl: `${RAW}/data/sutrANi.tsv`, row: pick.ref } },
    explanation: {
      type: "structural_analysis_from_repository", note: "Word division, carried-over words (anuvṛtti) and governing headings (adhikāra) as recorded in the repository; commentary text is not retrieved. 'full_sutra' is the repository's anuvṛtti-completed reading, not Pāṇini's wording.",
      padaccheda: { ...F.padachcheda, parsed: F.padachcheda.raw ? parsePadaccheda(F.padachcheda.raw) : [] },
      anuvritti: { ...F.anuvritti, parsed: anu }, adhikara: { ...F.adhikara, parsed: adh }, completedReading: F.full_sutra, relatedRules: related
    },
    commentaries: { status: "linked_not_retrieved", page: `https://ashtadhyayi.com/sutraani/${a}/${p}/${Number(pick.ref.split(".")[2])}`, note: "The ashtadhyayi.com page for this sūtra presents Kāśikā, Bālamanoramā, Tattvabodhinī and other commentaries; their texts are multi-megabyte corpora and are not fetched here." },
    linkedWork,
    licensing: { status: "not_stated", note: "The repository states no licence in its GitHub metadata; ashtadhyayi-com/data asks for credit. Attribute the repository; check before reuse." }
  };
}

/* ---------- morphology (Sanskrit Heritage) ---------- */
export const HERITAGE = "https://sanskrit.inria.fr";
export const HERITAGE_CATEGORIES = ["Noun", "Pron", "Verb", "Part", "Inde", "Absya", "Abstvaa", "Voca", "Iic", "Ifc", "Iiv", "Piic"] as const;
const dec = (s: string) => s.replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
export function parseHeritage(html: string) {
  const version = /Version\s+([\d.]+\s*\[[^\]]+\])/.exec(html)?.[1] ?? null;
  if (/Illegal transliteration/i.test(html)) return { status: "illegal_transliteration", version, form: null, lemmas: [] };
  const nf = /<span class="red">([^<]+)<\/span>\s*<span[^>]*>\s*not found as an? (\w+) form/i.exec(html) ?? /([^<>\s]+)\s+not found as an? (\w+) form/i.exec(html);
  const ok = /<span class="red">([^<]+)<\/span>\s*<span[^>]*>\s*lemmatizes as:([\s\S]*?)<\/span>/i.exec(html);
  if (ok) {
    const lemmas = [...ok[2].matchAll(/\[\s*<a[^>]*href="([^"]*)"[^>]*>\s*<i>([^<]+)<\/i>\s*<\/a>\s*\]\s*\{([^}]*)\}/g)].map(m => ({ lemma: dec(m[2]), lemmaUrl: HERITAGE + m[1], analyses: m[3].split("|").map(x => x.trim()).filter(Boolean) }));
    return lemmas.length ? { status: "lemmatized", version, form: dec(ok[1]), lemmas } : { status: "unparsed", version, form: dec(ok[1]), lemmas: [] };
  }
  if (nf) return { status: "not_found", version, form: dec(nf[1]), lemmas: [] };
  return { status: "unparsed", version, form: null, lemmas: [] };
}
export async function analyzeForm(word: string, categories: string[] = ["Noun", "Verb"], doFetch: FetchLike = fetch) {
  const t = literalIast(word); if (!t.iast) throw new RangeError("analyze_form needs IAST, Harvard-Kyoto (with interior capitals), Devanāgarī, or ASCII read literally as IAST");
  const s = iastToSlp1(t.iast); if (!s.slp1) throw new RangeError(`cannot map to SLP1: ${s.unmapped.join(" ")}`);
  const cats = [...new Set(categories)].filter((c): c is (typeof HERITAGE_CATEGORIES)[number] => (HERITAGE_CATEGORIES as readonly string[]).includes(c)).slice(0, 4);
  if (!cats.length) throw new RangeError("categories must come from " + HERITAGE_CATEGORIES.join(", "));
  const results = await Promise.all(cats.map(async c => {
    const url = `${HERITAGE}/cgi-bin/SKT/sktlemmatizer.cgi?lex=SH&q=${encodeURIComponent(s.slp1!)}&t=SL&c=${c}`;
    try { const r = await getText("Sanskrit Heritage", url, doFetch, 20000, 20000); return { category: c, url, httpStatus: 200, ...parseHeritage(r.text ?? "") }; }
    catch (e) { return { category: c, url, ...(e instanceof ProviderError ? { status: e.kind === "unavailable" ? "provider_unavailable" : "provider_error", httpStatus: e.httpStatus ?? null, message: e.message } : { status: "provider_error", message: String(e) }) }; }
  }));
  const found = results.filter(r => r.status === "lemmatized");
  return { type: "morphological_analysis", provider: "Sanskrit Heritage Platform (Gérard Huet, Inria)", endpoint: "GET /cgi-bin/SKT/sktlemmatizer.cgi", status: found.length ? "candidates" : results.some(r => /provider_/.test(String(r.status))) ? "provider_problem" : "no_analysis", retrievedAt: new Date().toISOString(),
    form: { submitted: word, iast: t.iast, slp1: s.slp1, warnings: t.warnings }, results, alternatives: found.flatMap(r => (r as { lemmas: Array<{ lemma: string; analyses: string[] }> }).lemmas.flatMap(l => l.analyses.map(a => ({ category: r.category, lemma: l.lemma, analysis: a })))),
    note: "Provider-generated candidates, listed as returned; none is preferred. Analyses use Heritage's own abbreviations (https://sanskrit.inria.fr/DICO/grammar.html). An analysis is a candidate for an isolated form, not a reading in context, and not a derivation.",
    limits: "Isolated inflected forms only; verbs with preverbs and compounds are not lemmatized by this service. Absence means 'not recognised as this category', not that the form is wrong.",
    licensing: { status: "not_verified", note: "The service page states © Gérard Huet; terms for programmatic use were not verified. Requests here are single, bounded and identify this service." } };
}

/** Link a title to a Pandit work and its SETI electronic-text links. Only a single high-confidence title match is used; homonyms are listed, not chosen. */
export async function linkWork(title: string, doFetch: FetchLike = fetch): Promise<Record<string, unknown>> {
  try {
    const w = await findWorks(title, { limit: 5 }, doFetch); const hi = w.candidates.filter(c => c.confidence === "high");
    if (hi.length !== 1) return { status: hi.length ? "ambiguous_homonymous_works" : "no_exact_title_in_pandit", candidates: w.candidates.slice(0, 5).map(c => ({ panditWorkId: c.panditWorkId, title: c.title, confidence: c.confidence, providerUrl: c.providerUrl })), note: "No work was chosen." };
    const s = await setiByWork([Number(hi[0].panditWorkId)], doFetch);
    return { status: "ok", work: { panditWorkId: hi[0].panditWorkId, title: hi[0].title, providerUrl: hi[0].providerUrl }, setiStatus: s.status,
      setiLinks: s.status === "ok" ? s.works.flatMap(x => x.collections.flatMap(c => c.links.map(l => ({ collection: c.collection, format: l.format, url: l.url })))) : [],
      note: "Electronic texts registered in SETI for this Pandit work; electronic transcriptions, not independent manuscript witnesses. The match is by title only." };
  } catch (e) { return { status: "provider_error", message: String((e as Error)?.message ?? e).slice(0, 200) }; }
}
