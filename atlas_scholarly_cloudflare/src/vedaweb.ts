/** VedaWeb (Tekst platform) bounded passage retrieval.
 *  Verified contract (probed 2026-10-22, API 0.56.2b0, https://vedaweb.uni-koeln.de/api/openapi.json):
 *   GET /api/texts                                   -> [{id,slug,title,levels:[...]}]
 *   GET /api/locations?textSlug=&alias=&limit=       -> [{id,textId,parentId,level,position,label,aliases:[...]}]   (alias "1.1.1" = RV 1.1.1)
 *   GET /api/resources?txt=<textId>&limit=           -> [{id,resourceType,level,title:[{locale,translation}],citation,license,public,config}]
 *   GET /api/contents?res=<id>&res=<id>&location=<id>-> [{id,resourceId,resourceType,locationId,text}]
 *  The API exposes a `license` field but it is null for every resource; the licence is stated per source in the TEI header of
 *  https://github.com/VedaWebProject/vedaweb-data (rigveda/TEI). Nothing is mirrored; one location per call. */
import { ProviderError, queryJson, provenance, type FetchLike } from "./providers";

export const VEDAWEB_API = "https://vedaweb.uni-koeln.de/api";
const TTL = 6 * 3600_000;
type Text = { id: string; slug: string; title: string };
let textsMemo: { at: number; texts: Text[] } | null = null; const resMemo = new Map<string, { at: number; res: Resource[] }>();
export const resetVedawebCache = () => { textsMemo = null; resMemo.clear(); };
type Resource = { id: string; resourceType: string; level: number; title: Array<{ locale: string; translation: string }>; citation?: string | null; license?: string | null; public?: boolean; config?: { general?: { defaultActive?: boolean; category?: string } } };

