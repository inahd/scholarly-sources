import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, fixture, callTool, toolJson } from "./helpers.mjs";
const C = await load("compare");
const IAST = fixture("kalanitya_v35_iast.txt"), OCR = fixture("kalanitya_v35_ocr_deva.txt");
const cmp = (a, b, o = {}) => C.compareReadings({ a: typeof a === "string" ? { text: a } : a, b: typeof b === "string" ? { text: b } : b, ...o });
const items = (r, cls) => r.differences.filter(d => !cls || d.class === cls);
const changes = (r) => r.differences.flatMap(d => (d.unitDiffs ?? []).map(u => ({ ...u, token: [d.a?.text, d.b?.text] })));

test("Kālanityā ch.25 v.35: Muktabodha IAST vs Devanāgarī OCR of the same print — real differences, spans in the originals, nothing resolved", async () => {
  const r = await cmp({ text: IAST, witness_id: "witness:tantrarajatantra:muktabodha:M00122", witness_type: "electronic_transcription", transcription_method: "manual_transcription", locator: "Manoramā ch.25 v.35, printed p.464" },
                      { text: OCR, witness_id: "witness:tantrarajatantra:mishra-1926-ocr", witness_type: "ocr_derivative", transcription_method: "ocr", locator: "Manoramā ch.25 v.35, printed p.464" });
  // originals byte-for-byte, with independent hashes
  assert.equal(r.evidence.a.original, IAST); assert.equal(r.evidence.b.original, OCR);
  assert.equal(r.evidence.a.sha256, createHash("sha256").update(IAST, "utf8").digest("hex")); assert.equal(r.evidence.b.sha256, createHash("sha256").update(OCR, "utf8").digest("hex"));
  assert.equal(r.evidence.b.utf8Bytes, Buffer.byteLength(OCR, "utf8"));
  // every reported span slices the original to exactly the reported text
  for (const d of r.differences) { if (d.a) assert.equal(IAST.slice(d.a.start, d.a.end), d.a.text); if (d.b) assert.equal(OCR.slice(d.b.start, d.b.end), d.b.text); for (const u of d.unitDiffs ?? []) { if (u.a) assert.equal(IAST.slice(u.a.start, u.a.end), u.a.text); if (u.b) assert.equal(OCR.slice(u.b.start, u.b.end), u.b.text); } }
  const ch = changes(r).filter(u => u.class === "certain_difference");
  // specific, checkable letter differences between the two transcriptions
  assert.ok(ch.some(u => u.a.letters.join() === "au" && u.b.letters.join() === "ī" && u.token[0] === "anulomavilomau"), "vilomau / विलोमी");
  assert.ok(ch.some(u => u.a.letters.join() === "v" && u.b.letters.join() === "b" && u.possibleAlternation?.startsWith("b~v")), "vāhya / बाद्या is tagged b~v, not merged");
  assert.ok(ch.some(u => u.a.letters.join() === "h" && u.b.letters.join() === "d"), "bāhya / बाद्या h→d");
  assert.ok(ch.some(u => u.token[0] === "vyākīrṇamityapi" && u.a.letters.join() === "ī,r" && u.b.letters.join() === "au"), "vyākīrṇa / व्याकौण");
  // the OCR side is flagged; the caution is explicit; no resolution
  assert.ok(r.differences.filter(d => d.class === "certain_difference").every(d => d.involvesOcr.b === true && d.involvesOcr.a === false)); assert.match(r.interpretation.ocrCaution, /recognition errors/); assert.equal(r.resolution, null);
  // punctuation and digit-script differences are NOT counted as readings
  assert.ok(items(r, "punctuation_difference").length >= 3); assert.ok(r.differences.some(d => d.class === "orthographic_equivalence" && d.a.text === "35" && d.b.text === "३५"));
  assert.equal(r.summary.certainDifferences, ch.length); assert.equal(r.summary.indeterminatePositions, 0); assert.equal(r.summary.identicalUnderRequestedNormalization, false);
  // metadata echoed; locator and source preserved
  assert.equal(r.evidence.a.metadata.locator, "Manoramā ch.25 v.35, printed p.464"); assert.equal(r.evidence.b.metadata.witnessType, "ocr_derivative");
});
test("Conservative normalization removes only punctuation/digit-script noise: the letter differences remain, nothing is silently resolved", async () => {
  const none = await cmp(IAST, OCR), cons = await cmp(IAST, OCR, { normalization: "conservative" });
  const letters = (r) => changes(r).filter(u => u.class === "certain_difference").map(u => u.a.letters.join() + ">" + u.b.letters.join());
  assert.deepEqual(letters(cons), letters(none)); assert.ok(letters(cons).length >= 5);
  assert.equal(items(cons, "punctuation_difference").length, 0); assert.ok(items(none, "punctuation_difference").length >= 3);
  assert.ok(cons.options.rulesApplied.some(r => r.id === "punctuation")); assert.ok(cons.options.keptDistinct.includes("b/v")); assert.equal(cons.summary.certainDifferences, none.summary.certainDifferences);
});
test("damaged transcription vs a different reading: '?' and lacunae are indeterminate; two definite letters are a certain difference", async () => {
  const damaged = await cmp("vāhyābhyantara", "v?hyābhyantara");
  assert.deepEqual(damaged.differences.map(d => d.class), ["indeterminate_due_to_damage"]); assert.equal(damaged.summary.certainDifferences, 0); assert.equal(damaged.summary.indeterminatePositions, 1);
  assert.match(damaged.differences[0].unitDiffs[0].note, /NOT a variant/);
  const different = await cmp("vāhyābhyantara", "bāhyābhyantara");
  assert.deepEqual(different.differences.map(d => d.class), ["certain_difference"]); assert.equal(different.differences[0].unitDiffs[0].possibleAlternation.slice(0, 3), "b~v");
  const gap = await cmp("tathā vyākīrṇamityapi", "tathā [...]mityapi"); assert.deepEqual(gap.differences.map(d => d.class), ["indeterminate_due_to_damage"]); assert.equal(gap.summary.certainDifferences, 0);
  const gap2 = await cmp("tathā vyākīrṇamityapi", "tathā […]mityapi"); assert.deepEqual(gap2.differences.map(d => d.class), ["indeterminate_due_to_damage"]);
  // a damaged character beside a genuine difference: both reported, in separate classes
  const mixed = await cmp("vāhyābhyantara", "b?hyābhyantara"); assert.equal(mixed.summary.certainDifferences, 1); assert.equal(mixed.summary.indeterminatePositions, 1);
});
test("restored [x] and conjectured <x> readings: agreement is recorded, disagreement is 'uncertain', never 'certain'", async () => {
  const agree = await cmp("tathā vyākīrṇamityapi", "tathā vyākī[rṇ]amityapi"); assert.equal(agree.differences.length, 0); assert.equal(agree.uncertainReadings.length, 1); assert.equal(agree.uncertainReadings[0].agreesWithOtherSide, true); assert.equal(agree.summary.identicalUnderRequestedNormalization, true);
  const differ = await cmp("vyākīrṇa", "vyāk[u]rṇa"); assert.deepEqual(differ.differences.map(d => d.class), ["uncertain_difference"]); assert.equal(differ.summary.certainDifferences, 0); assert.equal(differ.uncertainReadings[0].agreesWithOtherSide, false);
  const conj = await cmp("vyākīrṇa", "vyāk<u>rṇa"); assert.deepEqual(conj.differences.map(d => d.class), ["uncertain_difference"]);
  const none = await cmp("vyākīrṇa", "vyāk?rṇa", { uncertainty_markup: "none" }); assert.ok(!none.differences.some(d => d.class === "indeterminate_due_to_damage")); assert.ok(none.summary.certainDifferences >= 1);   // '?' read literally: never "damage"
});
test("Devanāgarī and IAST are compared letter for letter; identical text in two scripts has no differences", async () => {
  for (const [a, b] of [["तथा व्याकीर्णमित्यपि", "tathā vyākīrṇamityapi"], ["वृद्धिरेचि", "vṛddhireci"], ["खड्गं घटः छत्रं ठकारः", "khaḍgaṃ ghaṭaḥ chatraṃ ṭhakāraḥ"], ["क्षत्रिय ज्ञान", "kṣatriya jñāna"]]) { const r = await cmp(a, b); assert.equal(r.differences.length, 0, `${a} / ${b}`); assert.equal(r.summary.identicalOriginals, false); }
  const r = await cmp("राशि", "rāsi"); assert.equal(changes(r)[0].a.letters.join(), "ś"); assert.equal(changes(r)[0].b.letters.join(), "s"); assert.equal(changes(r)[0].possibleAlternation, "ś~s");
});
test("substitutions, omissions and insertions with exact token and letter spans", async () => {
  const r = await cmp("tathā vyākīrṇam ityapi", "tathā ityapi ca");
  assert.deepEqual(r.differences.map(d => [d.type, d.a?.text ?? null, d.b?.text ?? null]), [["omission", "vyākīrṇam", null], ["insertion", null, "ca"]]); assert.deepEqual(r.differences[0].a.tokens.map(t => t.index), [1]);
  const s = await cmp("anulomavilomau ca", "anulomavilomī ca"); assert.deepEqual(s.differences.map(d => d.type), ["substitution"]); const u = s.differences[0].unitDiffs[0]; assert.deepEqual([u.type, u.a.letters, u.b.letters, u.a.start, u.a.end], ["substitution", ["au"], ["ī"], 12, 14]);
  const t = await cmp("a b c d", "a x c y"); assert.deepEqual(t.differences.map(d => d.a.text + ">" + d.b.text), ["b>x", "d>y"]);
});
test("normalization levels: none reports encoding/case; encoding and conservative record the equivalences they apply", async () => {
  const nfd = "r̥gveda", nfc = "ṛgveda";
  assert.deepEqual((await cmp(nfc, nfd)).differences.map(d => d.class), ["encoding_only"]);
  const e = await cmp(nfc, nfd, { normalization: "encoding" }); assert.equal(e.differences.length, 0); assert.equal(e.equivalencesApplied[0].rule, "unicode_canonical"); assert.equal(e.summary.identicalUnderRequestedNormalization, true);
  assert.deepEqual((await cmp("Tantrarāja", "tantrarāja")).differences.map(d => d.class), ["certain_difference"]); assert.equal((await cmp("Tantrarāja", "tantrarāja")).differences[0].unitDiffs[0].possibleAlternation.slice(0, 11), "letter_case");
  const c = await cmp("Tantrarāja", "tantrarāja", { normalization: "conservative" }); assert.equal(c.differences.length, 0); assert.equal(c.equivalencesApplied[0].rule, "letter_case");
  assert.deepEqual((await cmp("vāhya bhyantara", "vāhyabhyantara")).differences.map(d => d.class), ["spacing_only"]); assert.equal((await cmp("vāhya bhyantara", "vāhyabhyantara", { normalization: "conservative" })).equivalencesApplied[0].rule, "spacing");
  assert.equal((await cmp("saṃvara", "saṁvara", { normalization: "encoding" })).differences.length, 0);     // two dot conventions of one letter
  assert.equal((await cmp("a‌b", "ab")).differences.length > 0, true); assert.equal((await cmp("a‌b", "ab", { normalization: "encoding" })).differences.length, 0);
  assert.equal((await cmp("ityapi || 35 ||", "ityapi ॥ ३५ ॥", { normalization: "conservative" })).differences.length, 0);
});
test("conservative normalization NEVER merges distinct letters", async () => {
  for (const [a, b] of [["śiva", "ṣiva"], ["śiva", "siva"], ["bāhya", "vāhya"], ["saṃ", "saṅ"], ["īḷe", "īḻe"], ["ṭa", "ta"], ["kṣa", "kha"], ["ṛ", "ri"], ["kali", "kāli"], ["rāśi", "rāsi"]]) {
    const r = await cmp(a, b, { normalization: "conservative" }); assert.ok(r.summary.certainDifferences >= 1, `${a} vs ${b}`); assert.equal(r.summary.identicalUnderRequestedNormalization, false);
  }
});
test("output is deterministic and independent of call order", async () => {
  const a = await cmp(IAST, OCR), b = await cmp(IAST, OCR); assert.equal(JSON.stringify(a), JSON.stringify(b));
  const x = await cmp("aṣṭādhyāyī vṛddhir eci", "aṣṭādhyāyī vṛddhireci"), y = await cmp("aṣṭādhyāyī vṛddhir eci", "aṣṭādhyāyī vṛddhireci"); assert.equal(JSON.stringify(x), JSON.stringify(y));
});
test("damage signals in the text itself are reported as signals, not as a verdict", async () => {
  const r = await cmp("वाह्य", "ाह्य"); assert.ok(r.evidence.b.unitSignals.some(s => s.kind === "orphan_vowel_sign_or_virama"));
  const m = await cmp("वाह्य", "वाhय"); assert.ok(m.evidence.b.unitSignals.some(s => s.kind === "mixed_script_word"));
  const f = await cmp("abc", "ab�c"); assert.ok(f.evidence.b.unitSignals.some(s => s.kind === "replacement_character"));
  assert.equal(r.resolution, null);
});
test("witness metadata and independence: unknown by default; dependent only when declared; established only by caller evidence; similarity never used", async () => {
  const same = await cmp({ text: "tathā", witness_id: "w1" }, { text: "tathā", witness_id: "w2" }); assert.equal(same.independence.status, "unknown"); assert.equal(same.independence.similarityUsed, false); assert.match(same.independence.caveats[0], /NOT used/);
  const diff = await cmp({ text: "tathā", witness_id: "w1" }, { text: "bathā", witness_id: "w2" }); assert.equal(diff.independence.status, "unknown");
  const dep = await cmp({ text: "tathā", witness_id: "w1" }, { text: "tathā", witness_id: "w2", derived_from: "w1" }); assert.equal(dep.independence.status, "demonstrably_dependent"); assert.ok(dep.independence.basis.some(b => /derives?_from|derived_from/.test(b)));
  const sameId = await cmp({ text: "a", witness_id: "w1" }, { text: "b", witness_id: "w1" }); assert.equal(sameId.independence.status, "demonstrably_dependent");
  const declaredIndep = await cmp({ text: "a" }, { text: "a" }, { declared_relationship: "independent" }); assert.equal(declaredIndep.independence.status, "unknown"); assert.ok(declaredIndep.independence.caveats.some(c => /without supplying independence_evidence/.test(c)));
  const est = await cmp({ text: "a" }, { text: "b" }, { declared_relationship: "independent", independence_evidence: "Different scribes, different regions: see catalogue notes." }); assert.equal(est.independence.status, "established_externally"); assert.ok(est.independence.basis.some(b => /not verified by this tool/.test(b)));
  const derivative = await cmp({ text: "a", witness_type: "electronic_transcription" }, { text: "a", witness_type: "printed_edition" }); assert.equal(derivative.independence.status, "unknown"); assert.ok(derivative.independence.caveats.some(c => /derivative/.test(c)));
});
test("bounds: size limits, empty input, many tokens and one huge unbroken token stay bounded", async () => {
  await assert.rejects(() => cmp("", "a"), RangeError); await assert.rejects(() => cmp("a".repeat(C.MAX_CHARS + 1), "a"), RangeError);
  await assert.rejects(() => cmp(Array.from({ length: C.MAX_TOKENS + 1 }, () => "a").join(" "), "a"), RangeError);
  const t0 = performance.now(); const big = await cmp("ka".repeat(450), "kha".repeat(300)); assert.ok(performance.now() - t0 < 1500); assert.equal(big.differences[0].unitDetail, "skipped_too_large"); assert.match(big.differences[0].note, /Too large/);
  const long = Array.from({ length: 120 }, (_, i) => "pada" + i).join(" "); const lr = await cmp(long, long.replace("pada100", "pbda100")); assert.equal(lr.differences.length, 1); assert.equal(lr.differences[0].a.text, "pada100");
});

