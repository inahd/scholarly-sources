import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Regenerate build-info, then bundle the real Worker entry exactly as source.
execFileSync("node", ["scripts/build-info.mjs"], { cwd: new URL("..", import.meta.url), stdio: "ignore" });
const out = join(mkdtempSync(join(tmpdir(), "scholarly-")), "worker.mjs");
await build({ entryPoints: [new URL("../src/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
export const worker = (await import(pathToFileURL(out).href)).default;
const provOut = join(mkdtempSync(join(tmpdir(), "scholarly-p-")), "providers.mjs");
await build({ entryPoints: [new URL("../src/providers.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: provOut, logLevel: "silent" });
export const providers = await import(pathToFileURL(provOut).href);
/** Bundle any src module for direct unit tests. */
export async function load(name) {
  const o = join(mkdtempSync(join(tmpdir(), `scholarly-${name}-`)), `${name}.mjs`);
  await build({ entryPoints: [new URL(`../src/${name}.ts`, import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: o, logLevel: "silent" });
  return import(pathToFileURL(o).href);
}
export const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
export const raw = (text, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
/** POST one JSON-RPC message to /mcp; returns the parsed JSON-RPC response (handles JSON or SSE bodies). */
export async function rpc(method, params, { id = 1, env = {}, headers = {} } = {}) {
  const res = await worker.fetch(new Request("https://worker.test/mcp", { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }), env);
  const text = await res.text();
  const data = res.headers.get("content-type")?.includes("event-stream") ? text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).pop() : text;
  return { status: res.status, body: data ? JSON.parse(data) : null };
}
export const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } };
export const callTool = (name, args) => rpc("tools/call", { name, arguments: args }, { id: 7 });
export const toolJson = r => JSON.parse(r.body.result.content[0].text);

/** Replace global fetch with a router: [[substring, () => Response], ...]. Restores via returned function. */
export function stubFetch(routes) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input); calls.push(url);
    for (const [needle, make] of routes) if (url.includes(needle)) { const r = make(url); if (r instanceof Error) throw r; return r; }
    throw new Error(`unexpected upstream call: ${url}`);
  };
  return Object.assign(() => { globalThis.fetch = real; }, { calls });
}
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
