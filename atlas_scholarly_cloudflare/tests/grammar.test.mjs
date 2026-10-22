import test from "node:test";
import assert from "node:assert/strict";
import { load, fixture, raw, json, stubFetch, callTool, toolJson } from "./helpers.mjs";
const G = await load("grammar");
const P = await load("pandit");
const T = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const rules = (extra = []) => [...extra, ["data/sutrANi.tsv", () => T(fixture("sutrANi_sample.tsv"))], ["padachcheda/pada-6.1/6.1.88", () => T(fixture("sutra_6.1.88_padachcheda.txt"))], ["anuvritti/pada-6.1/6.1.88", () => T(fixture("sutra_6.1.88_anuvritti.txt"))], ["adhikara/pada-6.1/6.1.88", () => T(fixture("sutra_6.1.88_adhikara.txt"))], ["full_sutra/pada-6.1/6.1.88", () => T(fixture("sutra_6.1.88_full_sutra.txt"))],
  ["padachcheda/pada-1.1/1.1.3", () => T(fixture("sutra_1.1.3_padachcheda.txt"))], ["anuvritti/pada-1.1/1.1.3", () => T(fixture("sutra_1.1.3_anuvritti.txt"))], ["adhikara/pada-1.1/1.1.3", () => T("", 404)], ["full_sutra/pada-1.1/1.1.3", () => T(fixture("sutra_1.1.3_full_sutra.txt"))]];
const fresh = () => { G.resetGrammarCache(); P.resetPanditCache(); };

