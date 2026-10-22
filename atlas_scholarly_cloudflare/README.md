# Atlas Scholarly Sources — Cloudflare MCP pilot

A **read-only**, stateless remote MCP Worker. Independent of your Atlas box and corpus; does not alter Atlas.

## Current tools (v0.2)

- `list_source_portals`: curated links to Pāṇḍitya/SETI, Pandit Project, Muktabodha, GRETIL, SARIT, and VedaWeb.
- `find_catalog_entries`: live Wikidata entity discovery for Sanskrit title variants and scholars.
- `search_scholarly_literature`: live Crossref bibliographic search, filtering unrelated title hits.
- `seti_by_work_beta`: experimental SETI work lookup by known Pandit work ID, with explicit unverified-schema status.

**Important:** these two live providers supply discovery leads and bibliography, *not* primary manuscript readings. Pāṇḍitya's documented `/api/seti/by_work` route is exposed as an explicitly experimental tool requiring a known numeric Pandit work ID. Query parameter and response schema remain unverified and the tool must not claim reliable witness discovery. No remote primary-text acquisition, OCR or witness adjudication yet.

## Deployment

1. Install Node.js 20+ and sign in to your existing Cloudflare account.
2. Run `npm install` and `npm run check` in this folder.
3. Run `npx wrangler login` (opens your Cloudflare login), then `npm run deploy`.
4. Wrangler prints a `https://atlas-scholarly-sources.<subdomain>.workers.dev` URL. Check `/health` in a browser and use `/mcp` in an MCP client.
5. In ChatGPT, **Plugins → + → Add custom MCP server** (if supported by your account), enter the `/mcp` HTTPS URL, review the four read-only tools, and connect.

The server is **unauthenticated** in this starter project, so anyone who knows the Worker URL can invoke the read-only public searches. Do not add private sources or secrets to this deployment. Before enabling private Atlas data or wider exposure, add authentication, rate limits, and governance. Cloudflare may meter usage and upstream providers may rate-limit requests; monitor free-tier usage.

No GitHub connection, paid AI inference, KV database, Durable Object, or local tunnel required.

## Verify

- `npm test` checks static source safeguards.
- `npm run check` TypeScript verification.
- `npm run dev` then test `http://localhost:8787/health` (Wrangler may choose a different port).
- Use MCP Inspector or a connected ChatGPT plugin to list and invoke tools.

## Next gate (not part of pilot)

Verify SETI Swagger/OpenAPI schema and use only documented public routes. Add `find_witnesses` if it can reliably return actual edition-linked identifiers; compare returns against Atlas's local source registry before considering source retrieval.

## Update the current GitHub-connected Worker

Upload the **contents** of this folder to the same `atlas_scholarly_cloudflare` folder in the existing GitHub repository; replace existing matching files, do not create a nested folder. Keep the Cloudflare Worker root directory pointing at `atlas_scholarly_cloudflare`. A commit triggers the connected Cloudflare build. `/health` should report version `0.2.0`. Reconnect/refresh tools in ChatGPT if needed.

**Validation limit:** local static tests pass, but dependency installation, live SETI response schema, and deployed ChatGPT handshake are not verified in this environment. Deploy only after `npm run check` and Wrangler build succeed. To make SETI authoritative, inspect live Swagger and update the parameter and response parser with verified samples.
