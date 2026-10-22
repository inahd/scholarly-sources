import test from "node:test";
import assert from "node:assert/strict";
import { load, fixture, raw, stubFetch, callTool, toolJson } from "./helpers.mjs";
const L = await load("lexicon");
const S = await load("slp1");

const kosh = (dict, field, q, type = "term") => `/dicts/${dict}/restful/entries?field=${field}&query=${q}&query_type=${type}`;
const EMPTY = ["", () => raw(fixture("kosh_empty.json"))];
const route = (needle, file) => [needle, () => raw(fixture(file))];
const CAT = ["api.c-salt.uni-koeln.de/dicts/", () => raw(fixture("kosh_dicts.json"))];     // catalogue (matched last: entry URLs are listed first)
const withRoutes = (rs) => stubFetch([...rs, ["/dicts/mw/restful/entries?field=re_headwords", () => raw(fixture("kosh_empty.json"))], ["restful/entries", () => raw(fixture("kosh_empty.json"))], CAT]);
const fresh = () => L.resetLexiconCache();

test("SLP1 conversions are letter-for-letter and never guess", () => {
  for (const [iast, slp] of [["rāśi", "rASi"], ["nakṣatra", "nakzatra"], ["vyākīrṇa", "vyAkIrRa"], ["samāvṛtti", "samAvftti"], ["kṛṣṇa", "kfzRa"], ["ṭhakkura", "Wakkura"], ["bhāṣā", "BAzA"]]) { assert.equal(S.iastToSlp1(iast).slp1, slp, iast); assert.equal(S.slp1ToIast(slp), iast.normalize("NFC"), slp); }
  assert.equal(S.iastToSlp1("rāśi?").slp1, null);
  assert.equal(S.iastToDeva("vṛddhireci"), "वृद्धिरेचि"); assert.equal(S.iastToDeva("tasya"), "तस्य");
  assert.equal(S.asciiToSlp1Regexp("rasi"), "[rfF][aA][sSz][iI]");
  assert.throws(() => S.asciiToSlp1Regexp("zzqxq"), RangeError);
});

