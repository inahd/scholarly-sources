/** SLP1 <-> IAST <-> Devanāgarī, as needed by the Cologne lexicon (headwords are SLP1) and the Pāṇini rule table (Devanāgarī).
 *  Conversions are letter-for-letter and return null (never a guess) when a character cannot be mapped. */
import { canonIast, devanagariToIast, harvardKyotoToIast, looksHarvardKyoto, detectScript } from "./normalize";

const DI: Array<[string, string]> = [["kh", "K"], ["gh", "G"], ["ch", "C"], ["jh", "J"], ["ṭh", "W"], ["ḍh", "Q"], ["th", "T"], ["dh", "D"], ["ph", "P"], ["bh", "B"], ["ai", "E"], ["au", "O"]];
const SI: Record<string, string> = { ā: "A", ī: "I", ū: "U", ṛ: "f", ṝ: "F", ḷ: "x", ḹ: "X", ṃ: "M", ṁ: "M", ḥ: "H", ṅ: "N", ñ: "Y", ṭ: "w", ḍ: "q", ṇ: "R", ś: "S", ṣ: "z", ḻ: "L" };
const PLAIN = new Set("aiueokgcjtdnpbmyrlvsh".split(""));
/** IAST → SLP1. The IAST digraphs kh gh ch jh ṭh ḍh th dh ph bh are read as single aspirates (standard IAST). */
export function iastToSlp1(iast: string): { slp1: string | null; unmapped: string[] } {
  const s = canonIast(iast).toLowerCase().replace(/[\s'’\-]+/g, ""); let out = ""; const bad: string[] = [];
  for (let i = 0; i < s.length;) {
    const d = DI.find(([k]) => s.startsWith(k, i));
    if (d) { out += d[1]; i += d[0].length; continue; }
    const c = s[i]; if (SI[c]) out += SI[c]; else if (PLAIN.has(c)) out += c; else bad.push(c); i++;
  }
  return { slp1: bad.length ? null : out, unmapped: [...new Set(bad)] };
}
const INV: Record<string, string> = { A: "ā", I: "ī", U: "ū", f: "ṛ", F: "ṝ", x: "ḷ", X: "ḹ", M: "ṃ", H: "ḥ", N: "ṅ", Y: "ñ", w: "ṭ", q: "ḍ", R: "ṇ", S: "ś", z: "ṣ", L: "ḻ", K: "kh", G: "gh", C: "ch", J: "jh", W: "ṭh", Q: "ḍh", T: "th", D: "dh", P: "ph", B: "bh", E: "ai", O: "au" };
export const slp1ToIast = (s: string) => [...s].map(c => INV[c] ?? c).join("");

const DV: Record<string, string> = { a: "अ", ā: "आ", i: "इ", ī: "ई", u: "उ", ū: "ऊ", ṛ: "ऋ", ṝ: "ॠ", ḷ: "ऌ", e: "ए", ai: "ऐ", o: "ओ", au: "औ" };
const DM: Record<string, string> = { a: "", ā: "ा", i: "ि", ī: "ी", u: "ु", ū: "ू", ṛ: "ृ", ṝ: "ॄ", ḷ: "ॢ", e: "े", ai: "ै", o: "ो", au: "ौ" };
const DC: Record<string, string> = { k: "क", kh: "ख", g: "ग", gh: "घ", ṅ: "ङ", c: "च", ch: "छ", j: "ज", jh: "झ", ñ: "ञ", ṭ: "ट", ṭh: "ठ", ḍ: "ड", ḍh: "ढ", ṇ: "ण", t: "त", th: "थ", d: "द", dh: "ध", n: "न", p: "प", ph: "फ", b: "ब", bh: "भ", m: "म", y: "य", r: "र", l: "ल", ḻ: "ळ", v: "व", ś: "श", ṣ: "ष", s: "स", h: "ह" };
const SIGNS: Record<string, string> = { ṃ: "ं", ṁ: "ं", ḥ: "ः", "’": "ऽ", "'": "ऽ" };
const TOK = ["kh", "gh", "ch", "jh", "ṭh", "ḍh", "th", "dh", "ph", "bh", "ai", "au"];
/** IAST → Devanāgarī (no sandhi; word-internal letters only). Null on an unmappable character. */
export function iastToDeva(iast: string): string | null {
  const s = canonIast(iast).toLowerCase().replace(/\s+/g, ""); let out = ""; let pendingCons = false;
  const toks: string[] = []; for (let i = 0; i < s.length;) { const t = TOK.find(k => s.startsWith(k, i)); if (t) { toks.push(t); i += t.length; } else { toks.push(s[i]); i++; } }
  for (const t of toks) {
    if (DC[t]) { if (pendingCons) out += "्"; out += DC[t]; pendingCons = true; }
    else if (DV[t]) { if (pendingCons) { out += DM[t]; pendingCons = false; } else out += DV[t]; }
    else if (SIGNS[t]) { out += SIGNS[t]; pendingCons = false; }
    else return null;
  }
  if (pendingCons) out += "्";
  return out;
}

/** Everything a caller may have typed → strict IAST (or null). */
export function toIast(q: string): { iast: string | null; script: ReturnType<typeof detectScript>; warnings: string[] } {
  const script = detectScript(q);
  if (script === "devanagari" || script === "mixed") { const r = devanagariToIast(q); return { iast: canonIast(r.iast).toLowerCase(), script, warnings: r.warnings }; }
  if (script === "harvard_kyoto") return { iast: canonIast(harvardKyotoToIast(q)).toLowerCase(), script, warnings: ["Interior capitals were read as Harvard-Kyoto (A=ā, S=ṣ, z=ś, T=ṭ, N=ṇ, M=ṃ, H=ḥ, R=ṛ). If you meant informal ASCII, resubmit in lower case."] };
  if (script === "iast") return { iast: canonIast(q).toLowerCase(), script, warnings: [] };
  return { iast: null, script, warnings: ["Plain ASCII is ambiguous between several Sanskrit letters; matched on a folded pattern."] };
}

/** Plain-ASCII query → Lucene regexp over SLP1 headwords. Every ASCII letter stands for the SLP1 letters it may spell. Lossy by design. */
const CLASS: Record<string, string> = { a: "[aA]", i: "[iI]", u: "[uU]", e: "e", o: "o", k: "k", g: "g", c: "c", j: "j", t: "[tw]", d: "[dq]", n: "[nNYR]", p: "p", b: "b", m: "[mM]", y: "y", r: "[rfF]", l: "[lxXL]", v: "v", s: "[sSz]", h: "[hH]", f: "[fF]" };
const CLASS_DI: Record<string, string> = { kh: "K", gh: "G", ch: "C", jh: "J", th: "[TW]", dh: "[DQ]", ph: "P", bh: "B", sh: "[Sz]", ai: "E", au: "O", aa: "A", ii: "I", uu: "U", ksh: "(?:kz|kS)", jn: "jY" };
export function asciiToSlp1Regexp(ascii: string): string | null {
  const s = ascii.toLowerCase(); if (!/^[a-z]{2,40}$/.test(s)) return null; let out = "";
  const unusable = [...new Set([...s].filter(c => !CLASS[c]))]; if (unusable.length) throw new RangeError(`letters not used in plain-ASCII Sanskrit spelling: ${unusable.join(" ")}`);
  for (let i = 0; i < s.length;) {
    const t = ["ksh", "kh", "gh", "ch", "jh", "th", "dh", "ph", "bh", "sh", "ai", "au", "aa", "ii", "uu", "jn"].find(k => s.startsWith(k, i));
    if (t) { out += CLASS_DI[t]; i += t.length; } else { const c = CLASS[s[i]]; if (!c) return null; out += c; i++; }
  }
  return out;
}
export { looksHarvardKyoto };
