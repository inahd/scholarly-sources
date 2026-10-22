/** Deterministic comparison of two bounded Sanskrit readings. Pure function: no network, no model, no plausibility.
 *
 *  What it does: transliteration-aware alignment at token level, then letter (phoneme) level inside differing blocks, with spans in the
 *  ORIGINAL strings (UTF-16 code unit offsets, end exclusive). Devanāgarī and IAST are compared letter-for-letter (क → k+a, कि → k+i, क् → k).
 *  What it never does: choose a reading, call a difference an "error", infer a relationship between witnesses from similarity, or merge
 *  letters that are distinct (ś/ṣ/s, b/v, ṃ vs a class nasal, ḷ/ḻ/l, ṭ/t ...). Such pairs are only TAGGED as commonly alternating.
 *
 *  Three evidence classes for a difference (never collapsed into one):
 *   certain_difference            both sides give a definite letter, and they differ
 *   uncertain_difference          at least one side is a restored/uncertain reading ([..] or <..>) whose letters differ
 *   indeterminate_due_to_damage   a side is illegible (?) or lacunose ([...]): the position is compatible with either reading
 *  and informational classes: encoding_only, spacing_only, punctuation_difference, orthographic_equivalence.
 *
 *  Uncertainty notation (documented, conventional): `?` = one illegible position; `[...]` / `[…]` = lacuna of unknown length;
 *  `[x]` = damaged/restored but legible reading x; `<x>` = supplied or conjectured x. Disable with uncertainty_markup:"none". */
import { CONS, IND_V, MATRA, SIGN, VIRAMA, NUKTA, canonIast } from "./normalize";

export const MAX_CHARS = 1000, MAX_TOKENS = 250, MAX_BLOCK_CELLS = 100_000;
export type Normalization = "none" | "encoding" | "conservative";
export type UnitKind = "letter" | "digit" | "unk" | "gap" | "punct" | "invisible" | "other";
type Unit = { k: UnitKind; key: string; raw: string; s: number; e: number; unc: boolean; script: "deva" | "latin" | "other" };

const DEVA = (c: string) => c >= "ऀ" && c <= "ॿ";
const COMBINING = /[̀-̥̣ͯ̇]/;
const ASPIRATES = new Set(["kh", "gh", "ch", "jh", "ṭh", "ḍh", "th", "dh", "ph", "bh"]);
const PUNCT = new Set([..."।॥|/.,;:!"]);
const INVISIBLE = /[​-‍⁠﻿­]/;
const MARK_OPEN = /^\[\s*(?:\.{2,}|…|\.\s\.\s\.)\s*\]/;

