/** Sanskrit-aware query normalization.
 *
 *  Two tiers, never mixed up:
 *   - STRICT: IAST, NFC, lower-case, separators removed. Distinct letters stay distinct (ś≠ṣ≠s, ṭ≠t, ā≠a, ḷ≠ḻ≠l).
 *     The only equivalences are pure encoding variants of the SAME letter: NFC/NFD, r+U+0325→ṛ, and the two
 *     anusvāra dot conventions ṃ (U+1E43) / ṁ (U+1E41).
 *   - FOLDED: diacritics stripped. Lossy by construction; used only for recall, and every match made at this tier is
 *     reported as such with lower confidence.
 *  Variants record where each form came from so a caller can see exactly what was searched. */

export type Script = "devanagari" | "iast" | "ascii" | "harvard_kyoto" | "mixed";
export type Variant = { form: string; kind: string; lossy: boolean; basis: string };
export type Normalized = {
  submitted: string; script: Script; strict: string;      // primary strict form (IAST, NFC, lower-case, words kept)
  strictKeys: string[];                                    // compact strict keys (separators removed)
  foldedKeys: string[];                                    // compact folded keys (lossy)
  variants: Variant[]; warnings: string[];
};

const MARKS = /[̀-ͯ]/g;
export const SEPARATORS = /[\s\-‐‑–—.'’‧·_()[\]{}:;,/\\|"“”]+/g;

/** Encoding-only canonicalisation of IAST. */
export function canonIast(s: string): string {
  return s.normalize("NFD")
    .replace(/r̥/g, "ṛ").replace(/R̥/g, "Ṛ")          // r + ring below
    .replace(/l̥/g, "ḷ").replace(/L̥/g, "Ḷ")
    .replace(/ṁ/g, "ṁ").replace(/ṃ/g, "ṃ")
    .normalize("NFC").replace(/ṁ/g, "ṃ").replace(/Ṁ/g, "Ṃ");
}
export const strictKey = (s: string) => canonIast(s).toLowerCase().replace(SEPARATORS, "");
export const foldCompact = (s: string) => s.normalize("NFD").replace(MARKS, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export const foldWords = (s: string) => s.normalize("NFD").replace(MARKS, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/* ---------- Devanāgarī → IAST ---------- */
const IND_V: Record<string, string> = { "अ": "a", "आ": "ā", "इ": "i", "ई": "ī", "उ": "u", "ऊ": "ū", "ऋ": "ṛ", "ॠ": "ṝ", "ऌ": "ḷ", "ॡ": "ḹ", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au" };
const MATRA: Record<string, string> = { "ा": "ā", "ि": "i", "ी": "ī", "ु": "u", "ू": "ū", "ृ": "ṛ", "ॄ": "ṝ", "ॢ": "ḷ", "ॣ": "ḹ", "े": "e", "ै": "ai", "ो": "o", "ौ": "au" };
const CONS: Record<string, string> = { "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ṅ", "च": "c", "छ": "ch", "ज": "j", "झ": "jh", "ञ": "ñ", "ट": "ṭ", "ठ": "ṭh", "ड": "ḍ", "ढ": "ḍh", "ण": "ṇ", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "ḷ", "व": "v", "श": "ś", "ष": "ṣ", "स": "s", "ह": "h" };
const SIGN: Record<string, string> = { "ं": "ṃ", "ँ": "ṃ", "ः": "ḥ", "ऽ": "’" };
const VIRAMA = "्", NUKTA = "़";
const isDeva = (c: string) => c >= "ऀ" && c <= "ॿ";
const ACCENT = /[॑-॔᳐-᳹]/g;

export function devanagariToIast(src: string): { iast: string; warnings: string[] } {
  const s = src.normalize("NFC").replace(ACCENT, "").replace(new RegExp(NUKTA, "g"), "");
  const w: string[] = []; let out = ""; const cs = [...s];
  if (/[॑-॔᳐-़᳹]/.test(src)) w.push("Vedic accent marks / nukta in the input were ignored.");
  if (cs.includes("ँ")) w.push("Candrabindu (ँ) was read as anusvāra ṃ.");
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (CONS[c]) {
      const n = cs[i + 1];
      if (n === VIRAMA) { out += CONS[c]; i++; }
      else if (n && MATRA[n]) { out += CONS[c] + MATRA[n]; i++; }
      else out += CONS[c] + "a";
    } else if (IND_V[c]) out += IND_V[c];
    else if (SIGN[c]) out += SIGN[c];
    else if (c === "ॐ") out += "oṃ";
    else if (c === "।" || c === "॥") out += " ";
    else if (c >= "०" && c <= "९") out += String(c.charCodeAt(0) - 0x966);
    else if (isDeva(c)) w.push(`Unmapped Devanāgarī character U+${c.codePointAt(0)!.toString(16).toUpperCase()} dropped.`);
    else out += c;
  }
  return { iast: out, warnings: w };
}

/* ---------- Harvard-Kyoto → IAST (only when interior capitals show it is HK) ---------- */
const HK_ORDER: Array<[string, string]> = [["lRR", "ḹ"], ["RR", "ṝ"], ["lR", "ḷ"], ["R", "ṛ"], ["A", "ā"], ["I", "ī"], ["U", "ū"], ["M", "ṃ"], ["H", "ḥ"], ["G", "ṅ"], ["J", "ñ"], ["T", "ṭ"], ["D", "ḍ"], ["N", "ṇ"], ["z", "ś"], ["S", "ṣ"]];
/** Harvard-Kyoto is recognised only by an INTERIOR capital (one that follows a lower-case letter), because a leading
 *  capital is ordinary capitalisation ("Tantrarāja" is not "ṭantrarāja"). */
export const looksHarvardKyoto = (s: string) => /^[A-Za-z0-9\s\-']+$/.test(s) && /[a-z][ARIUMHGJTDNSL]/.test(s);
export function harvardKyotoToIast(s: string): string {
  let out = ""; for (let i = 0; i < s.length;) {
    const wordStart = i === 0 || /[\s\-']/.test(s[i - 1]);
    const hit = HK_ORDER.find(([k]) => s.startsWith(k, i));
    if (hit && !(wordStart && hit[0].length === 1 && /[A-Z]/.test(hit[0]))) { out += hit[1]; i += hit[0].length; }
    else { out += s[i].toLowerCase(); i++; }
  }
  return out.replace(/aa/g, "ā").replace(/ii/g, "ī").replace(/uu/g, "ū");
}

/* ---------- plain-ASCII spelling variants (lossy; folded tier only) ---------- */
const ASCII_RULES: Array<[RegExp, string, string]> = [
  [/ksh/g, "ks", "ksh→kṣ"], [/sh/g, "s", "sh→ś/ṣ"], [/chh/g, "ch", "chh→ch"], [/ch/g, "c", "ch→c (English spelling of च)"],
  [/ri/g, "r", "ri→ṛ"], [/aa/g, "a", "aa→ā"], [/ii/g, "i", "ii→ī"], [/uu/g, "u", "uu→ū"], [/w/g, "v", "w→v"], [/jny|gy/g, "jn", "jny/gy→jñ"]
];

export function detectScript(s: string): Script {
  const deva = [...s].some(isDeva), latin = /[A-Za-z]/.test(s);
  if (deva && latin) return "mixed"; if (deva) return "devanagari";
  const nonAscii = /[^\x00-\x7f]/.test(s);
  if (nonAscii) return "iast";
  return looksHarvardKyoto(s) ? "harvard_kyoto" : "ascii";
}

export function normalizeQuery(submitted: string): Normalized {
  const warnings: string[] = []; const variants: Variant[] = [];
  const script = detectScript(submitted);
  let primary: string;
  if (script === "devanagari" || script === "mixed") {
    const r = devanagariToIast(submitted); primary = canonIast(r.iast); warnings.push(...r.warnings);
    variants.push({ form: primary, kind: "iast_from_devanagari", lossy: false, basis: "Devanāgarī → IAST, letter for letter" });
    if (script === "mixed") warnings.push("Input mixes Devanāgarī and Latin; Latin parts were kept as typed.");
  } else if (script === "harvard_kyoto") {
    primary = canonIast(harvardKyotoToIast(submitted));
    variants.push({ form: primary, kind: "iast_from_harvard_kyoto", lossy: false, basis: "interior capitals read as Harvard-Kyoto" });
  } else primary = canonIast(submitted);
  primary = primary.toLowerCase().replace(/\s+/g, " ").trim();
  if (script === "iast" || script === "ascii") variants.unshift({ form: primary, kind: script === "iast" ? "submitted_iast" : "submitted_ascii", lossy: false, basis: "as submitted (NFC, lower-case)" });
  if (/ṃ/.test(primary)) variants.push({ form: primary.replace(/ṃ/g, "ṁ"), kind: "anusvara_dot_convention", lossy: false, basis: "ṃ and ṁ are two conventions for the same letter" });

  const folded = new Set<string>([foldCompact(primary)]);
  if (script === "ascii" || script === "harvard_kyoto") {
    // Lossy ASCII spelling expansions: each adds a folded key, reported as a variant, never replacing the submitted form.
    for (const [re, to, basis] of ASCII_RULES) {
      const f = foldCompact(primary); if (!re.test(f)) { re.lastIndex = 0; continue; } re.lastIndex = 0;
      const v = foldCompact(primary.replace(re, to)); if (v && !folded.has(v)) { folded.add(v); variants.push({ form: v, kind: "ascii_spelling_variant", lossy: true, basis }); }
    }
    const all = ASCII_RULES.reduce((s, [re, to]) => s.replace(re, to), foldCompact(primary));
    if (all && !folded.has(all)) { folded.add(all); variants.push({ form: all, kind: "ascii_spelling_variant", lossy: true, basis: "all spelling rules combined" }); }
    if (/sh/.test(primary)) {
      variants.push({ form: primary.replace(/sh/g, "ś"), kind: "ascii_digraph_expansion", lossy: true, basis: "sh read as ś" });
      variants.push({ form: primary.replace(/sh/g, "ṣ"), kind: "ascii_digraph_expansion", lossy: true, basis: "sh read as ṣ (ś and ṣ are NOT merged; both offered)" });
    }
    warnings.push("Plain ASCII cannot distinguish long/short vowels, ś/ṣ/s or retroflex/dental; matches are made on diacritic-folded keys and reported as lower confidence.");
  }
  return { submitted, script, strict: primary, strictKeys: [...new Set([strictKey(primary), ...variants.filter(v => !v.lossy).map(v => strictKey(v.form))])].filter(Boolean), foldedKeys: [...folded].filter(Boolean), variants, warnings };
}

/* ---------- multi-part queries: "<work> with <commentary>" ---------- */
const GLUE = new Set(["the", "a", "an", "of", "in", "to", "for", "from", "text", "edition", "manuscript", "manuscripts", "sanskrit", "commentary", "comm", "by"]);
export type QueryPart = { text: string; role: "base" | "commentary" | "single"; norm: Normalized; words: string[] };
export function splitQuery(submitted: string): { parts: QueryPart[]; connector: string | null } {
  const q = submitted.trim().replace(/\s+/g, " ");
  const mk = (t: string, role: QueryPart["role"]): QueryPart => {
    const cleaned = t.split(" ").filter(w => !GLUE.has(foldCompact(w))).join(" ").trim();
    const norm = normalizeQuery(cleaned || t);
    return { text: cleaned || t, role, norm, words: foldWords(norm.strict) };
  };
  let m = /^(.+?)\s+(?:commentary\s+(?:on|to|of)|(?:on|of))\s+(.+)$/i.exec(q);
  if (m) return { parts: [mk(m[2], "base"), mk(m[1], "commentary")], connector: "commentary-on" };
  m = /^(.+?)\s+(?:with|and|plus|\+|&)\s+(.+)$/i.exec(q);
  if (m) return { parts: [mk(m[1], "base"), mk(m[2], "commentary")], connector: "with" };
  return { parts: [mk(q, "single")], connector: null };
}
