import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BUILD } from "./build-info";
import { findCatalog, findScholarship, setiByWork, portals, ProviderError, SETI_MAX_IDS } from "./providers";

type Env = { CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string } };
const SERVICE = "atlas-scholarly-sources";
const query = z.string().trim().min(2).max(160);

const ok = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }] });
const fail = (provider: string, e: unknown) => {
  const known = e instanceof ProviderError;
  return { isError: true, ...ok({
    status: known && e.kind === "unavailable" ? "provider_unavailable" : "provider_error",
    provider: known ? e.provider : provider, kind: known ? e.kind : "internal", httpStatus: known ? e.httpStatus ?? null : null,
    message: known ? e.message : `${provider} lookup failed`, retrievedAt: new Date().toISOString(),
    note: "No result is not evidence of absence; retry or consult the provider directly."
  }) };
};

function createServer() {
  const s = new McpServer({ name: SERVICE, version: BUILD.version });
  s.registerTool("list_source_portals", {
    description: "Source directory: reputable Sanskrit/Vedic discovery portals, with which of them this server can query live. Links only unless marked live.",
    inputSchema: {}
  }, async () => ok({ status: "directory", provider: "static directory", sources: portals }));
  s.registerTool("find_catalog_entries", {
    description: "Search public Wikidata entities for a work, edition, person or title. Leads only, not verified Sanskrit witnesses.",
    inputSchema: { query }
  }, async ({ query }) => { try { return ok(await findCatalog(query)); } catch (e) { return fail("Wikidata", e); } });
  s.registerTool("search_scholarly_literature", {
    description: "Search Crossref for scholarly publications (articles, books, chapters, monographs, proceedings, dissertations), filtered by publication type and title relevance. Bibliographic metadata only.",
    inputSchema: { query }
  }, async ({ query }) => { try { return ok(await findScholarship(query)); } catch (e) { return fail("Crossref", e); } });
  s.registerTool("seti_by_work", {
    description: `Pāṇḍitya SETI lookup by known numeric Pandit work IDs (GET /api/seti/by_work?ids=, per the provider's Swagger). Returns registered e-text links per collection. Up to ${SETI_MAX_IDS} IDs. Does not search by title.`,
    inputSchema: { work_ids: z.array(z.number().int().positive().max(1_000_000_000)).min(1).max(SETI_MAX_IDS) }
  }, async ({ work_ids }) => { try { return ok(await setiByWork(work_ids)); } catch (e) { return fail("Pāṇḍitya/SETI", e); } });
  return s;
}

const handler = createMcpHandler(createServer);

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const d = env?.CF_VERSION_METADATA;
      return Response.json({
        status: "ok", service: SERVICE, version: BUILD.version, commit: BUILD.commit, dirty: BUILD.dirty, builtAt: BUILD.builtAt,
        deployment: d ? { versionId: d.id, tag: d.tag ?? null, timestamp: d.timestamp ?? null } : null
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return handler.fetch(request);
  }
};