/* ---------- unitization ---------- */
export function unitize(text: string, markup: boolean): { units: Unit[]; signals: Array<{ kind: string; at: number; note: string }> } {
  const units: Unit[] = []; const signals: Array<{ kind: string; at: number; note: string }> = []; let unc = 0;
  const cps: Array<{ c: string; s: number; e: number }> = []; { let p = 0; for (const c of text) { cps.push({ c, s: p, e: p + c.length }); p += c.length; } }
  let i = 0; let prevDevaConsonantish = false;
  const push = (u: Unit) => units.push(u);
  while (i < cps.length) {
    const { c, s, e } = cps[i];
    if (markup && c === "?") { push({ k: "unk", key: "?", raw: c, s, e, unc: true, script: "other" }); i++; continue; }
    if (markup && c === "[") { const m = MARK_OPEN.exec(text.slice(s)); if (m) { push({ k: "gap", key: "…", raw: m[0], s, e: s + m[0].length, unc: true, script: "other" }); while (i < cps.length && cps[i].s < s + m[0].length) i++; continue; } unc++; i++; continue; }
    if (markup && c === "<") { unc++; i++; continue; }
    if (markup && (c === "]" || c === ">")) { if (unc > 0) unc--; i++; continue; }
    if (/\s/.test(c)) { push({ k: "punct", key: " ", raw: c, s, e, unc: false, script: "other" }); i++; continue; } // whitespace: handled as separator below
    if (INVISIBLE.test(c)) { push({ k: "invisible", key: c, raw: c, s, e, unc: unc > 0, script: "other" }); i++; continue; }
    if (c === "�") { signals.push({ kind: "replacement_character", at: s, note: "U+FFFD: the text was damaged in transmission or decoding" }); push({ k: "other", key: c, raw: c, s, e, unc: unc > 0, script: "other" }); i++; continue; }
    if (DEVA(c)) {
      const cons = CONS[c];
      if (cons) {
        let j = i + 1, end = e; if (cps[j]?.c === NUKTA) { end = cps[j].e; j++; }
        const nx = cps[j]?.c;
        if (nx === VIRAMA) { push({ k: "letter", key: cons, raw: text.slice(s, cps[j].e), s, e: cps[j].e, unc: unc > 0, script: "deva" }); i = j + 1; prevDevaConsonantish = true; continue; }
        push({ k: "letter", key: cons, raw: text.slice(s, end), s, e: end, unc: unc > 0, script: "deva" });
        if (nx && MATRA[nx]) { push({ k: "letter", key: MATRA[nx], raw: nx, s: cps[j].s, e: cps[j].e, unc: unc > 0, script: "deva" }); i = j + 1; }
        else { push({ k: "letter", key: "a", raw: text.slice(s, end), s, e: end, unc: unc > 0, script: "deva" }); i = j; }
        prevDevaConsonantish = true; continue;
      }
      if (IND_V[c]) { push({ k: "letter", key: IND_V[c], raw: c, s, e, unc: unc > 0, script: "deva" }); i++; prevDevaConsonantish = false; continue; }
      if (SIGN[c]) { push({ k: "letter", key: c === "ँ" ? "m̐" : SIGN[c], raw: c, s, e, unc: unc > 0, script: "deva" }); i++; continue; }
      if (c === "।" || c === "॥") { push({ k: "punct", key: c, raw: c, s, e, unc: false, script: "deva" }); i++; continue; }
      if (c >= "०" && c <= "९") { push({ k: "digit", key: String(c.charCodeAt(0) - 0x966), raw: c, s, e, unc: unc > 0, script: "deva" }); i++; continue; }
      if (MATRA[c] || c === VIRAMA) { signals.push({ kind: "orphan_vowel_sign_or_virama", at: s, note: "a vowel sign or virama with no consonant before it: malformed Devanāgarī (typical of damage or OCR error)" }); push({ k: "other", key: c, raw: c, s, e, unc: unc > 0, script: "deva" }); i++; continue; }
      push({ k: "other", key: c, raw: c, s, e, unc: unc > 0, script: "deva" }); i++; continue;
    }
    if (/\p{L}/u.test(c)) {
      let j = i + 1; while (j < cps.length && COMBINING.test(cps[j].c)) j++;
      const raw = text.slice(s, cps[j - 1].e);
      // fast path: a lone precomposed letter needs no normalization (only ṁ→ṃ, the two dot conventions of one letter)
      const key = raw.length === 1 ? (raw === "ṁ" ? "ṃ" : raw === "Ṁ" ? "Ṃ" : raw) : canonIast(raw);
      push({ k: "letter", key, raw, s, e: cps[j - 1].e, unc: unc > 0, script: "latin" }); i = j; continue;
    }
    if (/[0-9]/.test(c)) { push({ k: "digit", key: c, raw: c, s, e, unc: unc > 0, script: "latin" }); i++; continue; }
    if (PUNCT.has(c) || /[\p{P}]/u.test(c)) { push({ k: "punct", key: c, raw: c, s, e, unc: false, script: "other" }); i++; continue; }
    push({ k: "other", key: c, raw: c, s, e, unc: unc > 0, script: "other" }); i++;
  }
  // merge Latin digraphs into single phoneme units (kh, gh, ..., ai, au); only between letters of equal certainty
  const out: Unit[] = [];
  for (const u of units) {
    const p = out[out.length - 1];
    if (p && u.script === "latin" && p.script === "latin" && p.k === "letter" && u.k === "letter" && p.unc === u.unc && p.e === u.s &&
        (ASPIRATES.has((p.key + u.key).toLowerCase()) || ["ai", "au"].includes((p.key + u.key).toLowerCase()))) { p.key += u.key; p.raw += u.raw; p.e = u.e; }
    else out.push({ ...u });
  }
  void prevDevaConsonantish;
  // damage signals: Latin letters inside a Devanāgarī word (and vice versa), consecutive viramas handled above
  let word: Unit[] = []; const flush = () => { if (word.some(u => u.script === "deva") && word.some(u => u.script === "latin" && u.k === "letter")) signals.push({ kind: "mixed_script_word", at: word[0].s, note: "Latin letters inside a Devanāgarī word (typical OCR damage)" }); word = []; };
  for (const u of out) { if (u.k === "punct" || u.k === "invisible") flush(); else word.push(u); } flush();
  return { units: out, signals };
}

