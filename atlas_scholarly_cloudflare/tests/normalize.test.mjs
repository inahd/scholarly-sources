import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";
const N = await load("normalize");

test("script detection and conversion: IAST, Devanāgarī, Harvard-Kyoto, ASCII all reach the same strict form", () => {
  for (const q of ["Sūryasiddhānta", "सूर्यसिद्धान्त", "sUryasiddhAnta"]) assert.equal(N.normalizeQuery(q).strict, "sūryasiddhānta", q);
  assert.equal(N.normalizeQuery("तन्त्रराजतन्त्र").strict, "tantrarājatantra");
  assert.equal(N.normalizeQuery("ज्ञान").strict, "jñāna");
  assert.equal(N.normalizeQuery("Tantrarājatantra").script, "iast");
  assert.equal(N.normalizeQuery("Tantrarajatantra").script, "ascii");          // leading capital is not Harvard-Kyoto
  assert.equal(N.normalizeQuery("TantrarAjatantra").script, "harvard_kyoto");  // interior capital is
});
test("distinct letters are never merged in the strict tier", () => {
  const k = N.strictKey;
  assert.notEqual(k("śiva"), k("ṣiva")); assert.notEqual(k("śiva"), k("siva"));
  assert.notEqual(k("īḷe"), k("īḻe")); assert.notEqual(k("ḷa"), k("la"));
  assert.notEqual(k("ṭa"), k("ta")); assert.notEqual(k("sūtra"), k("sutra"));
});
test("encoding-only variants of the SAME letter are equivalent", () => {
  assert.equal(N.strictKey("saṃvara"), N.strictKey("saṁvara"));                 // two anusvāra dot conventions
  assert.equal(N.strictKey("r̥gveda"), N.strictKey("ṛgveda"));            // r + ring below
  assert.equal(N.strictKey("ā"), N.strictKey("ā"));                      // NFD vs NFC
});
test("folded tier is lossy and says so; ASCII input yields labelled spelling variants and both ś and ṣ for sh", () => {
  const n = N.normalizeQuery("Krishna");
  assert.ok(n.foldedKeys.includes("krsna") && n.foldedKeys.includes("krishna"));
  assert.ok(n.variants.filter(v => v.kind === "ascii_spelling_variant").every(v => v.lossy));
  const forms = n.variants.filter(v => v.kind === "ascii_digraph_expansion").map(v => v.form);
  assert.ok(forms.includes("krishna".replace("sh", "ś")) && forms.includes("krishna".replace("sh", "ṣ")));
  assert.ok(n.warnings.some(w => /ASCII cannot distinguish/.test(w)));
});
test("submitted text is always returned; Devanāgarī accents and unmapped marks are reported", () => {
  const n = N.normalizeQuery("अ॒ग्निम्"); assert.equal(n.submitted, "अ॒ग्निम्"); assert.equal(n.strict, "agnim"); assert.ok(n.warnings.some(w => /accent/i.test(w)));
});
test("multi-part queries: base/commentary roles in both word orders; glue words dropped", () => {
  const a = N.splitQuery("Tantrarājatantra with Manoramā"); assert.deepEqual(a.parts.map(p => [p.role, p.text]), [["base", "Tantrarājatantra"], ["commentary", "Manoramā"]]);
  const b = N.splitQuery("Manoramā commentary on Tantrarājatantra"); assert.deepEqual(b.parts.map(p => [p.role, p.text]), [["base", "Tantrarājatantra"], ["commentary", "Manoramā"]]);
  const c = N.splitQuery("Vedāṅga Jyotiṣa"); assert.equal(c.parts.length, 1); assert.deepEqual(c.parts[0].words, ["vedanga", "jyotisa"]);
});
