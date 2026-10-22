import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const p=readFileSync(new URL('../src/providers.ts',import.meta.url),'utf8');
const s=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
test('only fixed upstream service roots used',()=>{assert.match(p,/https:\/\/www\.wikidata\.org/);assert.match(p,/https:\/\/api\.crossref\.org/);assert.doesNotMatch(p,/fetch\(query/)});
test('three read-only MCP tools registered',()=>{for(const tool of ['list_source_portals','find_catalog_entries','search_scholarly_literature','seti_by_work_beta'])assert.ok(s.includes(`registerTool("${tool}"`));});

test('MCP entry uses .fetch',()=>{assert.match(s,/handler\.fetch\(request\)/);});
test('SETI beta uses fixed upstream and declared uncertainty',()=>{assert.match(p,/https:\/\/panditya\.info\/api\/seti\/by_work/);assert.match(p,/unverified_schema_review_required/)});
test('Crossref filters unrelated titles',()=>{assert.match(p,/relevantCrossref\(query,results\)/)});
