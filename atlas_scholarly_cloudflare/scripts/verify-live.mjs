#!/usr/bin/env node
// Independent production check. Usage:
//   node scripts/verify-live.mjs [baseUrl] [--commit <sha>] [--wait <seconds>] [--skip-upstream]
// Exit 0 only if /health, MCP initialize, tools/list and every tool answer as expected AND
// (when --commit is given) the live commit equals it. A successful Cloudflare build is not evidence.
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const base = (args.find(a => /^https?:/.test(a)) ?? "https://scholarly-sources.inahd.workers.dev").replace(/\/$/, "");
const wantCommit = opt("--commit");
const waitS = Number(opt("--wait") ?? 0);
const skipUpstream = args.includes("--skip-upstream");
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let failures = 0;
const report = (ok, name, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params, id = 1) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  const line = res.headers.get("content-type")?.includes("event-stream") ? text.split("\n").filter(l => l.startsWith("data:")).pop()?.slice(5) : text;
  return { status: res.status, body: JSON.parse(line) };
}
const tool = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args }, 9);
  const text = r.body.result?.content?.[0]?.text ?? "";
  let json; try { json = JSON.parse(text); } catch { json = { status: "non_json", message: text.slice(0, 200) }; }
  return { isError: !!r.body.result?.isError || !!r.body.error, json };
};

// 1. /health, optionally waiting for the expected commit to appear.
let health; const deadline = Date.now() + waitS * 1000;
for (;;) {
  try { health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-cache" } })).json(); } catch (e) { health = { error: String(e) }; }
  const good = health.version === pkg.version && (!wantCommit || health.commit === wantCommit);
  if (good || Date.now() >= deadline) break;
  console.log(`waiting: live version=${health.version} commit=${String(health.commit).slice(0, 8)} (want ${pkg.version} ${String(wantCommit).slice(0, 8)})`);
  await sleep(15000);
}
console.log("health:", JSON.stringify(health));
report(health.status === "ok", "/health status ok");
report(health.version === pkg.version, `/health version == package.json (${pkg.version})`, `live=${health.version}`);
if (wantCommit) report(health.commit === wantCommit, "/health commit == expected source commit", `live=${health.commit}`);
report(!!health.deployment?.versionId, "/health carries a deployment (Worker version) id", health.deployment?.versionId ?? "missing");

// 2. MCP
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-live", version: "1" } });
report(init.body.result?.serverInfo?.version === pkg.version, "MCP initialize", JSON.stringify(init.body.result?.serverInfo));
const list = await rpc("tools/list", {});
const names = (list.body.result?.tools ?? []).map(t => t.name).sort();
report(JSON.stringify(names) === JSON.stringify(["find_catalog_entries", "list_source_portals", "search_scholarly_literature", "seti_by_work"]), "tools/list", names.join(","));

// 3. Tools
const dir = await tool("list_source_portals", {});
report(!dir.isError && dir.json.sources?.length >= 6, "list_source_portals", `${dir.json.sources?.length} sources`);
if (!skipUpstream) {
  const lit = await tool("search_scholarly_literature", { query: "Kashmir Shaivism" });
  report(!lit.isError && lit.json.provider === "Crossref" && lit.json.retrievedAt, "search_scholarly_literature", lit.isError ? `${lit.json.status} ${lit.json.message}` : `matched=${lit.json.matched}/${lit.json.returned}`);
  const seti = await tool("seti_by_work", { work_ids: [111493, 42078] });
  const setiOk = !seti.isError && seti.json.status === "ok" && seti.json.works.some(w => w.seti && w.collections.length);
  const setiDown = seti.isError && seti.json.status === "provider_unavailable";
  report(setiOk || setiDown, "seti_by_work", setiOk ? `ok, ${seti.json.works.map(w => `${w.workId}:${w.collections.map(c => c.collection).join("+")}`).join(" ")}` : `PROVIDER STATUS ${seti.json.status}: ${seti.json.message}`);
  const bad = await tool("seti_by_work", { work_ids: [] });
  report(bad.isError === true, "negative: empty work_ids rejected");
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
