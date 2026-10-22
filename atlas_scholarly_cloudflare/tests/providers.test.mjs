import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const p=readFileSync(new URL('../src/providers.ts',import.meta.url),'utf8');
const s=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
test('only fixed upstream service roots used',()=>{assert.match(p,/https:\/\/www\.wikidata\.org/);assert.match(p,/https:\/\/api\.crossref\.org/);assert.doesNotMatch(p,/fetch\(query/)});
test('three read-only MCP tools registered',()=>{for(const tool of ['list_source_portals','find_catalog_entries','search_scholarly_literature'])assert.ok(s.includes(`registerTool("${tool}"`));});
