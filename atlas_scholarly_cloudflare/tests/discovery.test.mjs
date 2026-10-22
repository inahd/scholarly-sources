import test from "node:test";
import assert from "node:assert/strict";
import { load, fixture, raw, json, stubFetch, callTool, toolJson } from "./helpers.mjs";
const P = await load("pandit");
const V = await load("vedaweb");
const A = await load("archive");
const NN = await load("normalize");
/** Build QueryParts with the real splitter. */
const N_part = (a, b) => NN.splitQuery(`${a} with ${b}`).parts;

const WORKS = fixture("works_sample.json");
const worksRoute = ["entities/works", () => raw(WORKS)];
const fresh = () => { P.resetPanditCache(); V.resetVedawebCache(); };

test("label grammar: dates vs alternative titles vs nested brackets (real Pandit labels)", () => {
  const a = P.parseLabel("96325", "Vāmakeśvarīmata (96325) [Nityāṣodaśikārṇava]"); assert.deepEqual(a.alternativeTitles, ["Nityāṣodaśikārṇava"]); assert.deepEqual(a.annotations, []);
  const b = P.parseLabel("105492", "Jyotiṣavedāṅga - Yajurvedīya (105492) [-400 (author)] [Yajurvedīyajyotiṣavedāṅga]"); assert.deepEqual(b.annotations, ["-400 (author)"]); assert.deepEqual(b.alternativeTitles, ["Yajurvedīyajyotiṣavedāṅga"]);
  const c = P.parseLabel("106207", "Jyotiṣagrantha (106207) [[Jyotiṣagrantha]]"); assert.deepEqual(c.alternativeTitles, ["Jyotiṣagrantha"]);
  const d = P.parseLabel("106012", "Sūryasiddhānta(udāharaṇa) (106012)"); assert.equal(d.title, "Sūryasiddhānta(udāharaṇa)");
  assert.equal(P.parseLabel("1", "Title (2)"), null);
});
test("find_work: exact title is top and high confidence; related titles ranked lower with their basis", async () => {
  fresh(); const r = stubFetch([worksRoute]);
  try {
    const out = await P.findWorks("Sūryasiddhānta", {}, globalThis.fetch);
    assert.equal(out.candidates[0].panditWorkId, "106098"); assert.equal(out.candidates[0].confidence, "high"); assert.equal(out.candidates[0].matchBasis[0].basis, "exact_iast");
    assert.deepEqual(out.candidates.slice(1).map(c => c.panditWorkId).sort(), ["106012", "107082"]);
    assert.ok(out.candidates.slice(1).every(c => c.score < out.candidates[0].score && c.confidence !== "high"));
    assert.equal(out.candidates[0].providerUrl, "https://www.panditproject.org/node/106098");
    assert.match(out.candidates[0].providerRecord.label, /^Sūryasiddhānta \(106098\)$/);
  } finally { r(); }
});
test("find_work: Devanāgarī, Harvard-Kyoto and ASCII queries find the same work; ASCII is marked lossy/lower", async () => {
  for (const [q, lossy] of [["सूर्यसिद्धान्त", false], ["sUryasiddhAnta", false], ["Suryasiddhanta", true]]) {
    fresh(); const r = stubFetch([worksRoute]);
    try { const out = await P.findWorks(q, {}, globalThis.fetch); assert.equal(out.candidates[0].panditWorkId, "106098", q); assert.equal(out.candidates[0].matchBasis[0].lossy, lossy, q); if (lossy) assert.ok(out.candidates[0].score < 1); } finally { r(); }
  }
});
test("find_work: homonymous titles are all returned and flagged, never merged", async () => {
  fresh(); const r = stubFetch([worksRoute]);
  try {
    const out = await P.findWorks("Manoramā", {}, globalThis.fetch);
    const exact = out.candidates.filter(c => c.matchBasis[0].basis === "exact_iast");
    assert.deepEqual(exact.map(c => c.panditWorkId).sort(), ["109924", "111306", "114652"]);
    assert.ok(exact.every(c => c.ambiguousWith.length === 2));
    assert.equal(out.ambiguity.kind, "homonymous_titles");
  } finally { r(); }
});
test("find_work: word-order difference (Vedāṅga Jyotiṣa vs Jyotiṣavedāṅga) is found with an explicit weaker basis", async () => {
  fresh(); const r = stubFetch([worksRoute]);
  try {
    const out = await P.findWorks("Vedāṅga Jyotiṣa", {}, globalThis.fetch);
    assert.ok(out.candidates.length >= 1); assert.ok(out.candidates.every(c => c.matchBasis[0].basis === "all_words_any_order" && c.confidence === "medium"));
  } finally { r(); }
});
test("find_work: absent base title returns no candidates and counts commentary-name-only matches without listing them", async () => {
  fresh(); const r = stubFetch([worksRoute]);
  try {
    const out = await P.findWorks("Tantrarājatantra with Manoramā", {}, globalThis.fetch);
    assert.equal(out.status, "no_candidates"); assert.deepEqual(out.candidates, []); assert.ok(out.commentaryNameOnlyMatches >= 3); assert.match(out.note, /not evidence/);
    assert.equal((await P.findWorks("Zzqx", {}, globalThis.fetch)).status, "no_candidates");
  } finally { r(); }
});
test("find_work: diacritic mismatch (ṣ for s) is reported as equal-after-folding, a distinct basis", async () => {
  fresh(); const r = stubFetch([worksRoute]);
  try { const out = await P.findWorks("Nityaṣoḍaśikārṇava", {}, globalThis.fetch); assert.equal(out.candidates[0].panditWorkId, "96325"); assert.equal(out.candidates[0].matchBasis[0].basis, "equal_after_folding_but_diacritics_differ"); assert.equal(out.candidates[0].matchBasis[0].matchedOn, "alternative_title"); } finally { r(); }
});
test("works list: cached within the isolate; outage, HTTP error and schema change are typed errors", async () => {
  fresh(); let n = 0; let r = stubFetch([["entities/works", () => (n++, raw(WORKS))]]);
  try { await P.findWorks("Sūryasiddhānta", {}, globalThis.fetch); await P.findWorks("Manoramā", {}, globalThis.fetch); assert.equal(n, 1); } finally { r(); }
  for (const [make, kind] of [[() => new Error("down"), "unavailable"], [() => new Response("x", { status: 503 }), "http_error"], [() => raw('{"not":"a list"}'), "bad_json"], [() => raw('[{"id":1,"name":"x"}]'), "bad_json"]]) {
    fresh(); r = stubFetch([["entities/works", make]]);
    try { await assert.rejects(() => P.findWorks("Sūryasiddhānta", {}, globalThis.fetch), e => e.kind === kind, kind); } finally { r(); }
  }
});
test("relations: author and commentary edges from the real subgraph shape; relationship strings preserved", async () => {
  const r = stubFetch([["graph/subgraph", () => raw(fixture("subgraph_42451.json"))]]);
  try {
    const out = await P.workRelations("42451", globalThis.fetch);
    assert.equal(out.work.label, "Prauḍhamanoramā"); assert.deepEqual(out.authors.map(a => a.label), ["Bhaṭṭoji Dīkṣita"]);
    assert.deepEqual(out.commentaries.map(c => c.id).sort(), ["41751", "42452", "42453"]); assert.deepEqual(out.baseTexts.map(c => c.id), ["42434"]);
    assert.ok(out.relationshipsSeen.includes("source base text inspired target commentary"));
  } finally { r(); }
  const bad = stubFetch([["graph/subgraph", () => raw('{"graph":{"nodes":"x"}}')]]);
  try { await assert.rejects(() => P.workRelations("1", globalThis.fetch), e => e.kind === "bad_json"); } finally { bad(); }
});

