#!/usr/bin/env node
// Frozen relevance evaluation against a running Worker (default: production).
//   node scripts/eval-relevance.mjs [baseUrl] [--write eval/results.json]
// Measures, per query: useful work identification, witness discovery, irrelevant candidates, provider failures,
// and whether a genuine zero-match is reported as such.
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const base = (args.find(a => /^https?:/.test(a)) ?? "https://scholarly-sources.inahd.workers.dev").replace(/\/$/, "");
const out = args.includes("--write") ? args[args.indexOf("--write") + 1] : null;
const spec = JSON.parse(readFileSync(new URL("../eval/queries.json", import.meta.url), "utf8"));
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function tool(name, a) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: a } }), signal: AbortSignal.timeout(60000) });
  const t = await res.text(); const line = res.headers.get("content-type")?.includes("event-stream") ? t.split("\n").filter(l => l.startsWith("data:")).pop().slice(5) : t;
  const r = JSON.parse(line).result; return { isError: !!r.isError, json: JSON.parse(r.content[0].text) };
}
const fold = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const rows = []; let providerFailures = 0;
for (const q of spec.queries) {
  const row = { id: q.id, query: q.query, checks: {}, counts: {} };
  const fw = await tool("find_work", { query: q.query });
  if (fw.isError) { providerFailures++; row.checks.find_work = "PROVIDER_FAILURE"; rows.push(row); continue; }
  const c = fw.json.candidates, p = q.pandit ?? {};
  row.counts.candidates = c.length;
  if (p.expectAbsent) row.checks.zeroMatchReported = c.length === 0 && fw.json.status === "no_candidates";
  if (p.top1) row.checks.top1Correct = c[0]?.panditWorkId === p.top1;
  if (p.expectIds) row.checks.expectedIdsFound = p.expectIds.every(id => c.some(x => x.panditWorkId === id));
  if (p.expectAtLeast) row.checks.enoughCandidates = c.length >= p.expectAtLeast;
  if (p.expectHomonyms) row.checks.homonymsFlagged = fw.json.ambiguity?.kind === "homonymous_titles";
  if (p.relevantTitleRegex) { const re = new RegExp(p.relevantTitleRegex); const irr = c.filter(x => ![x.title, ...x.alternativeTitles].some(t => re.test(fold(t)))); row.counts.irrelevantCandidates = irr.length; row.irrelevant = irr.map(x => `${x.panditWorkId} ${x.title}`); }
  if (q.seti || q.archive || p.top1 || p.expectAbsent) {
    const fx = await tool("find_witnesses", { query: q.query, locus: "chapter 25" });
    if (fx.isError) { providerFailures++; row.checks.find_witnesses = "PROVIDER_FAILURE"; }
    else {
      const w = fx.json.witnesses, ps = fx.json.providerStatus;
      for (const [k, v] of Object.entries(ps)) if (/provider_/.test(JSON.stringify(v))) { providerFailures++; (row.providerFailures ??= []).push(k); }
      row.counts.witnessesByKind = w.reduce((m, x) => (m[x.kind] = (m[x.kind] ?? 0) + 1, m), {});
      row.checks.noIndependenceClaim = w.every(x => x.independentWitness?.established === false);
      if (q.seti?.expectEmpty) row.checks.setiEmpty = !w.some(x => x.kind === "electronic_transcription");
      if (q.seti?.expectCollections) row.checks.setiCollections = q.seti.expectCollections.every(cn => w.some(x => x.collection === cn));
      if (q.archive) { const re = new RegExp(q.archive.titleRegex); const hits = w.filter(x => x.source === "Internet Archive" && re.test(fold(x.title ?? ""))); row.counts.archiveRelevant = hits.length; row.counts.archiveReturned = w.filter(x => x.source === "Internet Archive").length; row.checks.archiveLeads = hits.length >= q.archive.expectAtLeast; row.archiveSample = hits.slice(0, 3).map(x => `${x.providerRecordId} | ${x.title} | ${x.date ?? ""}`); }
      row.physicalManuscripts = fx.json.manuscripts.physicalManuscriptWitnessesFound;
    }
  }
  rows.push(row);
}
let pass = 0, total = 0;
for (const r of rows) { const ch = Object.entries(r.checks); const ok = ch.filter(([, v]) => v === true).length; pass += ok; total += ch.length;
  console.log(`${r.id.padEnd(30)} ${ok}/${ch.length}  ${ch.filter(([, v]) => v !== true).map(([k, v]) => `FAIL:${k}=${v}`).join(" ")}  ${JSON.stringify(r.counts)}${r.irrelevant?.length ? " irrelevant=" + JSON.stringify(r.irrelevant) : ""}`); }
const summary = { base, checksPassed: pass, checksTotal: total, providerFailures, irrelevantCandidates: rows.reduce((n, r) => n + (r.counts.irrelevantCandidates ?? 0), 0), candidatesReturned: rows.reduce((n, r) => n + (r.counts.candidates ?? 0), 0) };
console.log("\nSUMMARY", JSON.stringify(summary));
if (out) writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 1));
process.exit(pass === total && providerFailures === 0 ? 0 : 1);