/* ---------- normalization ---------- */
const ALT: Array<[string, string, string]> = [["b", "v", "b~v: commonly alternating in manuscripts and prints"], ["ś", "ṣ", "ś~ṣ: commonly confused sibilants"], ["ś", "s", "ś~s"], ["ṣ", "s", "ṣ~s"], ["n", "ṇ", "n~ṇ"], ["ṃ", "ṅ", "ṃ~ṅ: anusvāra for a class nasal"], ["ṃ", "ñ", "ṃ~ñ"], ["ṃ", "ṇ", "ṃ~ṇ"], ["ṃ", "n", "ṃ~n"], ["ṃ", "m", "ṃ~m"], ["kh", "ṣ", "kh~ṣ: Devanāgarī kha/ṣa confusion"], ["ḍ", "ḷ", "ḍ~ḷ"], ["ṛ", "r", "ṛ~r"]];
export const alternationTag = (a: string, b: string) => ALT.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2] ?? null;
export type Rule = { id: string; description: string };
export const RULES: Record<Normalization, Rule[]> = {
  none: [],
  encoding: [{ id: "unicode_canonical", description: "NFC/NFD and r+U+0325→ṛ, ṁ/ṃ (two conventions for one letter) compare equal" }, { id: "invisible_format_characters", description: "ZWJ, ZWNJ, soft hyphen, BOM ignored" }],
  conservative: [{ id: "unicode_canonical", description: "NFC/NFD, r̥→ṛ, ṁ=ṃ" }, { id: "invisible_format_characters", description: "ZWJ, ZWNJ, soft hyphen, BOM ignored" }, { id: "letter_case", description: "capital/lower case of Latin letters ignored" }, { id: "spacing", description: "word spacing ignored" }, { id: "punctuation", description: "daṇḍas and punctuation ignored" }, { id: "digit_script", description: "Devanāgarī and ASCII digits compare equal" }, { id: "avagraha_glyph", description: "' ’ ऽ compare equal" }]
};
export const KEPT_DISTINCT = ["ś/ṣ/s", "b/v", "ṃ vs ṅ ñ ṇ n m", "ḷ/ḻ/l", "ṭ/t, ḍ/d", "long vs short vowels", "kṣ/kh", "ri/ṛ", "any consonant or vowel not listed as an encoding variant"];
const KEEP_INVIS = (n: Normalization) => n === "none";
function keyOf(u: Unit, n: Normalization): string {
  if (u.k === "letter" && u.script === "latin") return n === "conservative" ? u.key.toLowerCase() : u.key;
  if (u.k === "digit" && n !== "conservative") return `${u.script}:${u.key}`;
  if (u.k === "other" && n === "conservative" && /^['’ʼऽ]$/.test(u.key)) return "’";
  if (u.k === "letter" && u.key === "’") return "’";
  return u.key;
}

/* ---------- tokens ---------- */
type Token = { i0: number; i1: number; keys: string[]; text: string; s: number; e: number; kind: "word" | "punct"; unc: boolean; wild: boolean };
function tokenize(units: Unit[], n: Normalization, text: string): Token[] {
  const toks: Token[] = []; let cur: Unit[] = [];
  const flush = (kind: Token["kind"] = "word") => { if (!cur.length) return; toks.push({ i0: units.indexOf(cur[0]), i1: units.indexOf(cur[cur.length - 1]) + 1, keys: cur.map(u => keyOf(u, n)), text: text.slice(cur[0].s, cur[cur.length - 1].e), s: cur[0].s, e: cur[cur.length - 1].e, kind, unc: cur.some(u => u.unc), wild: cur.some(u => u.k === "unk" || u.k === "gap") }); cur = []; };
  for (const u of units) {
    if (u.k === "invisible" && !KEEP_INVIS(n)) continue;
    if (u.k === "punct" && u.key === " ") { flush(); continue; }
    if (u.k === "punct") { flush(); if (n === "conservative") continue; cur = [u]; flush("punct"); continue; }
    cur.push(u);
  }
  flush(); return toks;
}
const tkey = (t: Token) => t.kind + "\u0001" + t.keys.join("\u0002");

/** Longest common subsequence over arrays of strings; returns matched index pairs. */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length, w = m + 1; const d = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i * w + j] = a[i] === b[j] ? d[(i + 1) * w + j + 1] + 1 : Math.max(d[(i + 1) * w + j], d[i * w + j + 1]);
  const out: Array<[number, number]> = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (d[(i + 1) * w + j] >= d[i * w + j + 1]) i++; else j++; }
  return out;
}