const rd = (t, extra = {}) => ({ text: t, ...extra });
test("compare_readings via MCP: full record returned; malformed arguments rejected", async () => {
  const b = toolJson(await callTool("compare_readings", { a: rd(IAST, { witness_type: "electronic_transcription" }), b: rd(OCR, { witness_type: "ocr_derivative", transcription_method: "ocr" }), normalization: "none" }));
  assert.equal(b.status, "ok"); assert.equal(b.evidence.a.original, IAST); assert.equal(b.evidence.b.original, OCR); assert.equal(b.resolution, null); assert.ok(b.summary.certainDifferences >= 5);
  for (const a of [{}, { a: rd("x") }, { a: rd(""), b: rd("x") }, { a: rd("x".repeat(1001)), b: rd("x") }, { a: rd("x", { witness_type: "bogus" }), b: rd("y") }, { a: rd("x", { source_url: "not a url" }), b: rd("y") }, { a: rd("x"), b: rd("y"), normalization: "liberal" }, { a: rd("x"), b: rd("y"), declared_relationship: "maybe" }]) assert.equal((await callTool("compare_readings", a)).body.result.isError, true, JSON.stringify(a).slice(0, 60));
  const tooMany = await callTool("compare_readings", { a: rd(Array.from({ length: 251 }, () => "a").join(" ")), b: rd("a") }); assert.equal(toolJson(tooMany).status, "invalid_input");
});
