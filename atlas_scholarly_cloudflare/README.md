# Atlas Scholarly Sources — Cloudflare MCP Worker (v0.3)

Read-only, stateless remote MCP server. Independent of the Atlas machine and corpus. Unauthenticated: do not add private sources or secrets.

- Worker `scholarly-sources` · `https://scholarly-sources.inahd.workers.dev` · MCP `/mcp` · health `/health`
- MCP handler: `createMcpHandler(...)` from `@modelcontextprotocol/server`, served through its `.fetch(request)` interface (legacy `initialize` and modern `server/discover` both answered).

## Tools

| Tool | Provider / contract | Notes |
|---|---|---|
| `list_source_portals` | static directory | Marks which portals are queried live and which are links only |
| `find_catalog_entries` | Wikidata `wbsearchentities` | Leads only, not text witnesses |
| `search_scholarly_literature` | Crossref `works`, `query.bibliographic`, type filter | Articles, books, chapters, monographs, proceedings, dissertations. Drops front/back matter (Index, Bibliography, …); the books those parts belong to are returned separately as unverified `relatedWorks` |
| `seti_by_work` | Pāṇḍitya `GET /api/seti/by_work?ids=` (Swagger: `https://panditya.info/api/swagger.json`, v2.6.2) | Known numeric Pandit work IDs only (1–20). No title search |

Every result carries `provider`, `endpoint`, `httpStatus`, `retrievedAt`. Provider failures return `isError` with `status` `provider_unavailable` (network/timeout) or `provider_error` (HTTP error, wrong content type, bad JSON, schema drift) — never an empty success.

**SETI limits.** The Swagger documents the `ids` parameter but no response schema. The parser accepts only the shape observed on 2026-10-22, `{workId: {collection: [url] | {format: [url]}}}`, and reports anything else as `provider_error`. Unknown IDs are silently omitted by SETI (HTTP 400 when none match); this is reported as `no_entries_for_ids` / `seti:false`, never as absence of texts elsewhere. Labels come from `/api/entities/labels` (best effort).

### v0.3 tools (title → work → witnesses → passage)

| Tool | Provider / verified contract | Notes |
|---|---|---|
| `normalize_query` | none (local) | Strict IAST vs lossy folded keys; every variant listed with its basis. ś/ṣ/s, ḷ/ḻ/l, ṭ/t are never merged in the strict tier; ṃ≡ṁ is treated as one letter in two dot conventions |
| `find_work` | Pandit `GET /api/entities/works` (13,683 titles, scanned locally with a native regex, not parsed) + `POST /api/graph/subgraph` | Title search in IAST, Devanāgarī, Harvard-Kyoto or ASCII; `Work with Commentary`. Ranked candidates with Pandit id, alternative titles, match basis, confidence, `https://www.panditproject.org/node/<id>` and explicit homonym ambiguity. Absence is reported |
| `find_witnesses` | Pandit + SETI `by_work` + Pandit relations + Internet Archive `advancedsearch` + VedaWeb `/api/texts` | Items typed `catalogue_record`, `electronic_transcription`, `printed_edition_scan`, `reprint_scan`. **No item is called an independent witness**; physical manuscripts are reported as not supported by any provider |
| `read_passage` | VedaWeb/Tekst `/api/locations`, `/api/resources`, `/api/contents` | One stanza-level locator (e.g. rv 1.1.1), per edition: exact text, locator, encoding, citation, provenance URL, licence status. Vedic texts only |

Frozen relevance set: `eval/queries.json`, run with `node scripts/eval-relevance.mjs [baseUrl]`.

**Limits.** `panditproject.org` blocks automated clients, so its manuscript catalogue is not queried. Internet Archive metadata does not say whether a scan is an edition, translation, study or reprint; OCR text is not fetched. VedaWeb does not expose licences through its API (they are in the TEI headers of `vedaweb-data`). Title matching only finds titles that contain the query (modulo spacing, diacritics and word order).

## Update flow (repeatable)

`git push` to `main` → Cloudflare Workers Builds (existing integration, root directory `atlas_scholarly_cloudflare`) runs `wrangler deploy` → wrangler's `build.command` (see `wrangler.jsonc`) stamps the commit, typechecks and runs the tests **before** upload, so a failing test aborts the deploy → GitHub Action `verify` re-tests and polls production until `/health` reports this exact commit, then exercises every tool.

Local: `npm ci && npm run verify` (typecheck, tests, Worker build dry-run). `npm run deploy` does the same then deploys with your own `wrangler login`; secrets stay in Cloudflare / your login, never in the repo.

## Check production

```bash
curl -s https://scholarly-sources.inahd.workers.dev/health        # version, commit, deployment.versionId
node scripts/verify-live.mjs                                      # full live check
node scripts/verify-live.mjs --commit "$(git rev-parse HEAD)" --wait 300   # until this commit is live
```

A green Cloudflare build is **not** proof of deployment: compare `/health.commit` with the commit you pushed.

## Rollback

1. Preferred (keeps history and the verify check): `git revert <bad-sha> && git push`, then run the check above with the new commit.
2. Immediate: Cloudflare dashboard → Workers → `scholarly-sources` → Deployments → pick the previous version → *Rollback* (or `npx wrangler rollback <version-id>`). `/health.deployment.versionId` shows what is live. A later push redeploys from `main`, so also revert in git.

## Known failure mode (seen 2026-10-22)

Workers Builds for consecutive pushes can finish out of order; the build of an older commit finishing last overwrites the newer deployment. Symptom: build "success" but `/health.commit` is not the latest. Fix: re-run the build of the latest commit (dashboard → Builds → Retry), or push a new commit.
