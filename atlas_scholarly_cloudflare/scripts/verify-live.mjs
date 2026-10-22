#!/usr/bin/env node
// Independent production check. Usage:
//   node scripts/verify-live.mjs [baseUrl] [--commit <sha>] [--wait <seconds>] [--skip-upstream]
// Exit 0 only if /health, MCP initialize, tools/list and every tool answer as expected AND
// (when --commit is given) the live commit equals it. A successful Cloudflare build is not evidence.
import { readFileSync } from "node:fs";
const fixtureText = (n) => readFileSync(new URL(`../tests/fixtures/${n}`, import.meta.url), "utf8");
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
report(JSON.stringify(names) === JSON.stringify(["compare_readings", "find_catalog_entries", "find_grammar_rule", "find_witnesses", "find_work", "list_source_portals", "lookup_sanskrit_word", "normalize_query", "read_passage", "search_scholarly_literature", "seti_by_work"]), "tools/list", names.join(","));

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
  const nq = await tool("normalize_query", { query: "sUryasiddhAnta" });
  report(!nq.isError && nq.json.strict === "sūryasiddhānta" && nq.json.submitted === "sUryasiddhAnta", "normalize_query", nq.json.strict);
  const fw = await tool("find_work", { query: "Gaṇitakaumudī" });
  report(!fw.isError && fw.json.candidates?.[0]?.panditWorkId === "105678", "find_work (title -> Pandit id)", fw.isError ? `${fw.json.status} ${fw.json.message}` : `top=${fw.json.candidates?.[0]?.panditWorkId} ${fw.json.candidates?.[0]?.confidence}`);
  const fz = await tool("find_work", { query: "Tantrarājatantra with Manoramā" });
  report(!fz.isError && fz.json.status === "no_candidates", "find_work reports an absent title honestly", fz.json.status);
  const fx = await tool("find_witnesses", { query: "Tantrarājatantra with Manoramā", locus: "chapter 25" });
  const kinds = [...new Set((fx.json.witnesses ?? []).map(w => w.kind))].join(",");
  report(!fx.isError && ["ok", "partial"].includes(fx.json.status) && (fx.json.witnesses ?? []).every(w => w.independentWitness?.established === false) && fx.json.manuscripts?.physicalManuscriptWitnessesFound === 0 && (fx.json.witnesses ?? []).some(w => w.kind === "printed_edition_scan"),
    "find_witnesses (acceptance query)", fx.isError ? `${fx.json.status} ${fx.json.message}` : `${fx.json.status} kinds=${kinds} n=${fx.json.witnesses.length}`);
  const rp = await tool("read_passage", { text: "rv", locator: "1.1.1" });
  report(!rp.isError && rp.json.status === "ok" && rp.json.passages?.some(p => p.text.startsWith("agním")), "read_passage rv 1.1.1", rp.isError ? `${rp.json.status} ${rp.json.message}` : `${rp.json.passages?.length} editions`);
  const rn = await tool("read_passage", { text: "rv", locator: "99.99.99" });
  report(!rn.isError && rn.json.status === "locator_not_found", "negative: unknown locator reported, not guessed");
  // v0.4 frozen research cases
  const rasi = await tool("lookup_sanskrit_word", { word: "rāśi", dictionaries: ["mw", "ap90"] });
  const mwRasi = (rasi.json.layers?.lexical?.entries ?? []).filter(e => e.dictionary.id === "mw");
  report(!rasi.isError && mwRasi.map(e => e.homonymNumber).join() === "1,2" && rasi.json.layers.morphological.status === "not_requested", "lookup_sanskrit_word rāśi (two MW homonyms; layers typed)", rasi.isError ? `${rasi.json.status} ${rasi.json.message}` : `${mwRasi.length} MW entries, ${rasi.json.layers.lexical.homonyms.length} homonym group(s)`);
  const sam = await tool("lookup_sanskrit_word", { word: "samāvṛtti" });
  report(!sam.isError && sam.json.layers?.lexical?.entries?.some(e => e.dictionary.id === "pwg") && !sam.json.layers.lexical.entries.some(e => e.dictionary.id === "mw"), "lookup_sanskrit_word samāvṛtti (PWG only; MW/AP90 absence reported)", sam.isError ? sam.json.status : `${sam.json.layers.lexical.entries.length} entry`);
  const vya = await tool("lookup_sanskrit_word", { word: "vyākīrṇa" });
  report(!vya.isError && ["mw", "ap90", "pwg"].every(d => vya.json.layers.lexical.entries.some(e => e.dictionary.id === d)), "lookup_sanskrit_word vyākīrṇa (MW, AP90, PWG kept separate)", vya.isError ? vya.json.status : vya.json.layers.lexical.entries.map(e => e.dictionary.id).join());
  const nak = await tool("lookup_sanskrit_word", { word: "nakṣatra", dictionaries: ["mw", "pwg"], analyze_form: true, categories: ["Noun"] });
  const sub = (nak.json.layers?.lexical?.entries ?? []).find(e => e.dictionary.id === "mw");
  report(!nak.isError && sub?.matchedVia === "sub_entry" && sub.subEntryId === "lemma-nakzatra" && ["candidates", "no_analysis", "provider_problem"].includes(nak.json.layers.morphological.status), "lookup_sanskrit_word nakṣatra (MW sub-entry + Heritage candidates)", nak.isError ? nak.json.status : `sub-entry of ${sub?.parent?.headwordSlp1}; morphology ${nak.json.layers.morphological.status}${nak.json.layers.morphological.alternatives ? " (" + nak.json.layers.morphological.alternatives.map(a => a.analysis).join(" | ") + ")" : ""}`);
  const ab = await tool("lookup_sanskrit_word", { word: "gharghararava", dictionaries: ["mw", "pwg"] });
  report(!ab.isError && ab.json.status === "not_found", "lookup_sanskrit_word absent word reported", ab.json.status);
  const gr = await tool("find_grammar_rule", { rule: "vṛddhir eci" });
  report(!gr.isError && gr.json.rule?.id === "6.1.88" && gr.json.rule.sutra === "वृद्धिरेचि" && gr.json.explanation?.anuvritti?.parsed?.[0]?.fromSutra === "6.1.87" && gr.json.linkedWork?.work?.panditWorkId === "41541", "find_grammar_rule 6.1.88 vṛddhir eci (+ Aṣṭādhyāyī linked)", gr.isError ? `${gr.json.status} ${gr.json.message}` : `${gr.json.rule?.id} ${gr.json.rule?.sutra}; linkedWork ${gr.json.linkedWork?.status}`);
  const iastV = fixtureText("kalanitya_v35_iast.txt"), ocrV = fixtureText("kalanitya_v35_ocr_deva.txt");
  const cr = await tool("compare_readings", { a: { text: iastV, witness_type: "electronic_transcription", transcription_method: "manual_transcription", locator: "Manoramā ch.25 v.35" }, b: { text: ocrV, witness_type: "ocr_derivative", transcription_method: "ocr", locator: "Manoramā ch.25 v.35" } });
  report(!cr.isError && cr.json.evidence?.a?.original === iastV && cr.json.evidence?.b?.original === ocrV && cr.json.resolution === null && cr.json.summary.certainDifferences >= 5 && cr.json.independence.status === "unknown", "compare_readings Kālanityā v.35 (IAST vs OCR): originals verbatim, nothing resolved", cr.isError ? `${cr.json.status} ${cr.json.message}` : `certain=${cr.json.summary.certainDifferences} classes=${JSON.stringify(cr.json.summary.differencesByClass)}`);
  const dm = await tool("compare_readings", { a: { text: "vāhyābhyantara" }, b: { text: "v?hyābhyantara" } });
  const dd = await tool("compare_readings", { a: { text: "vāhyābhyantara" }, b: { text: "bāhyābhyantara" } });
  report(!dm.isError && !dd.isError && dm.json.differences[0].class === "indeterminate_due_to_damage" && dd.json.differences[0].class === "certain_difference", "compare_readings: damaged ≠ different reading", `${dm.json.differences?.[0]?.class} / ${dd.json.differences?.[0]?.class}`);
  const cbad = await tool("compare_readings", { a: { text: "" }, b: { text: "x" } });
  report(cbad.isError === true, "negative: empty reading rejected");
  const bad = await tool("seti_by_work", { work_ids: [] });
  report(bad.isError === true, "negative: empty work_ids rejected");
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