test("Internet Archive: query clauses, result mapping from the real response, no assertion about edition role", async () => {
  const q = N_part("Tantrarājatantra", "Manoramā");
  const r = stubFetch([["archive.org/advancedsearch", () => raw(fixture("ia_tantraraja.json"))]]);
  try {
    const out = await A.searchArchive(q[0], q[1], 4, globalThis.fetch);
    assert.equal(out.status, "ok"); assert.ok(out.titleClauses.includes("tantraraja tantra"));
    assert.ok(out.items.some(i => /tantraraja-tantra-part-ii/.test(i.identifier)));
    assert.ok(out.items.every(i => i.detailsUrl.startsWith("https://archive.org/details/")));
    assert.match(out.note, /not stated by the provider/);
  } finally { r(); }
  const bad = stubFetch([["archive.org", () => raw('{"response":{"docs":"x"}}')]]);
  try { await assert.rejects(() => A.searchArchive(q[0], undefined, 4, globalThis.fetch), e => e.kind === "bad_json"); } finally { bad(); }
});

const VW = [["vedaweb.uni-koeln.de/api/texts", () => raw(fixture("vw_texts.json"))], ["/api/locations", () => raw(fixture("vw_loc.json"))], ["/api/resources", () => raw(fixture("vw_resources.json"))], ["/api/contents", () => raw(fixture("vw_contents.json"))]];
test("read_passage: RV 1.1.1 from real VedaWeb data keeps exact text, locator, encoding, citation, provenance and licence status", async () => {
  V.resetVedawebCache(); const r = stubFetch(VW);
  try {
    const out = await V.readPassage({ text: "rv", locator: "1.1.1" }, globalThis.fetch);
    assert.equal(out.status, "ok"); assert.equal(out.passages.length, 2);
    const p = out.passages.find(x => x.witness.resourceId === "66885142416394f483563b1c");
    assert.equal(p.text, "agním īḻe puróhitaṃ\nyajñásya devám ṛtvíjam\nhótāraṃ ratnadhā́tamam");
    assert.equal(p.locator.label, "1"); assert.ok(p.locator.aliases.includes("1.1.1")); assert.equal(p.encoding.hasVedicAccents, true); assert.equal(p.encoding.lineBreaks, 2);
    assert.match(p.witness.citation, /Nooten/); assert.equal(p.licensing.status, "not_exposed_by_api"); assert.equal(p.witness.independentWitness, false);
    assert.match(p.provenance.url, /\/api\/contents\?res=.*&location=66695ac77dbde8fe26788b50/);
    // The two editions differ in orthography (īḷe vs īḻe, r̥ vs ṛ): preserved, not normalized.
    const z = out.passages.find(x => x.witness.resourceId !== p.witness.resourceId); assert.notEqual(z.text, p.text); assert.ok(z.text.includes("īḷe"));
  } finally { r(); }
});
test("read_passage: unknown text, unknown locator, ambiguous locator, bad locator and outage are explicit", async () => {
  V.resetVedawebCache(); let r = stubFetch(VW);
  try {
    const u = await V.readPassage({ text: "gita", locator: "1.1" }, globalThis.fetch); assert.equal(u.status, "unknown_text"); assert.ok(u.availableTexts.some(t => t.slug === "rv")); assert.match(u.note, /Vedic texts only/);
    await assert.rejects(() => V.readPassage({ text: "rv", locator: "1.1; drop" }, globalThis.fetch), RangeError);
  } finally { r(); }
  V.resetVedawebCache(); r = stubFetch([VW[0], ["/api/locations", () => raw("[]")]]);
  try { const o = await V.readPassage({ text: "rv", locator: "99.99.99" }, globalThis.fetch); assert.equal(o.status, "locator_not_found"); assert.deepEqual(o.passages, []); } finally { r(); }
  V.resetVedawebCache(); const L = JSON.parse(fixture("vw_loc.json"))[0];
  r = stubFetch([VW[0], ["/api/locations", () => raw(JSON.stringify([L, { ...L, id: "x" }]))]]);
  try { const o = await V.readPassage({ text: "rv", locator: "1.1.1" }, globalThis.fetch); assert.equal(o.status, "ambiguous_locator"); assert.equal(o.candidates.length, 2); } finally { r(); }
  V.resetVedawebCache(); r = stubFetch([["vedaweb", () => new Error("down")]]);
  try { await assert.rejects(() => V.readPassage({ text: "rv", locator: "1.1.1" }, globalThis.fetch), e => e.kind === "unavailable"); } finally { r(); }
});

