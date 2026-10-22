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
  { name: "Pāṇḍitya / SETI", url: "https://panditya.info/seti", role: "Sanskrit work-to-e-text discovery; API not wired yet" },
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
  return {provider:"Crossref",query,status:"bibliographic_metadata_not_text_witness",results:(x.message?.items??[]).map(v=>({doi:v.DOI,title:v.title?.[0]??"",url:v.URL,type:v.type??"",publisher:v.publisher??"",published:v.published??null}))};
}
