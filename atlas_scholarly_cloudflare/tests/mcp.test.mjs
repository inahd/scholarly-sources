import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sdk from "@modelcontextprotocol/server";
import { worker, rpc, INIT, callTool, toolJson, stubFetch, json } from "./helpers.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TOOLS = ["find_catalog_entries", "find_witnesses", "find_work", "list_source_portals", "normalize_query", "read_passage", "search_scholarly_literature", "seti_by_work"];

test("MCP initialize succeeds and reports the package version (fails if the handler cannot initialize)", async () => {
  const r = await rpc("initialize", INIT);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.serverInfo.name, "atlas-scholarly-sources");
  assert.equal(r.body.result.serverInfo.version, pkg.version);
  assert.ok(r.body.result.capabilities.tools);
});
test("server/discover (modern envelope) is answered", async () => {
  const ver = "2026-07-28";
  const meta = { [sdk.PROTOCOL_VERSION_META_KEY]: ver, [sdk.CLIENT_INFO_META_KEY]: { name: "t", version: "1" }, [sdk.CLIENT_CAPABILITIES_META_KEY]: {} };
  const res = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": ver, "mcp-method": "server/discover" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: meta } }) }), {});
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual(b.result.supportedVersions, [ver]);
  assert.equal(b.result._meta[sdk.SERVER_INFO_META_KEY].version, pkg.version);
});
test("tools/list exposes exactly the eight read-only tools (the original four plus four v0.3 tools)", async () => {
  const r = await rpc("tools/list", {});
  assert.deepEqual(r.body.result.tools.map(t => t.name).sort(), TOOLS);
});
test("/health reports version, commit and deployment id", async () => {
  const res = await worker.fetch(new Request("https://w.test/health"), { CF_VERSION_METADATA: { id: "ver-123", tag: "t", timestamp: "2026-10-22T00:00:00Z" } });
  const b = await res.json();
  assert.equal(b.status, "ok"); assert.equal(b.version, pkg.version);
  assert.match(b.commit, /^([0-9a-f]{40}|unknown)$/);
  assert.equal(b.deployment.versionId, "ver-123");
  assert.equal((await (await worker.fetch(new Request("https://w.test/health"), {})).json()).deployment, null);
});
test("unknown path is 404; malformed JSON is 4xx not 5xx; GET /mcp is 405", async () => {
  assert.equal((await worker.fetch(new Request("https://w.test/nope"), {})).status, 404);
  const bad = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{bad" }), {});
  assert.equal(bad.status, 400);
  assert.equal((await worker.fetch(new Request("https://w.test/mcp"), {})).status, 405);
});
test("handler is invoked through the SDK .fetch interface", () => {
  assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /handler\.fetch\(request\)/);
});

test("list_source_portals returns the directory with live/link-only markers", async () => {
  const b = toolJson(await callTool("list_source_portals", {}));
  assert.equal(b.status, "directory");
  assert.ok(b.sources.length >= 6);
  assert.ok(b.sources.some(s => s.name.includes("SETI") && s.api.startsWith("live")));
  assert.ok(b.sources.every(s => s.url.startsWith("https://")));
});