/* ---------- letter-level alignment inside a block (wildcards for ? and lacunae) ---------- */
type Op = { t: "eq" | "sub" | "del" | "ins" | "ind"; ai: number; bi: number };
function alignUnits(A: Unit[], B: Unit[], n: Normalization): Op[] | null {
  const N = A.length, M = B.length; if ((N + 1) * (M + 1) > MAX_BLOCK_CELLS) return null;
  const ka = A.map(u => keyOf(u, n)), kb = B.map(u => keyOf(u, n)); const w = M + 1; const D = new Int32Array((N + 1) * w).fill(1e9);
  const gapA = (i: number) => A[i]?.k === "gap", gapB = (j: number) => B[j]?.k === "gap";
  const wild = (u: Unit) => u.k === "unk";
  D[N * w + M] = 0;
  for (let i = N; i >= 0; i--) for (let j = M; j >= 0; j--) {
    if (i === N && j === M) continue; let best = 1e9;
    if (i < N && j < M) { const same = ka[i] === kb[j], ind = wild(A[i]) || wild(B[j]); best = Math.min(best, D[(i + 1) * w + j + 1] + (same || ind ? 0 : 1)); }
    if (i < N) best = Math.min(best, D[(i + 1) * w + j] + (gapA(i) ? 0 : 1));
    if (j < M) best = Math.min(best, D[i * w + j + 1] + (gapB(j) ? 0 : 1));
    if (i < N && gapA(i) && j < M) best = Math.min(best, D[i * w + j + 1]);        // a lacuna in A absorbs B letters at no cost
    if (j < M && gapB(j) && i < N) best = Math.min(best, D[(i + 1) * w + j]);      // and vice versa
    D[i * w + j] = best;
  }
  const ops: Op[] = []; let i = 0, j = 0;
  while (i < N || j < M) {
    const cur = D[i * w + j];
    if (i < N && j < M) { const same = ka[i] === kb[j], ind = wild(A[i]) || wild(B[j]); if (D[(i + 1) * w + j + 1] + (same || ind ? 0 : 1) === cur) { ops.push({ t: same ? "eq" : ind ? "ind" : "sub", ai: i, bi: j }); i++; j++; continue; } }
    if (i < N && gapA(i) && j < M && D[i * w + j + 1] === cur) { ops.push({ t: "ind", ai: i, bi: j }); j++; continue; }
    if (j < M && gapB(j) && i < N && D[(i + 1) * w + j] === cur) { ops.push({ t: "ind", ai: i, bi: j }); i++; continue; }
    if (i < N && D[(i + 1) * w + j] + (gapA(i) ? 0 : 1) === cur) { ops.push({ t: gapA(i) ? "ind" : "del", ai: i, bi: -1 }); i++; continue; }
    ops.push({ t: gapB(j) ? "ind" : "ins", ai: -1, bi: j }); j++;
  }
  return ops;
}

/* ---------- the comparison ---------- */
export type WitnessType = "manuscript" | "printed_edition" | "reprint" | "electronic_transcription" | "ocr_derivative" | "catalogue_only" | "unknown";
export type TranscriptionMethod = "manual_transcription" | "ocr" | "collation_note" | "digital_edition" | "unknown";
export type Reading = {
  text: string; work_id?: string; witness_id?: string; label?: string; locator?: string; source_url?: string;
  witness_type?: WitnessType; transcription_method?: TranscriptionMethod; uncertainty_status?: "none_stated" | "partly_uncertain" | "damaged" | "unknown"; derived_from?: string;
};
export type CompareArgs = { a: Reading; b: Reading; normalization?: Normalization; uncertainty_markup?: "atlas" | "none"; declared_relationship?: "unknown" | "independent" | "dependent"; independence_evidence?: string };

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, "0")).join("");
async function evidence(r: Reading) {
  const bytes = new TextEncoder().encode(r.text);
  return { original: r.text, utf8Bytes: bytes.length, sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), codeUnits: r.text.length, codePoints: [...r.text].length,
    unicodeForm: r.text.normalize("NFC") === r.text ? (r.text.normalize("NFD") === r.text ? "ASCII-or-invariant" : "NFC") : r.text.normalize("NFD") === r.text ? "NFD" : "mixed" };
}
const meta = (r: Reading) => ({ workId: r.work_id ?? null, witnessId: r.witness_id ?? null, label: r.label ?? null, locator: r.locator ?? null, sourceUrl: r.source_url ?? null, witnessType: r.witness_type ?? "unknown", transcriptionMethod: r.transcription_method ?? "unknown", uncertaintyStatus: r.uncertainty_status ?? "unknown", derivedFrom: r.derived_from ?? null });
export function independence(a: Reading, b: Reading, declared: CompareArgs["declared_relationship"], evidenceText?: string) {
  const basis: string[] = [];
  const dep = (a.derived_from && (a.derived_from === b.witness_id || a.derived_from === b.source_url)) || (b.derived_from && (b.derived_from === a.witness_id || b.derived_from === a.source_url)) || (a.witness_id && a.witness_id === b.witness_id);
  if (a.derived_from && (a.derived_from === b.witness_id || a.derived_from === b.source_url)) basis.push("reading A declares derived_from = B");
  if (b.derived_from && (b.derived_from === a.witness_id || b.derived_from === a.source_url)) basis.push("reading B declares derived_from = A");
  if (a.witness_id && a.witness_id === b.witness_id) basis.push("both readings carry the same witness_id");
  if (declared === "dependent") basis.push("caller declares the witnesses dependent");
  let status: "unknown" | "demonstrably_dependent" | "established_externally" = "unknown";
  if (dep || declared === "dependent") status = "demonstrably_dependent";
  else if (declared === "independent" && evidenceText && evidenceText.trim().length >= 10) { status = "established_externally"; basis.push("caller supplied independence_evidence (not verified by this tool)"); }
  const derivative = (t?: string) => t === "electronic_transcription" || t === "ocr_derivative" || t === "reprint";
  return { status, basis, similarityUsed: false,
    caveats: [ "Textual similarity or difference was NOT used: neither agreement nor disagreement shows independence or dependence.",
      ...(status === "unknown" && (derivative(a.witness_type) || derivative(b.witness_type)) ? ["At least one reading is typed as a derivative (electronic transcription, OCR or reprint); such witnesses usually descend from a printed edition, but that relationship is not asserted here without a declared derived_from."] : []),
      ...(declared === "independent" && status !== "established_externally" ? ["The caller declared independence without supplying independence_evidence; it is recorded as unknown."] : []) ] };
}