const SETI = { "105678": {}, "106098": { GRETIL: ["http://gretil.sub.uni-goettingen.de/gretil/1_sanskr/6_sastra/8_jyot/surysidu.htm"] } };
test("find_witnesses via MCP: typed items, no independent-witness claim, manuscripts honestly empty, provider outage tolerated", async () => {
  fresh();
  const r = stubFetch([worksRoute, ["seti/by_work", () => json({ "106098": SETI["106098"] })], ["entities/labels", () => json([{ id: "106098", label: "Sūryasiddhānta" }])], ["graph/subgraph", () => raw(fixture("subgraph_42451.json"))],
    ["archive.org", () => raw(fixture("ia_tantraraja.json"))], ["vedaweb", () => new Error("down")]]);
  try {
    const b = toolJson(await callTool("find_witnesses", { query: "Sūryasiddhānta", locus: "chapter 1" }));
    assert.equal(b.status, "partial"); assert.equal(b.providerStatus.vedaweb.status, "provider_unavailable");
    const kinds = new Set(b.witnesses.map(w => w.kind)); for (const k of ["catalogue_record", "electronic_transcription", "printed_edition_scan"]) assert.ok(kinds.has(k), k);
    assert.ok(b.witnesses.every(w => w.independentWitness.established === false));
    assert.ok(!b.witnesses.some(w => w.kind === "physical_manuscript")); assert.equal(b.manuscripts.physicalManuscriptWitnessesFound, 0); assert.equal(b.manuscripts.status, "no_supported_provider");
    const e = b.witnesses.find(w => w.kind === "electronic_transcription"); assert.equal(e.providerRecordId, "106098:GRETIL"); assert.match(e.url, /surysidu\.htm$/);
    assert.equal(b.locus.requested, "chapter 1");
  } finally { r(); }
});
test("find_witnesses: unresolved title still reports printed-book scans; invalid argument combinations are rejected", async () => {
  fresh();
  const r = stubFetch([worksRoute, ["archive.org", () => raw(fixture("ia_tantraraja.json"))], ["vedaweb", () => raw(fixture("vw_texts.json"))]]);
  try {
    const b = toolJson(await callTool("find_witnesses", { query: "Tantrarājatantra with Manoramā", locus: "chapter 25" }));
    assert.equal(b.status, "ok"); assert.equal(b.workResolution.status, "no_candidates"); assert.deepEqual(b.workResolution.usedForWitnessSearch, []);
    assert.ok(b.witnesses.some(w => w.kind === "printed_edition_scan" && /part-ii/.test(w.providerRecordId))); assert.equal(b.providerStatus.seti.status, "not_queried");
    assert.equal((await callTool("find_witnesses", {})).body.result.isError, true);
    assert.equal((await callTool("find_witnesses", { query: "x y", work_id: 5 })).body.result.isError, true);
  } finally { r(); }
});
test("find_witnesses by work_id; unknown id is reported", async () => {
  fresh();
  const r = stubFetch([worksRoute, ["seti/by_work", () => json({})], ["graph/subgraph", () => raw(fixture("subgraph_42451.json"))], ["archive.org", () => raw('{"response":{"numFound":0,"docs":[]}}')], ["vedaweb", () => raw(fixture("vw_texts.json"))]]);
  try {
    const b = toolJson(await callTool("find_witnesses", { work_id: 105678 })); assert.equal(b.workResolution.usedForWitnessSearch[0], "105678"); assert.ok(b.witnesses.some(w => w.kind === "catalogue_record"));
    const u = toolJson(await callTool("find_witnesses", { work_id: 999999999 })); assert.equal(u.workResolution.status, "work_id_not_in_pandit");
  } finally { r(); }
});
test("new tools through MCP: normalize_query, find_work, read_passage; malformed input rejected before any upstream call", async () => {
  fresh(); const r = stubFetch([worksRoute, ...VW]);
  try {
    const n = toolJson(await callTool("normalize_query", { query: "sUryasiddhAnta" })); assert.equal(n.strict, "sūryasiddhānta"); assert.equal(n.submitted, "sUryasiddhAnta");
    const f = toolJson(await callTool("find_work", { query: "Gaṇitakaumudī" })); assert.equal(f.candidates[0].panditWorkId, "105678");
  } catch (e) { r(); throw e; }
  try {
    const p = toolJson(await callTool("read_passage", { text: "rv", locator: "1.1.1" })); assert.equal(p.status, "ok");
    for (const [t, a] of [["read_passage", { text: "rv", locator: "1.1;x" }], ["read_passage", { text: "rv", locator: "1.1.1", resource_ids: ["nothex"] }], ["find_work", { query: "a" }], ["find_work", { query: "ok title", limit: 99 }], ["normalize_query", {}]]) assert.equal((await callTool(t, a)).body.result.isError, true, t);
  } finally { r(); }
});