const CROSSREF = { message: { items: [
  { DOI: "10.1/a", title: ["Rumi, Kashmir Shaivism, and Tantra"], URL: "https://doi.org/10.1/a", type: "book-chapter", "container-title": ["Rumi and Shams"], issued: { "date-parts": [[2020]] }, author: [{ given: "A", family: "B" }], score: 30 },
  { DOI: "10.1/b", title: ["Index"], URL: "https://doi.org/10.1/b", type: "book-chapter", "container-title": ["The Doctrine of Vibration"], score: 28 },
  { DOI: "10.1/c", title: ["Introduction"], URL: "https://doi.org/10.1/c", type: "book-chapter", "container-title": ["The Doctrine of Vibration"], score: 28 },
  { DOI: "10.1/d", title: ["Unrelated hydrology paper"], URL: "https://doi.org/10.1/d", type: "journal-article", score: 20 },
  { DOI: "10.1/a", title: ["Rumi, Kashmir Shaivism, and Tantra"], URL: "https://doi.org/10.1/a", type: "book-chapter", score: 30 }
] } };
test("scholarly search filters by publication type, drops front matter, dedupes, and records provenance", async () => {
  const restore = stubFetch([["api.crossref.org", () => json(CROSSREF)]]);
  try {
    const b = toolJson(await callTool("search_scholarly_literature", { query: "Kashmir Shaivism" }));
    assert.equal(b.provider, "Crossref"); assert.equal(b.status, "bibliographic_metadata_only");
    assert.deepEqual(b.results.map(r => r.doi), ["10.1/a"]);
    assert.equal(b.returned, 5); assert.equal(b.matched, 1);
    assert.deepEqual(b.relatedWorks, [{ title: "The Doctrine of Vibration", partsReturned: 2 }]);
    assert.match(b.retrievedAt, /^\d{4}-/); assert.equal(b.httpStatus, 200);
    const u = new URL(restore.calls[0]);
    assert.equal(u.searchParams.get("query.bibliographic"), "Kashmir Shaivism");
    assert.ok(u.searchParams.get("filter").includes("type:journal-article") && !u.searchParams.get("filter").includes("peer-review"));
  } finally { restore(); }
});
test("scholarly search with no relevant hits says so without implying absence", async () => {
  const restore = stubFetch([["api.crossref.org", () => json({ message: { items: [] } })]]);
  try {
    const b = toolJson(await callTool("search_scholarly_literature", { query: "Spandakarika" }));
    assert.equal(b.matched, 0); assert.match(b.note, /not evidence/);
  } finally { restore(); }
});
test("catalog search maps Wikidata results", async () => {
  const restore = stubFetch([["wikidata.org", () => json({ search: [{ id: "Q1", label: "Spanda", description: "d", concepturi: "http://www.wikidata.org/entity/Q1" }] })]]);
  try {
    const b = toolJson(await callTool("find_catalog_entries", { query: "Spanda" }));
    assert.equal(b.results[0].id, "Q1"); assert.equal(b.status, "discovery_only_not_text_witness");
  } finally { restore(); }
});

// Shapes copied from live responses of https://panditya.info/api (2026-10-22).
const SETI_OK = { "111493": { GRETIL: ["http://gretil.sub.uni-goettingen.de/gretil/1_sanskr/2_epic/mbh/mbh_07_u.htm"] }, "42078": { DCS: { "web HTML": ["http://www.sanskrit-linguistics.org/dcs/index.php?contents=texte&IDTextDisplay=154"] }, GRETIL: ["http://gretil.sub.uni-goettingen.de/gretil/1_sanskr/2_epic/mbh/mbh_01_u.htm"] } };
const LABELS = [{ id: "111493", label: "Mahābhārata Droṇaparva" }, { id: "42078", label: "Mahābhārata" }];
test("SETI by_work uses the documented `ids` parameter and normalizes the observed shape", async () => {
  const restore = stubFetch([["seti/by_work", () => json(SETI_OK)], ["entities/labels", () => json(LABELS)]]);
  try {
    const b = toolJson(await callTool("seti_by_work", { work_ids: [111493, 42078] }));
    assert.equal(b.status, "ok");
    assert.equal(new URL(restore.calls[0]).searchParams.get("ids"), "111493,42078");
    assert.ok(!restore.calls[0].includes("work_id="));
    assert.equal(b.works[0].label, "Mahābhārata Droṇaparva");
    const dcs = b.works[1].collections.find(c => c.collection === "DCS");
    assert.deepEqual(dcs.links, [{ format: "web HTML", url: "http://www.sanskrit-linguistics.org/dcs/index.php?contents=texte&IDTextDisplay=154" }]);
    assert.equal(b.works[0].collections[0].links[0].format, null);
    assert.equal(b.provider, "Pāṇḍitya/SETI"); assert.match(b.endpoint, /by_work\?ids=/);
  } finally { restore(); }
});
test("SETI: IDs unknown to SETI are reported as 'no entry', not as a failure or absence of texts", async () => {
  const restore = stubFetch([["seti/by_work", () => json({ error: "No valid work IDs provided" }, 400)]]);
  try {
    const b = toolJson(await callTool("seti_by_work", { work_ids: [999999999] }));
    assert.equal(b.status, "no_entries_for_ids"); assert.deepEqual(b.works, []); assert.match(b.note, /nothing about/);
  } finally { restore(); }
});
test("SETI: partial match marks the unknown ID seti:false", async () => {
  const restore = stubFetch([["seti/by_work", () => json({ "111493": SETI_OK["111493"] })], ["entities/labels", () => json([LABELS[0]])]]);
  try {
    const b = toolJson(await callTool("seti_by_work", { work_ids: [111493, 999999999] }));
    assert.deepEqual(b.works.map(w => w.seti), [true, false]);
  } finally { restore(); }
});
test("SETI: label endpoint failure degrades to labelStatus=unavailable but keeps links", async () => {
  const restore = stubFetch([["seti/by_work", () => json(SETI_OK)], ["entities/labels", () => new Response("x", { status: 500 })]]);
  try {
    const b = toolJson(await callTool("seti_by_work", { work_ids: [111493] }));
    assert.equal(b.labelStatus, "unavailable"); assert.equal(b.works[0].label, null); assert.ok(b.works[0].collections.length);
  } finally { restore(); }
});