test("Pāṇini 6.1.88 vṛddhir eci: number, Devanāgarī numerals, IAST text and Devanāgarī text all find the same rule", async () => {
  for (const q of ["6.1.88", "६.१.८८", "6 1 88", "vṛddhir eci", "वृद्धिरेचि", "VṚDDHIR ECI".toLowerCase()]) {
    fresh(); const r = stubFetch(rules());
    try {
      const out = await G.findRule({ rule: q, link_works: false }, globalThis.fetch);
      assert.equal(out.status, "ok", q); assert.equal(out.rule.id, "6.1.88", q); assert.equal(out.rule.sutra, "वृद्धिरेचि", q);
      assert.equal(out.rule.matchBasis, /[\d०-९]/.test(q) ? "exact_sutra_number" : "exact_sutra_text", q);
    } finally { r(); }
  }
});
test("6.1.88: rule, source locator, structure (padaccheda, anuvṛtti, adhikāra), related rules and provenance — all from the source files", async () => {
  fresh(); const r = stubFetch(rules());
  try {
    const o = await G.findRule({ rule: "6.1.88", link_works: false }, globalThis.fetch);
    assert.deepEqual(o.rule.sourceLocator, { repository: "https://github.com/sanskrit/ashtadhyayi", tableUrl: "https://raw.githubusercontent.com/sanskrit/ashtadhyayi/master/data/sutrANi.tsv", row: "6.1.88" });
    const e = o.explanation;
    assert.equal(e.padaccheda.raw, "वृद्धिः १/१ एचि ७/१"); assert.deepEqual(e.padaccheda.parsed, [{ pada: "वृद्धिः", caseNumber: "1/1" }, { pada: "एचि", caseNumber: "7/1" }]);
    assert.deepEqual(e.anuvritti.parsed, [{ word: "आत्", caseNumber: "5/1", fromSutra: "6.1.87" }]);
    assert.deepEqual(e.adhikara.parsed.map(x => [x.adhikara, x.fromSutra]), [["संहितायाम्", "6.1.71"], ["एकः पूर्वपरयोः", "6.1.84"]]);
    assert.deepEqual(e.relatedRules.map(x => [x.ref, x.sutra]).sort(), [["6.1.71", "ह्रस्वस्य पिति कृति तुक्"], ["6.1.84", "एकः पूर्वपरयोः"], ["6.1.87", "आद्गुणः"]]);
    assert.equal(e.completedReading.raw, "आत् एचि पूर्वपरयोः एकः वृद्धि"); assert.match(e.note, /not Pāṇini's wording/);
    assert.equal(o.commentaries.status, "linked_not_retrieved"); assert.equal(o.commentaries.page, "https://ashtadhyayi.com/sutraani/6/1/88");
    assert.match(o.licensing.status, /not_stated/); assert.match(o.retrievedAt, /^\d{4}-/); assert.equal(e.padaccheda.url, "https://raw.githubusercontent.com/sanskrit/ashtadhyayi/master/padachcheda/pada-6.1/6.1.88.txt");
  } finally { r(); }
});
test("raw source strings are preserved byte-for-byte next to every parse", async () => {
  fresh(); const r = stubFetch(rules());
  try { const o = await G.findRule({ rule: "1.1.3", link_works: false }, globalThis.fetch); const e = o.explanation;
    assert.equal(e.anuvritti.raw, fixture("sutra_1.1.3_anuvritti.txt").replace(/\s+$/, "")); assert.equal(e.anuvritti.parsed.length, 2); assert.equal(e.adhikara.status, "not_provided_for_this_sutra"); assert.equal(e.adhikara.raw, null);
  } finally { r(); }
});
test("a repeated sūtra text is reported as ambiguous and none is chosen", async () => {
  fresh(); const r = stubFetch(rules());
  try { const o = await G.findRule({ rule: "अव्ययीभावश्च", link_works: false }, globalThis.fetch); assert.equal(o.status, "ambiguous"); assert.deepEqual(o.candidates.map(c => c.ref).sort(), ["1.1.41", "2.4.18"]); assert.equal(o.rule, undefined); } finally { r(); }
});
test("absent rule, bad numbers, partial text and ASCII reading are explicit", async () => {
  fresh(); const r = stubFetch(rules());
  try {
    assert.equal((await G.findRule({ rule: "9.9.9", link_works: false }, globalThis.fetch)).status, "not_found");
    assert.equal((await G.findRule({ rule: "6.1.999", link_works: false }, globalThis.fetch)).status, "not_found");
    const ascii = await G.findRule({ rule: "tasya", link_works: false }, globalThis.fetch); assert.equal(ascii.status, "not_found"); assert.ok(ascii.query.warnings.some(w => /read literally as IAST/.test(w)));
    const part = await G.findRule({ rule: "guṇavṛddh", link_works: false }, globalThis.fetch); assert.ok(["partial_matches_only", "not_found"].includes(part.status)); assert.equal(part.rule, undefined);
    await assert.rejects(() => G.findRule({ rule: "!!!", link_works: false }, globalThis.fetch), RangeError);
  } finally { r(); }
});
test("missing per-sūtra files are 'not_provided', never filled in; outages and format changes are typed", async () => {
  fresh(); let r = stubFetch(rules([["anuvritti/pada-6.1/6.1.88", () => T("", 404)]]));
  try { const o = await G.findRule({ rule: "6.1.88", link_works: false }, globalThis.fetch); assert.equal(o.explanation.anuvritti.status, "not_provided_for_this_sutra"); assert.deepEqual(o.explanation.anuvritti.parsed, []); assert.equal(o.explanation.padaccheda.status, "retrieved"); } finally { r(); }
  fresh(); r = stubFetch([["data/sutrANi.tsv", () => new Error("down")]]);
  try { await assert.rejects(() => G.findRule({ rule: "6.1.88" }, globalThis.fetch), e => e.kind === "unavailable"); } finally { r(); }
  fresh(); r = stubFetch([["data/sutrANi.tsv", () => T("<html>moved</html>")]]);
  try { await assert.rejects(() => G.findRule({ rule: "6.1.88" }, globalThis.fetch), e => e.kind === "bad_json"); } finally { r(); }
  fresh(); r = stubFetch(rules([["anuvritti/pada-6.1/6.1.88", () => new Response("x", { status: 500 })]]));
  try { const o = await G.findRule({ rule: "6.1.88", link_works: false }, globalThis.fetch); assert.equal(o.explanation.anuvritti.status, "provider_error"); assert.equal(o.status, "ok"); } finally { r(); }
});
test("find_grammar_rule via MCP links the Aṣṭādhyāyī work in Pandit and its SETI e-texts (title match only)", async () => {
  fresh(); const r = stubFetch(rules([["entities/works", () => raw(fixture("works_sample.json"))], ["seti/by_work", () => raw(fixture("seti_41541.json"))], ["entities/labels", () => raw(fixture("labels_41541.json"))]]));
  try {
    const b = toolJson(await callTool("find_grammar_rule", { rule: "६.१.८८" }));
    assert.equal(b.rule.id, "6.1.88"); assert.equal(b.linkedWork.status, "ok"); assert.equal(b.linkedWork.work.panditWorkId, "41541"); assert.equal(b.linkedWork.work.providerUrl, "https://www.panditproject.org/node/41541");
    assert.ok(b.linkedWork.setiLinks.length >= 1 && b.linkedWork.setiLinks.every(l => /^https?:\/\//.test(l.url))); assert.match(b.linkedWork.note, /not independent manuscript witnesses/);
  } finally { r(); }
  fresh(); const bad = stubFetch(rules([["entities/works", () => new Error("down")]]));
  try { const b = toolJson(await callTool("find_grammar_rule", { rule: "6.1.88" })); assert.equal(b.status, "ok"); assert.equal(b.linkedWork.status, "provider_error"); } finally { bad(); }
  for (const a of [{ rule: "x" }, {}, { rule: "6.1.88", link_works: "yes" }]) assert.equal((await callTool("find_grammar_rule", a)).body.result.isError, true);
});
