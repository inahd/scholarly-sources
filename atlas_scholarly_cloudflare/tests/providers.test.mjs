import test from "node:test";
import assert from "node:assert/strict";
import { providers as P } from "./helpers.mjs";

test("fixed upstream roots only", () => {
  assert.ok(P.catalogUrl("x").startsWith("https://www.wikidata.org/"));
  assert.ok(P.researchUrl("x").startsWith("https://api.crossref.org/"));
  assert.ok(P.setiUrl("seti/by_work", [1, 2]).startsWith("https://panditya.info/api/seti/by_work?ids=1,2"));
});
test("relevance filter: keeps matches on title or container, drops front matter and unrelated", () => {
  const e = [{ title: "Spanda in Kashmir Shaivism" }, { title: "Bibliography", container: "Kashmir Shaivism" }, { title: "Notes on rivers" }, { title: "Essay", container: "Journal of Kashmir Shaivism" }];
  assert.deepEqual(P.relevantCrossref("Kashmir Shaivism", e).map(x => x.title), ["Spanda in Kashmir Shaivism", "Essay"]);
  assert.deepEqual(P.relevantCrossref("the of and", e), []);
  assert.deepEqual(P.relevantCrossref("Śaiva Śivasūtra Kashmir", [{ title: "Kashmir Saiva" }]).length, 1);
});
test("parseSetiByWork accepts both observed shapes and rejects anything else", () => {
  assert.ok(P.parseSetiByWork({ "1": { A: ["u"], B: { f: ["v"] } } }));
  for (const bad of [null, [], "x", { x: {} }, { "1": [] }, { "1": { A: 3 } }, { "1": { A: { f: "u" } } }]) assert.equal(P.parseSetiByWork(bad), null);
});
test("setiByWork rejects invalid id lists locally", async () => {
  for (const ids of [[], [0], [1.2], Array.from({ length: 21 }, (_, i) => i + 1)]) await assert.rejects(() => P.setiByWork(ids, async () => { throw new Error("must not fetch"); }), RangeError);
});