test("provider unreachable -> isError with provider_unavailable (SETI, Crossref, Wikidata)", async () => {
  const restore = stubFetch([["panditya.info", () => new Error("down")], ["crossref", () => new Error("down")], ["wikidata", () => new Error("down")]]);
  try {
    for (const [tool, args, provider] of [["seti_by_work", { work_ids: [1] }, "Pāṇḍitya/SETI"], ["search_scholarly_literature", { query: "tantra" }, "Crossref"], ["find_catalog_entries", { query: "tantra" }, "Wikidata"]]) {
      const r = await callTool(tool, args);
      assert.equal(r.body.result.isError, true, tool);
      const b = toolJson(r);
      assert.equal(b.status, "provider_unavailable"); assert.equal(b.provider, provider);
    }
  } finally { restore(); }
});
test("provider HTTP 500, wrong content type, bad JSON and schema drift are reported, not interpreted", async () => {
  const cases = [
    [() => new Response("boom", { status: 500 }), "http_error"],
    [() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "bad_content_type"],
    [() => new Response("{nope", { status: 200, headers: { "content-type": "application/json" } }), "bad_json"],
    [() => json({ "111493": "not-an-object" }), "bad_json"],
    [() => json({ "abc": { GRETIL: [] } }), "bad_json"],
    [() => json([1, 2]), "bad_json"]
  ];
  for (const [make, kind] of cases) {
    const restore = stubFetch([["seti/by_work", make]]);
    try {
      const r = await callTool("seti_by_work", { work_ids: [111493] });
      assert.equal(r.body.result.isError, true, kind);
      const b = toolJson(r);
      assert.equal(b.status, "provider_error"); assert.equal(b.kind, kind);
    } finally { restore(); }
  }
});
test("malformed tool inputs are rejected before any upstream call", async () => {
  const restore = stubFetch([]);
  try {
    for (const [tool, args] of [["seti_by_work", { work_ids: [] }], ["seti_by_work", { work_ids: ["x"] }], ["seti_by_work", { work_ids: [-1] }], ["seti_by_work", { work_ids: [1.5] }], ["seti_by_work", { work_ids: Array.from({ length: 21 }, (_, i) => i + 1) }], ["seti_by_work", {}], ["search_scholarly_literature", { query: "a" }], ["search_scholarly_literature", { query: 5 }], ["find_catalog_entries", { query: "x".repeat(161) }]]) {
      const r = await callTool(tool, args);
      assert.equal(r.body.result.isError, true, `${tool} ${JSON.stringify(args).slice(0, 40)}`);
    }
    assert.equal(restore.calls.length, 0);
    assert.ok((await rpc("tools/call", { name: "nope", arguments: {} })).body.error || (await rpc("tools/call", { name: "nope", arguments: {} })).body.result.isError);
  } finally { restore(); }
});