export async function compareReadings(args: CompareArgs) {
  const n = args.normalization ?? "none"; const markup = (args.uncertainty_markup ?? "atlas") === "atlas";
  for (const [k, r] of [["a", args.a], ["b", args.b]] as const) { if (typeof r?.text !== "string" || !r.text.length) throw new RangeError(`reading ${k}: text must be a non-empty string`); if (r.text.length > MAX_CHARS) throw new RangeError(`reading ${k}: text exceeds ${MAX_CHARS} UTF-16 code units`); }
  const ua = unitize(args.a.text, markup), ub = unitize(args.b.text, markup);
  const ta = tokenize(ua.units, n, args.a.text), tb = tokenize(ub.units, n, args.b.text);
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) throw new RangeError(`too many tokens (max ${MAX_TOKENS} per reading)`);
  const pairs = lcs(ta.map(tkey), tb.map(tkey));
  // blocks between anchors
  const blocks: Array<{ a0: number; a1: number; b0: number; b1: number }> = []; let pa = 0, pb = 0;
  for (const [i, j] of [...pairs, [ta.length, tb.length] as [number, number]]) { if (i > pa || j > pb) blocks.push({ a0: pa, a1: i, b0: pb, b1: j }); pa = i + 1; pb = j + 1; }
  const diffs: Array<Record<string, any>> = []; const counts: Record<string, number> = {}; const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const tokSpan = (T: Token[], i: number, text: string) => ({ start: T[i].s, end: T[i].e, text: text.slice(T[i].s, T[i].e), tokens: [{ index: i, text: T[i].text, start: T[i].s, end: T[i].e }] });
  const unitsOf = (U: Unit[], t: Token) => U.slice(t.i0, t.i1).filter(u => !(u.k === "invisible" && !KEEP_INVIS(n)));
  const damageIn = (t: Token, S: typeof ua.signals) => S.filter(x => x.at >= t.s && x.at < t.e).map(x => x.kind);
  const ocrA = args.a.transcription_method === "ocr" || args.a.witness_type === "ocr_derivative", ocrB = args.b.transcription_method === "ocr" || args.b.witness_type === "ocr_derivative";
  const equivalences: Array<Record<string, any>> = []; const uncertainReadings: Array<Record<string, any>> = [];
  const describe = (U: Unit[], T: string) => U.length ? { text: T.slice(U[0].s, U[U.length - 1].e), start: U[0].s, end: U[U.length - 1].e, letters: U.map(u => u.key) } : null;
  /** Letter-level comparison of one token pair → grouped changes, each in exactly one evidence class. */
  function compareTokens(UA: Unit[], UB: Unit[]) {
    const ops = alignUnits(UA, UB, n); if (!ops) return null;
    type Ch = { type: string; class: string; a: Unit[]; b: Unit[] }; const chs: Ch[] = [];
    for (const o of ops) {
      if (o.t === "eq") { chs.push({ type: "eq", class: "eq", a: [UA[o.ai]], b: [UB[o.bi]] }); continue; }
      const x = o.ai >= 0 ? UA[o.ai] : null, y = o.bi >= 0 ? UB[o.bi] : null;
      let c = o.t === "ind" ? "indeterminate_due_to_damage" : (x?.unc || y?.unc) ? "uncertain_difference" : "certain_difference";
      if (o.t === "sub" && x?.k === "digit" && y?.k === "digit" && x.key === y.key) c = "orthographic_equivalence";
      const last = chs[chs.length - 1];
      if (last && last.class === c) { if (x) last.a.push(x); if (y) last.b.push(y); } else chs.push({ type: "", class: c, a: x ? [x] : [], b: y ? [y] : [] });
    }
    return chs.filter(c => c.class !== "eq").map(c => {
      const type = c.class === "indeterminate_due_to_damage" ? "indeterminate" : c.class === "orthographic_equivalence" ? "script_variant" : c.a.length && c.b.length ? "substitution" : c.a.length ? "omission" : "insertion";
      const one = (c.class === "certain_difference" || c.class === "uncertain_difference") && c.a.length === 1 && c.b.length === 1;
      const tag = one ? (c.a[0].key !== c.b[0].key && c.a[0].key.toLowerCase() === c.b[0].key.toLowerCase() ? "letter_case: capital vs lower case" : alternationTag(keyOf(c.a[0], "none").toLowerCase(), keyOf(c.b[0], "none").toLowerCase())) : null;
      return { type, class: c.class, a: describe(c.a, args.a.text), b: describe(c.b, args.b.text), possibleAlternation: tag,
        ...(c.class === "indeterminate_due_to_damage" ? { note: "One side is illegible or lacunose here; the position is compatible with either reading and is NOT a variant." } : {}) };
    });
  }
  const lev = (A: Unit[], B: Unit[]) => { const o = alignUnits(A, B, n); return o ? o.filter(x => x.t === "sub" || x.t === "del" || x.t === "ins").length : Math.max(A.length, B.length); };
  /** Pair tokens inside a replaced block by edit distance (word↔word, punctuation↔punctuation only). */
  function pairTokens(TA: Token[], TB: Token[]): Array<[number, number]> {
    const N = TA.length, M = TB.length; if (!N || !M) return [];
    if (N * M > 1600) return Array.from({ length: Math.min(N, M) }, (_, i) => [i, i] as [number, number]);
    const cost: number[][] = TA.map(x => TB.map(y => x.kind !== y.kind ? 1e6 : lev(unitsOf(ua.units, x), unitsOf(ub.units, y))));
    const w = M + 1; const D = new Float64Array((N + 1) * w);
    for (let i = N; i >= 0; i--) for (let j = M; j >= 0; j--) { if (i === N && j === M) { D[i * w + j] = 0; continue; } let best = 1e12;
      if (i < N) best = Math.min(best, D[(i + 1) * w + j] + TA[i].keys.length); if (j < M) best = Math.min(best, D[i * w + j + 1] + TB[j].keys.length);
      if (i < N && j < M && cost[i][j] < 1e6) best = Math.min(best, D[(i + 1) * w + j + 1] + cost[i][j]); D[i * w + j] = best; }
    const out: Array<[number, number]> = []; let i = 0, j = 0;
    while (i < N && j < M) { if (cost[i][j] < 1e6 && D[(i + 1) * w + j + 1] + cost[i][j] === D[i * w + j]) { out.push([i, j]); i++; j++; } else if (D[(i + 1) * w + j] + TA[i].keys.length === D[i * w + j]) i++; else j++; }
    return out;
  }
  const pushItem = (it: Record<string, any>) => { diffs.push({ id: diffs.length + 1, ...it }); };
  // anchors: identical keys. Report uncertain readings that agree, and raw-text (encoding/case) differences between equal tokens.
  for (const [i, j] of pairs) {
    const x = ta[i], y = tb[j];
    if (x.unc) uncertainReadings.push({ side: "a", ...tokSpan(ta, i, args.a.text), agreesWithOtherSide: true, otherSide: tokSpan(tb, j, args.b.text) });
    if (y.unc) uncertainReadings.push({ side: "b", ...tokSpan(tb, j, args.b.text), agreesWithOtherSide: true, otherSide: tokSpan(ta, i, args.a.text) });
    if (x.text !== y.text && x.kind === "word" && !x.unc && !y.unc) {
      const UA = unitsOf(ua.units, x), UB = unitsOf(ub.units, y); const sameScript = new Set([...UA, ...UB].map(u => u.script)).size === 1;
      if (!sameScript) continue;                                         // Devanāgarī vs IAST: transliteration equivalence, not a normalization
      const rule = x.text.normalize("NFC") === y.text.normalize("NFC") ? "unicode_canonical" : x.text.toLowerCase() === y.text.toLowerCase() ? "letter_case" : "unicode_canonical";
      if (n === "none") { pushItem({ type: "substitution", class: "encoding_only", a: tokSpan(ta, i, args.a.text), b: tokSpan(tb, j, args.b.text), note: "Same letters; the byte sequences differ (Unicode normalization form or letter case)." }); bump("encoding_only"); }
      else { equivalences.push({ rule, a: tokSpan(ta, i, args.a.text), b: tokSpan(tb, j, args.b.text) }); }
    }
  }
  for (const bl of blocks) {
    const TA = ta.slice(bl.a0, bl.a1), TB = tb.slice(bl.b0, bl.b1);
    // Same letters, different word division (e.g. "vāhya abhyantara" / "vāhyābhyantara" never reaches here; "vāhya bhyantara" / "vāhyabhyantara" does).
    const wa = TA.filter(t => t.kind === "word"), wb = TB.filter(t => t.kind === "word");
    if (wa.length && wb.length && wa.length + wb.length === TA.length + TB.length && TA.length !== TB.length && ![...wa, ...wb].some(t => t.wild) &&
        wa.map(t => t.keys.join("\u0002")).join("\u0002") === wb.map(t => t.keys.join("\u0002")).join("\u0002")) {
      const sa = { start: TA[0].s, end: TA[TA.length - 1].e, text: args.a.text.slice(TA[0].s, TA[TA.length - 1].e) }, sb = { start: TB[0].s, end: TB[TB.length - 1].e, text: args.b.text.slice(TB[0].s, TB[TB.length - 1].e) };
      if (n === "conservative") equivalences.push({ rule: "spacing", a: sa, b: sb }); else { pushItem({ type: "substitution", class: "spacing_only", a: sa, b: sb, note: "Same letters, different word division." }); bump("spacing_only"); }
      continue;
    }
    const pr = pairTokens(TA, TB);
    const pa = new Map(pr.map(([i, j]) => [i, j])); const pb = new Set(pr.map(([, j]) => j));
    // walk the block in order, emitting pairs, omissions and insertions
    let bj = 0;
    for (let ai = 0; ai < TA.length; ai++) {
      const j = pa.get(ai);
      if (j !== undefined) { while (bj < j) { if (!pb.has(bj)) emitSingle("insertion", null, bl.b0 + bj); bj++; } bj = j + 1; emitPair(bl.a0 + ai, bl.b0 + j); }
      else emitSingle("omission", bl.a0 + ai, null);
    }
    while (bj < TB.length) { if (!pb.has(bj)) emitSingle("insertion", null, bl.b0 + bj); bj++; }
  }
  function emitSingle(type: "omission" | "insertion", ai: number | null, bj: number | null) {
    const t = ai !== null ? ta[ai] : tb[bj!]; const cls = t.kind === "punct" ? "punctuation_difference" : t.wild ? "indeterminate_due_to_damage" : t.unc ? "uncertain_difference" : "certain_difference";
    pushItem({ type, class: cls, a: ai !== null ? tokSpan(ta, ai, args.a.text) : null, b: bj !== null ? tokSpan(tb, bj, args.b.text) : null, uncertain: { a: ai !== null && ta[ai].unc, b: bj !== null && tb[bj].unc },
      involvesOcr: { a: ocrA, b: ocrB }, damageSignals: { a: ai !== null ? damageIn(ta[ai], ua.signals) : [], b: bj !== null ? damageIn(tb[bj], ub.signals) : [] },
      ...(cls === "indeterminate_due_to_damage" ? { note: "The token is damaged or lacunose; its absence on the other side is not shown to be a variant." } : {}) }); bump(cls);
    if (t.unc) uncertainReadings.push({ side: ai !== null ? "a" : "b", ...(ai !== null ? tokSpan(ta, ai, args.a.text) : tokSpan(tb, bj!, args.b.text)), agreesWithOtherSide: false, otherSide: null });
  }
  function emitPair(ai: number, bj: number) {
    const x = ta[ai], y = tb[bj], UA = unitsOf(ua.units, x), UB = unitsOf(ub.units, y);
    if (x.kind === "punct") { pushItem({ type: "substitution", class: "punctuation_difference", a: tokSpan(ta, ai, args.a.text), b: tokSpan(tb, bj, args.b.text), note: "Punctuation/daṇḍa differs; not a textual reading." }); bump("punctuation_difference"); return; }
    const unitDiffs = compareTokens(UA, UB);
    if (!unitDiffs) { pushItem({ type: "substitution", class: "uncertain_difference", unitDetail: "skipped_too_large", a: tokSpan(ta, ai, args.a.text), b: tokSpan(tb, bj, args.b.text), note: `Too large for letter-level alignment (> ${MAX_BLOCK_CELLS} cells); only the token-level difference is reported.` }); bump("uncertain_difference"); return; }
    const order = ["certain_difference", "uncertain_difference", "indeterminate_due_to_damage", "orthographic_equivalence"]; const cls = order.find(c => unitDiffs.some(u => u.class === c)) ?? "orthographic_equivalence";
    for (const u of unitDiffs) bump(u.class);
    if (x.unc || y.unc) { for (const [side, t, T, txt] of [["a", x, ta, args.a.text], ["b", y, tb, args.b.text]] as const) if (t.unc) uncertainReadings.push({ side, ...tokSpan(T, side === "a" ? ai : bj, txt), agreesWithOtherSide: false, otherSide: tokSpan(side === "a" ? tb : ta, side === "a" ? bj : ai, side === "a" ? args.b.text : args.a.text) }); }
    pushItem({ type: "substitution", class: cls, a: tokSpan(ta, ai, args.a.text), b: tokSpan(tb, bj, args.b.text), unitDiffs, uncertain: { a: x.unc, b: y.unc }, involvesOcr: { a: ocrA, b: ocrB }, damageSignals: { a: damageIn(x, ua.signals), b: damageIn(y, ub.signals) } });
  }
  const certain = counts["certain_difference"] ?? 0, unc = counts["uncertain_difference"] ?? 0, ind = counts["indeterminate_due_to_damage"] ?? 0;
  const ocr = ocrA || ocrB;
  const identical = args.a.text === args.b.text;
  return {
    status: "ok", tool: "compare_readings", deterministic: true,
    evidence: { a: { ...(await evidence(args.a)), metadata: meta(args.a), unitSignals: ua.signals }, b: { ...(await evidence(args.b)), metadata: meta(args.b), unitSignals: ub.signals }, offsets: "UTF-16 code units into the original strings, end exclusive" },
    options: { normalization: n, uncertaintyMarkup: markup ? "atlas" : "none", rulesApplied: RULES[n], keptDistinct: KEPT_DISTINCT, notation: { "?": "one illegible position", "[...] or […]": "lacuna of unknown length", "[x]": "damaged but legible reading x (uncertain)", "<x>": "supplied or conjectured x (uncertain)" } },
    tokens: { a: ta.map((t, i) => ({ index: i, text: t.text, start: t.s, end: t.e, uncertain: t.unc })), b: tb.map((t, i) => ({ index: i, text: t.text, start: t.s, end: t.e, uncertain: t.unc })) },
    differences: diffs, equivalencesApplied: equivalences, uncertainReadings,
    summary: { identicalOriginals: identical, differenceBlocks: diffs.length, letterLevelChanges: counts, certainDifferences: certain, uncertainDifferences: unc, indeterminatePositions: ind,
      identicalUnderRequestedNormalization: diffs.filter(d => !["orthographic_equivalence", "encoding_only", "punctuation_difference", "spacing_only"].includes(d.class)).length === 0, differencesByClass: diffs.reduce((m: Record<string, number>, d) => (m[d.class] = (m[d.class] ?? 0) + 1, m), {}) },
    resolution: null,
    interpretation: { resolvedBy: "nobody", note: "No variant was resolved. Differences are listed as they stand in the two transcriptions; grammatical plausibility and language-model judgment were not used. A difference between certain letters is a difference between the TRANSCRIPTIONS; whether it reflects a different historical reading, a scribal or printing variant, or transcription damage needs the witnesses themselves.",
      ...(ocr ? { ocrCaution: "At least one reading is an OCR derivative: letter differences involving it may be recognition errors. This tool does not estimate OCR quality." } : {}),
      damageVersusVariant: "indeterminate_due_to_damage = an illegible/lacunose position (compatible with either reading); certain_difference = two definite letters that differ; uncertain_difference = a restored or conjectured letter that differs." },
    independence: independence(args.a, args.b, args.declared_relationship, args.independence_evidence)
  };
}