export async function vedawebTexts(doFetch: FetchLike = fetch): Promise<Text[]> {
  if (textsMemo && Date.now() - textsMemo.at < TTL) return textsMemo.texts;
  const { data, httpStatus } = await queryJson("VedaWeb", `${VEDAWEB_API}/texts`, doFetch, 15000);
  if (!Array.isArray(data) || !data.every((t: any) => typeof t?.id === "string" && typeof t?.slug === "string" && typeof t?.title === "string"))
    throw new ProviderError("VedaWeb", "bad_json", "texts list does not match the observed [{id,slug,title}] shape", httpStatus);
  const texts = (data as Text[]).map(t => ({ id: t.id, slug: t.slug, title: t.title }));
  textsMemo = { at: Date.now(), texts }; return texts;
}
const label = (r: Resource) => (r.title.find(t => t.locale === "enUS" || t.locale === "*") ?? r.title[0])?.translation ?? r.id;
async function resources(textId: string, doFetch: FetchLike): Promise<Resource[]> {
  const hit = resMemo.get(textId); if (hit && Date.now() - hit.at < TTL) return hit.res;
  const { data, httpStatus } = await queryJson("VedaWeb", `${VEDAWEB_API}/resources?txt=${encodeURIComponent(textId)}&limit=200`, doFetch, 20000);
  if (!Array.isArray(data) || !data.every((r: any) => typeof r?.id === "string" && typeof r?.resourceType === "string" && typeof r?.level === "number" && Array.isArray(r?.title)))
    throw new ProviderError("VedaWeb", "bad_json", "resources list does not match the observed shape", httpStatus);
  resMemo.set(textId, { at: Date.now(), res: data as Resource[] }); return data as Resource[];
}
export const LOCATOR = /^[0-9A-Za-z][0-9A-Za-z.,:\-]{0,30}$/;
/** Describes the script and accentuation actually present in a returned string (computed, not assumed). */
export function describeEncoding(text: string) {
  const nfc = text.normalize("NFC") === text, nfd = text.normalize("NFD") === text;
  return { charset: "UTF-8 (JSON)", script: /[ऀ-ॿ]/.test(text) ? "Devanāgarī" : "Latin (IAST-style transliteration)",
    unicodeNormalization: nfc && nfd ? "NFC=NFD (ASCII only)" : nfc ? "NFC" : nfd ? "NFD" : "mixed", hasVedicAccents: /[́̀]|[áíúéóàìùèòÁÍÚ]|[॑-॔]/.test(text), lineBreaks: (text.match(/\n/g) ?? []).length };
}
export async function readPassage(args: { text: string; locator: string; resource_ids?: string[] }, doFetch: FetchLike = fetch) {
  const texts = await vedawebTexts(doFetch);
  const t = texts.find(x => x.slug === args.text);
  if (!t) return { ...provenance("VedaWeb", "GET /api/texts", 200), status: "unknown_text", requested: args.text, availableTexts: texts.map(x => ({ slug: x.slug, title: x.title })), note: "VedaWeb serves Vedic texts only; it holds no Tantric, Jyotiṣa or classical śāstra texts." };
  if (!LOCATOR.test(args.locator)) throw new RangeError("locator must look like 1.1.1 (letters, digits, . , : -)");
  const locUrl = `${VEDAWEB_API}/locations?textSlug=${encodeURIComponent(t.slug)}&alias=${encodeURIComponent(args.locator)}&limit=5`;
  const loc = await queryJson("VedaWeb", locUrl, doFetch, 15000);
  const locs = loc.data as Array<{ id: string; level: number; label: string; aliases?: string[]; position?: number }>;
  if (!Array.isArray(locs) || !locs.every(l => typeof l?.id === "string" && typeof l?.level === "number")) throw new ProviderError("VedaWeb", "bad_json", "locations response does not match the observed shape", loc.httpStatus);
  const base = { ...provenance("VedaWeb", "GET /api/locations + /api/contents", loc.httpStatus), text: { slug: t.slug, vedawebTextId: t.id, title: t.title }, requestedLocator: args.locator };
  if (locs.length === 0) return { ...base, status: "locator_not_found", passages: [], note: "VedaWeb has no location with this alias; no locator was guessed." };
  if (locs.length > 1) return { ...base, status: "ambiguous_locator", candidates: locs.map(l => ({ locationId: l.id, level: l.level, label: l.label, aliases: l.aliases ?? [] })), passages: [], note: "Several locations share this alias; none was chosen." };
  const L = locs[0];
  const all = (await resources(t.id, doFetch)).filter(r => r.resourceType === "plainText" && r.level === L.level && r.public !== false);
  const chosen = args.resource_ids?.length ? all.filter(r => args.resource_ids!.includes(r.id)) : (all.filter(r => r.config?.general?.defaultActive).slice(0, 3).concat(all.filter(r => !r.config?.general?.defaultActive)).slice(0, 3));
  if (!chosen.length) return { ...base, status: "no_text_resources_at_level", locationId: L.id, level: L.level, availableResources: all.map(r => ({ id: r.id, title: label(r) })), passages: [] };
  const cUrl = `${VEDAWEB_API}/contents?${chosen.map(r => `res=${r.id}`).join("&")}&location=${L.id}`;
  const c = await queryJson("VedaWeb", cUrl, doFetch, 20000);
  const rows = c.data as Array<{ id: string; resourceId: string; locationId: string; text?: string }>;
  if (!Array.isArray(rows) || !rows.every(r => typeof r?.id === "string" && typeof r?.resourceId === "string")) throw new ProviderError("VedaWeb", "bad_json", "contents response does not match the observed shape", c.httpStatus);
  const MAX = 4000;
  const passages = rows.map(r => { const res = chosen.find(x => x.id === r.resourceId)!; const text = typeof r.text === "string" ? r.text : ""; return {
    work: { vedawebTextId: t.id, slug: t.slug, title: t.title },
    witness: { resourceId: r.resourceId, title: res ? label(res) : null, resourceType: "plainText", citation: res?.citation ? res.citation.slice(0, 400) : null, kind: "electronic_edition_transcription", independentWitness: false },
    locator: { requested: args.locator, locationId: L.id, level: L.level, label: L.label, aliases: L.aliases ?? [] },
    text: text.slice(0, MAX), truncated: text.length > MAX, encoding: describeEncoding(text),
    provenance: { contentId: r.id, url: cUrl, providerUrl: "https://vedaweb.uni-koeln.de/", retrievedAt: new Date().toISOString() },
    retrieval: { status: "retrieved" },
    licensing: { status: "not_exposed_by_api", apiLicenseField: res?.license ?? null, note: "VedaWeb states a CC licence per source in the TEI header of the vedaweb-data repository; the API does not expose it. Cite the citation field; check the licence before reuse.", licenseSource: "https://github.com/VedaWebProject/vedaweb-data" } }; });
  return { ...base, status: passages.length ? "ok" : "no_contents", passages, resourcesOffered: all.map(r => ({ id: r.id, title: label(r), selected: chosen.some(x => x.id === r.id) })),
    note: "Electronic transcriptions of printed editions; variant orthography between resources is preserved, not normalized. Not independent manuscript witnesses." };
}
