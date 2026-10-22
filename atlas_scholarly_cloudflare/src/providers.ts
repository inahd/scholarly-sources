/** Public discovery only. Nothing here ingests or redistributes corpus texts. */
export function catalogUrl(query: string): string {
  const u = new URL("https://www.wikidata.org/w/api.php");
  u.searchParams.set("action", "wbsearchentities");
  u.searchParams.set("format", "json");
  u.searchParams.set("language", "en");
  u.searchParams.set("limit", "10");
  u.searchParams.set("search", query);
  u.searchParams.set("origin", "*");
  return u.toString();
}
export function researchUrl(query: string): string {
  const u = new URL("https://api.crossref.org/works");
  u.searchParams.set("query", query);
  u.searchParams.set("rows", "8");
  u.searchParams.set("select", "DOI,title,author,published,URL,publisher,type");
  return u.toString();
}
export const portals = [
  { name: "Pāṇḍitya / SETI", url: "https://panditya.info/seti", role: "Sanskrit work-to-e-text discovery; work ID lookup in beta; availability verified at runtime" },
  { name: "Pandit Project", url: "https://panditproject.org/", role: "manuscripts, works, people and identifiers" },
  { name: "Muktabodha", url: "https://muktabodha.org/digital-library/", role: "Tantric texts and source catalogue" },
  { name: "GRETIL", url: "https://gretil.sub.uni-goettingen.de/", role: "Sanskrit electronic texts" },
  { name: "SARIT", url: "https://sarit.indology.info/", role: "critical and marked-up Indic editions" },
  { name: "VedaWeb", url: "https://vedaweb.uni-koeln.de/", role: "linguistically annotated Vedic material" }
];
export async function queryJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "AtlasScholarlySources/0.1 (read-only research)" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Remote source returned HTTP ${response.status}`);
  return response.json();
}
export async function findCatalog(query: string) {
  const x = await queryJson(catalogUrl(query)) as {search?: Array<{id:string,label:string,description?:string,concepturi:string}>};
  return {provider:"Wikidata", query, status:"discovery_only_not_text_witness", results:(x.search??[]).map(v=>({id:v.id,title:v.label,description:v.description??"",url:v.concepturi}))};
}
export async function findScholarship(query: string) {
  const x = await queryJson(researchUrl(query)) as {message?:{items?:Array<{DOI:string,title?:string[],URL:string,type?:string,publisher?:string,published?:unknown}>}};
  const results=(x.message?.items??[]).map(v=>({doi:v.DOI,title:v.title?.[0]??"",url:v.URL,type:v.type??"",publisher:v.publisher??"",published:v.published??null}));
  const matches=relevantCrossref(query,results);
  return {provider:"Crossref",query,status:"bibliographic_metadata_only",matched:matches.length,unfilteredCount:results.length,results:matches,note:matches.length===0?"Crossref returned no title-relevant items; this is not evidence that scholarship or manuscripts do not exist.":"Only title-matched bibliographic leads. No verified passage evidence."};
}

/** SETI's /api/seti/by_work route is documented in the 2025 SETI paper.
 * The route's query schema is not independently verified: opt-in beta only.
 * A Pandit numeric work ID is required: no misleading title->ID inference. */
export async function setiByWork(workId: number) {
  const url = new URL("https://panditya.info/api/seti/by_work");
  url.searchParams.set("work_id", String(workId));
  const response = await fetch(url.toString(), {headers:{Accept:"application/json"},signal:AbortSignal.timeout(9000)});
  if(!response.ok) return {provider:"Pāṇḍitya/SETI",status:"endpoint_unverified",httpStatus:response.status,url:url.toString(),note:"SETI /api/seti/by_work is documented but this deployment has not established its query parameter contract; do not interpret as no witnesses."};
  const ctype=response.headers.get("content-type")??"";
  if(!ctype.includes("json")) return {provider:"Pāṇḍitya/SETI",status:"unexpected_content_type",contentType:ctype};
  const data:unknown=await response.json();
  const encoded=JSON.stringify(data);
  if(encoded.length>45000) return {provider:"Pāṇḍitya/SETI",status:"response_too_large",characters:encoded.length};
  return {provider:"Pāṇḍitya/SETI",status:"unverified_schema_review_required",workId,data};
}
export function relevantCrossref(query:string, entries:Array<{title:string}>) {
  const stop=new Set(["the","of","and","with","an","a","in","on","to","sanskrit","commentary","manuscript"]);
  const terms=query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").match(/[a-z]{3,}/g)?.filter(t=>!stop.has(t))??[];
  if(terms.length===0) return [];
  return entries.filter(entry=>{const title=entry.title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");return terms.some(t=>title.includes(t));});
}
