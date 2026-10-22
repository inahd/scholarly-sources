import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BUILD } from "./build-info";
import { normalizeQuery } from "./normalize";
import { findWorks } from "./pandit";
import { findWitnesses } from "./witnesses";
import { readPassage, LOCATOR } from "./vedaweb";
import { lookupWord, DICT_IDS } from "./lexicon";
import { findRule, analyzeForm, linkWork, HERITAGE_CATEGORIES } from "./grammar";
import { compareReadings, MAX_CHARS } from "./compare";
import { findCatalog, findScholarship, setiByWork, portals, ProviderError, SETI_MAX_IDS } from "./providers";

type Env = { CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string } };
const SERVICE = "atlas-scholarly-sources";
const query = z.string().trim().min(2).max(160);

const ok = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }] });
const fail = (provider: string, e: unknown) => {
  if (e instanceof RangeError) return { isError: true, ...ok({ status: "invalid_input", message: e.message }) };
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
  s.registerTool("normalize_query", {
    description: "Show how a Sanskrit query is normalized: script detection (Devanāgarī, IAST, Harvard-Kyoto, ASCII), strict IAST form, lossy folded keys, and every variant with its basis. Distinct letters (ś/ṣ/s, ḷ/ḻ/l, ṭ/t) are never merged in the strict form.",
    inputSchema: { query }
  }, async ({ query }) => ok({ status: "ok", ...normalizeQuery(query) }));
  s.registerTool("find_work", {
    description: "Find a Sanskrit work by TITLE in the Pāṇḍitya/Pandit work list (IAST, Devanāgarī, Harvard-Kyoto or plain ASCII; 'Work with Commentary' supported). Returns ranked candidates with Pandit work id, alternative titles, match basis, confidence, provider URL and explicit ambiguity for homonymous works. Absence from Pandit is reported, not hidden.",
    inputSchema: { query, limit: z.number().int().min(1).max(15).optional() }
  }, async ({ query, limit }) => { try { return ok(await findWorks(query, { limit })); } catch (e) { return fail("Pāṇḍitya", e); } });
  s.registerTool("find_witnesses", {
    description: "Unified source discovery for a work given by title or Pandit work id: SETI electronic-text links, Pandit catalogue record and author/commentary relations, Internet Archive printed-book scans, VedaWeb availability. Each item is typed (electronic_transcription, printed_edition_scan, catalogue_record, ...). Nothing is called an independent manuscript witness. Optional `locus` (e.g. 'chapter 25') is carried through with per-witness access notes.",
    inputSchema: { query: query.optional(), work_id: z.number().int().positive().max(1_000_000_000).optional(), locus: z.string().trim().max(80).optional(), include_archive: z.boolean().optional() }
  }, async (a) => { try { return ok(await findWitnesses(a)); } catch (e) { return fail("find_witnesses", e); } });
  s.registerTool("read_passage", {
    description: "Read ONE bounded passage from VedaWeb (Vedic texts only: rv, ab, jb, ms, sb, avs, avp) by locator such as 1.1.1. Returns text per edition resource with exact locator, encoding, citation, provenance URL and licensing status. Unknown locators are reported, never guessed.",
    inputSchema: { text: z.string().trim().min(1).max(12), locator: z.string().trim().regex(LOCATOR), resource_ids: z.array(z.string().regex(/^[0-9a-f]{24}$/)).max(5).optional() }
  }, async (a) => { try { return ok(await readPassage(a)); } catch (e) { return fail("VedaWeb", e); } });
  s.registerTool("lookup_sanskrit_word", {
    description: "Source-qualified Sanskrit dictionary lookup (Cologne Digital Sanskrit Lexicon via C-SALT: MW, AP90, PWG, BHS, VEI, GRA). Input in IAST, Devanāgarī, Harvard-Kyoto or plain ASCII (folded, lossy). Returns each dictionary's own entries with homonym numbers, L-numbers, page refs and attribution; sub-entries (e.g. nakṣatra under nakz) are found. Layers are typed separately: lexical (dictionary text), morphological (only with analyze_form, from the Sanskrit Heritage lemmatizer, alternatives listed), contextual (never provided). No meaning is generated.",
    inputSchema: { word: z.string().trim().min(2).max(60), dictionaries: z.array(z.enum(DICT_IDS as [string, ...string[]])).max(6).optional(), max_entries: z.number().int().min(1).max(10).optional(), scheme: z.enum(["auto", "slp1"]).optional(),
      analyze_form: z.boolean().optional(), categories: z.array(z.enum(HERITAGE_CATEGORIES)).max(4).optional(), link_works: z.boolean().optional() }
  }, async (a) => { try {
    const r = await lookupWord({ word: a.word, dictionaries: a.dictionaries as never, max_entries: a.max_entries, scheme: a.scheme });
    if (a.analyze_form) { try { (r.layers as Record<string, unknown>).morphological = await analyzeForm(a.word, a.categories as string[] | undefined); } catch (e) { if (e instanceof RangeError) (r.layers as Record<string, unknown>).morphological = { type: "morphological_analysis", status: "invalid_input", message: e.message }; else (r.layers as Record<string, unknown>).morphological = { type: "morphological_analysis", ...(e as { kind?: string }).kind ? { status: "provider_problem", message: (e as Error).message } : { status: "provider_error", message: String(e).slice(0, 200) } }; } }
    return ok(a.link_works ? { ...r, linkedWorks: await linkWork(a.word) } : r);
  } catch (e) { return fail("C-SALT/Kosh", e); } });
  s.registerTool("find_grammar_rule", {
    description: "Find a Pāṇinian sūtra by number (6.1.88, ६.१.८८) or text (vṛddhir eci, वृद्धिरेचि). Returns the sūtra, word division (padaccheda), anuvṛtti and adhikāra with their source sūtras, the repository's anuvṛtti-completed reading (labelled as derived), related rules, a link to commentaries (not retrieved), the Aṣṭādhyāyī work linked to Pandit/SETI, source locators and provenance. Repeated sūtra texts are returned as ambiguous, never chosen.",
    inputSchema: { rule: z.string().trim().min(3).max(80), link_works: z.boolean().optional() }
  }, async (a) => { try { return ok(await findRule(a)); } catch (e) { return fail("sanskrit/ashtadhyayi", e); } });
  const reading = z.object({ text: z.string().min(1).max(MAX_CHARS), work_id: z.string().max(80).optional(), witness_id: z.string().max(120).optional(), label: z.string().max(160).optional(), locator: z.string().max(120).optional(), source_url: z.string().url().max(500).optional(),
    witness_type: z.enum(["manuscript", "printed_edition", "reprint", "electronic_transcription", "ocr_derivative", "catalogue_only", "unknown"]).optional(), transcription_method: z.enum(["manual_transcription", "ocr", "collation_note", "digital_edition", "unknown"]).optional(),
    uncertainty_status: z.enum(["none_stated", "partly_uncertain", "damaged", "unknown"]).optional(), derived_from: z.string().max(500).optional() });
  s.registerTool("compare_readings", {
    description: `Deterministic comparison of two Sanskrit readings (each up to ${MAX_CHARS} characters; Devanāgarī and IAST, mixable). Letter-for-letter alignment with substitutions, omissions and insertions and exact spans in the original strings. Distinguishes certain differences, uncertain (restored [x] / <x>) differences and positions made indeterminate by damage (? and [...]). Optional normalization: none | encoding | conservative (never merges ś/ṣ/s, b/v, ṃ/nasals). Never resolves a variant, never infers witness independence from similarity; both originals returned verbatim with SHA-256. Witness metadata optional.`,
    inputSchema: { a: reading, b: reading, normalization: z.enum(["none", "encoding", "conservative"]).optional(), uncertainty_markup: z.enum(["atlas", "none"]).optional(), declared_relationship: z.enum(["unknown", "independent", "dependent"]).optional(), independence_evidence: z.string().max(500).optional() }
  }, async (a) => { try { return ok(await compareReadings(a as never)); } catch (e) { return fail("compare_readings", e); } });
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