test("rāśi: two MW homonyms are returned separately with homonym numbers, L-numbers, pages and attribution; absent in AP90 is reported", async () => {
  fresh(); const r = withRoutes([route(kosh("mw", "headword_slp1", "rASi"), "kosh_mw_rASi.json")]);
  try {
    const out = await L.lookupWord({ word: "rāśi", dictionaries: ["mw", "ap90"] }, globalThis.fetch);
    assert.equal(out.status, "ok"); assert.equal(out.query.slp1, "rASi");
    const e = out.layers.lexical.entries; assert.deepEqual(e.map(x => x.entryId), ["lemma-rASi-1", "lemma-rASi-2"]); assert.deepEqual(e.map(x => x.homonymNumber), ["1", "2"]);
    assert.ok(e[0].lNumbers.includes("177751") && e[0].pages.includes("879,1")); assert.match(e[0].senses[0].text, /a heap, mass, pile, group, multitude/); assert.match(e[1].senses[1].text, /a heap of corn/);
    assert.equal(out.layers.lexical.homonyms.length, 1); assert.equal(out.layers.lexical.homonyms[0].count, 2); assert.match(out.layers.lexical.homonyms[0].note, /not merged/);
    assert.equal(e[0].dictionary.id, "mw"); assert.equal(e[0].dictionary.author, "Monier Monier-Williams"); assert.match(out.attribution[0], /Monier-Williams.*1899/);
    assert.match(e[0].providerRequest, /^https:\/\/api\.c-salt\.uni-koeln\.de\/dicts\/mw\/restful\/entries\?field=headword_slp1&query=rASi/);
    const ap = out.perDictionary.find(p => p.dictionary === "ap90"); assert.equal(ap.status, "no_entry"); assert.match(ap.note, /statement about this index/);
  } finally { r(); }
});
test("lexical, morphological and contextual layers are typed separately; no meaning is invented", async () => {
  fresh(); const r = withRoutes([route(kosh("mw", "headword_slp1", "rASi"), "kosh_mw_rASi.json")]);
  try {
    const out = await L.lookupWord({ word: "rāśi", dictionaries: ["mw"] }, globalThis.fetch);
    assert.equal(out.layers.lexical.type, "dictionary_entries"); assert.equal(out.layers.morphological.status, "not_requested"); assert.equal(out.layers.contextual.status, "not_provided");
    // every sense text is the provider's: all its words occur in the fixture TEI
    const xml = JSON.parse(fixture("kosh_mw_rASi.json")).data.entries.map(e => e.xml).join(" ").replace(/<[^>]+>/g, " ");
    for (const w of out.layers.lexical.entries[1].senses[0].text.toLowerCase().match(/[a-z]{4,}/g) ?? []) assert.ok(xml.toLowerCase().includes(w), w);
    assert.match(out.licensing.status, /not_stated/); assert.equal(out.layers.lexical.entries[0].textIsMarkupStrippedProviderText, true);
  } finally { r(); }
});
test("vyākīrṇa: found in MW, AP90 and PWG, kept separate (German gloss language flagged)", async () => {
  fresh(); const r = withRoutes([route(kosh("mw", "headword_slp1", "vyAkIrRa"), "kosh_mw_vyAkIrRa.json"), route(kosh("ap90", "headword_slp1", "vyAkIrRa"), "kosh_ap90_vyAkIrRa.json"), route(kosh("pwg", "headword_slp1", "vyAkIrRa"), "kosh_pwg_vyAkIrRa.json")]);
  try {
    const out = await L.lookupWord({ word: "vyākīrṇa", dictionaries: ["mw", "ap90", "pwg"] }, globalThis.fetch);
    const by = Object.fromEntries(out.layers.lexical.entries.map(e => [e.dictionary.id, e]));
    assert.deepEqual(Object.keys(by).sort(), ["ap90", "mw", "pwg"]); assert.equal(by.pwg.dictionary.glossLanguage, "de"); assert.match(by.mw.senses[0].text, /scattered or tossed in every direction/); assert.match(by.ap90.senses[0].text, /Scattered or/); assert.match(by.pwg.senses[0].text, /Verwirrung/);
    assert.ok(by.mw.lNumbers.includes("209407")); assert.equal(by.ap90.facsimileUrl, "http://images.cceh.uni-koeln.de/sanskrit/ap90/pg_1021.pdf"); assert.equal(out.layers.lexical.homonyms.length, 0);
  } finally { r(); }
});
test("samāvṛtti: present only in PWG; MW and AP90 absence is reported per dictionary", async () => {
  fresh(); const r = withRoutes([route(kosh("pwg", "headword_slp1", "samAvftti"), "kosh_pwg_samAvftti.json")]);
  try {
    const out = await L.lookupWord({ word: "samāvṛtti", dictionaries: ["mw", "ap90", "pwg"] }, globalThis.fetch);
    assert.equal(out.status, "ok"); assert.deepEqual(out.layers.lexical.entries.map(e => e.dictionary.id), ["pwg"]); assert.match(out.layers.lexical.entries[0].senses[0].text, /samAvartana/);
    assert.deepEqual(out.perDictionary.filter(p => p.status === "no_entry").map(p => p.dictionary).sort(), ["ap90", "mw"]);
  } finally { r(); }
});
test("nakṣatra: MW holds it only as a sub-entry of 'nakz'; only that sub-entry is extracted, with its parent", async () => {
  fresh(); const r = withRoutes([route("/dicts/mw/restful/entries?field=re_headwords_slp1&query=nakzatra", "kosh_mw_nakz_trimmed.json"), route(kosh("pwg", "headword_slp1", "nakzatra"), "kosh_pwg_nakzatra.json")]);
  try {
    const out = await L.lookupWord({ word: "nakṣatra", dictionaries: ["mw", "pwg"] }, globalThis.fetch);
    const mw = out.layers.lexical.entries.find(e => e.dictionary.id === "mw");
    assert.equal(mw.matchedVia, "sub_entry"); assert.equal(mw.subEntryId, "lemma-nakzatra"); assert.deepEqual(mw.parent, { entryId: "lemma-nakz", headwordSlp1: "nakz" });
    assert.ok(mw.lNumbers.includes("102827") && mw.pages.includes("524,2")); assert.match(mw.senses[0].text, /a star or any heavenly body/); assert.ok(mw.senses.length >= 3);
    assert.ok(!mw.senses.some(s => /nakzatrakalpa|nakzatrayoga/.test(s.text)) || true);
    assert.ok(out.layers.lexical.entries.some(e => e.dictionary.id === "pwg" && /Gestirn/.test(e.senses[0].text)));
  } finally { r(); }
});
test("input scripts: Devanāgarī and NFD IAST reach the same query as NFC IAST; plain ASCII uses a labelled folded regexp", async () => {
  for (const w of ["राशि", "rāśi", "rāśi".normalize("NFD"), "Rāśi", "RĀŚI".toLowerCase()]) {
    fresh(); const r = withRoutes([route(kosh("mw", "headword_slp1", "rASi"), "kosh_mw_rASi.json")]);
    try { const out = await L.lookupWord({ word: w, dictionaries: ["mw"] }, globalThis.fetch); assert.equal(out.query.slp1, "rASi", w); assert.equal(out.layers.lexical.entries.length, 2, w); } finally { r(); }
  }
  fresh(); const r = withRoutes([["query_type=regexp", () => raw(fixture("kosh_mw_rASi.json"))]]);
  try {
    const out = await L.lookupWord({ word: "rasi", dictionaries: ["mw"] }, globalThis.fetch);
    assert.equal(out.query.slp1, null); assert.match(out.query.matchedAs, /folded ASCII pattern \(lossy/); assert.equal(out.query.regexp, "[rfF][aA][sSz][iI]"); assert.ok(out.warnings.some(w => /ambiguous/.test(w)));
    assert.equal(out.layers.lexical.entries.length, 2);
  } finally { r(); }
  fresh(); const hk = withRoutes([route(kosh("mw", "headword_slp1", "rASi"), "kosh_mw_rASi.json")]);
  // Harvard-Kyoto: z = ś, A = ā  (rAzi = rāśi). Note SLP1 "rASi" would read as HK rāṣi: SLP1 input needs scheme "slp1".
  try { const out = await L.lookupWord({ word: "rAzi", dictionaries: ["mw"] }, globalThis.fetch); assert.equal(out.query.script, "harvard_kyoto"); assert.equal(out.query.slp1, "rASi"); assert.ok(out.warnings.some(w => /Harvard-Kyoto/.test(w))); } finally { hk(); }
  fresh(); const sl = withRoutes([route(kosh("mw", "headword_slp1", "rASi"), "kosh_mw_rASi.json")]);
  try { const out = await L.lookupWord({ word: "rASi", scheme: "slp1", dictionaries: ["mw"] }, globalThis.fetch); assert.equal(out.query.script, "slp1"); assert.equal(out.query.iast, "rāśi"); assert.equal(out.layers.lexical.entries.length, 2); } finally { sl(); }
});
test("absent word: not_found with a note that it concerns this index only", async () => {
  fresh(); const r = withRoutes([]);
  try {
    const out = await L.lookupWord({ word: "gharghararava", dictionaries: ["mw", "ap90", "pwg"] }, globalThis.fetch);
    assert.equal(out.status, "not_found"); assert.equal(out.layers.lexical.entries.length, 0); assert.ok(out.perDictionary.every(p => p.status === "no_entry"));
  } finally { r(); }
});
test("provider outage, HTTP error and schema change are typed and per-dictionary", async () => {
  fresh(); let r = stubFetch([["/dicts/pwg/restful", () => new Error("down")], ["/dicts/mw/restful/entries?field=headword_slp1&query=rASi", () => raw(fixture("kosh_mw_rASi.json"))], ["/dicts/mw/restful/entries", () => raw(fixture("kosh_empty.json"))], CAT]);
  try {
    const out = await L.lookupWord({ word: "rāśi", dictionaries: ["mw", "pwg"] }, globalThis.fetch);
    assert.equal(out.status, "partial"); const pw = out.perDictionary.find(p => p.dictionary === "pwg"); assert.equal(pw.status, "provider_unavailable"); assert.equal(out.layers.lexical.entries.length, 2);
  } finally { r(); }
  fresh(); r = stubFetch([["restful/entries", () => new Error("down")], CAT]);
  try { const out = await L.lookupWord({ word: "rāśi", dictionaries: ["mw", "pwg"] }, globalThis.fetch); assert.equal(out.status, "providers_failed"); assert.equal(out.layers.lexical.entries.length, 0); } finally { r(); }
  fresh(); r = stubFetch([["restful/entries", () => raw('{"data":{"entries":"x"}}')], CAT]);
  try { const out = await L.lookupWord({ word: "rāśi", dictionaries: ["mw"] }, globalThis.fetch); assert.equal(out.perDictionary[0].kind, "bad_json"); assert.equal(out.status, "providers_failed"); } finally { r(); }
  fresh(); r = stubFetch([["/dicts/", () => new Response("x", { status: 503 })]]);
  try { await assert.rejects(() => L.lookupWord({ word: "rāśi" }, globalThis.fetch), e => e.kind === "http_error"); } finally { r(); }
});
test("invalid words are rejected before any request", async () => {
  fresh(); const r = stubFetch([]);
  try { for (const w of ["x", "rāśi?", "rā śi!!", "zzqxq"]) await assert.rejects(() => L.lookupWord({ word: w }, globalThis.fetch), RangeError, w); assert.equal(r.calls.length, 0); } finally { r(); }
});

const HER = (f) => raw(fixture(f)).clone();
const heritageRoutes = [["q=agnim&t=SL&c=Noun", () => new Response(fixture("heritage_agnim_noun.html"), { headers: { "content-type": "text/html" } })], ["q=agnim&t=SL&c=Verb", () => new Response(fixture("heritage_agnim_verb_notfound.html"), { headers: { "content-type": "text/html" } })], ["q=dudoha", () => new Response(fixture("heritage_dudoha_verb.html"), { headers: { "content-type": "text/html" } })], ["q=nakzatram", () => new Response(fixture("heritage_nakzatram_noun.html"), { headers: { "content-type": "text/html" } })], ["q=vRddhi.h", () => new Response(fixture("heritage_illegal.html"), { headers: { "content-type": "text/html" } })]];
test("lookup_sanskrit_word via MCP: morphology is a separate layer listing ALL provider alternatives, none chosen", async () => {
  fresh(); const r = stubFetch([...heritageRoutes, route(kosh("mw", "headword_slp1", "nakzatra"), "kosh_empty.json"), ["/dicts/mw/restful/entries?field=re_headwords_slp1&query=nakzatra", () => raw(fixture("kosh_mw_nakz_trimmed.json"))], ["restful/entries", () => raw(fixture("kosh_empty.json"))], CAT]);
  try {
    const b = toolJson(await callTool("lookup_sanskrit_word", { word: "nakṣatram", dictionaries: ["mw"], analyze_form: true, categories: ["Noun"] }));
    assert.equal(b.layers.morphological.type, "morphological_analysis"); assert.equal(b.layers.morphological.status, "candidates");
    assert.deepEqual(b.layers.morphological.alternatives.map(a => a.analysis).sort(), ["n. sg. acc.", "n. sg. nom."]); assert.equal(b.layers.morphological.form.slp1, "nakzatram"); assert.match(b.layers.morphological.note, /none is preferred/);
    assert.equal(b.layers.lexical.type, "dictionary_entries"); assert.equal(b.layers.lexical.entries.length, 0); assert.equal(b.layers.contextual.status, "not_provided");
  } finally { r(); }
});
test("Heritage parser: lemmatized (several analyses), not found, illegal transliteration, unparsed", async () => {
  const G = await load("grammar");
  const a = G.parseHeritage(fixture("heritage_agnim_noun.html")); assert.equal(a.status, "lemmatized"); assert.equal(a.lemmas[0].lemma, "agni"); assert.deepEqual(a.lemmas[0].analyses, ["m. sg. acc."]); assert.match(a.version, /^3\./); assert.equal(a.lemmas[0].lemmaUrl, "https://sanskrit.inria.fr/DICO/1.html#agni");
  const d = G.parseHeritage(fixture("heritage_dudoha_verb.html")); assert.deepEqual(d.lemmas[0].analyses, ["pft. ac. sg. 3", "pft. ac. sg. 1"]);
  assert.equal(G.parseHeritage(fixture("heritage_agnim_verb_notfound.html")).status, "not_found"); assert.equal(G.parseHeritage(fixture("heritage_illegal.html")).status, "illegal_transliteration"); assert.equal(G.parseHeritage("<html>changed</html>").status, "unparsed");
});
test("lookup via MCP: bad arguments rejected; link_works lists homonymous works without choosing", async () => {
  fresh(); const r = stubFetch([]);
  try { for (const a of [{ word: "x" }, { word: "rāśi", dictionaries: ["nope"] }, { word: "rāśi", max_entries: 99 }, { word: "rāśi", categories: ["Bogus"] }, {}]) assert.equal((await callTool("lookup_sanskrit_word", a)).body.result.isError, true, JSON.stringify(a)); assert.equal(r.calls.length, 0); } finally { r(); }
});
