/** Unified witness discovery. Combines Pandit title resolution, SETI e-text links, Pandit relations, Internet Archive
 *  printed-book scans and VedaWeb text availability. Every item is typed by what it IS, and none is called an independent
 *  manuscript witness: electronic transcriptions and scans of printed books derive from printed editions. */
import { ProviderError, provenance, type FetchLike } from "./providers";
import { findWorks, workRelations, worksIndex, PANDIT_NODE, parseLabel, scanIndex, type Candidate } from "./pandit";
import { setiByWork, type SetiCollection } from "./providers";
import { splitQuery, foldCompact } from "./normalize";
import { searchArchive } from "./archive";
import { vedawebTexts } from "./vedaweb";

export type WitnessKind = "physical_manuscript" | "printed_edition_scan" | "reprint_scan" | "electronic_transcription" | "ocr_derivative" | "catalogue_record";
export type Independence = { established: false; status: "unknown" | "not_applicable"; reason: string };
const NOT_MS = "Not a manuscript witness. Derived from a printed edition or another transcription; independence from other witnesses is not established.";
const indep = (reason = NOT_MS): Independence => ({ established: false, status: "unknown", reason });

const fail = (e: unknown) => e instanceof ProviderError ? { status: e.kind === "unavailable" ? "provider_unavailable" : "provider_error", kind: e.kind, httpStatus: e.httpStatus ?? null, message: e.message } : { status: "provider_error", kind: "internal", httpStatus: null, message: String((e as Error)?.message ?? e).slice(0, 200) };

export async function findWitnesses(args: { query?: string; work_id?: number; locus?: string; include_archive?: boolean }, doFetch: FetchLike = fetch) {
  if ((args.query == null) === (args.work_id == null)) throw new RangeError("provide exactly one of query or work_id");
  const providerStatus: Record<string, unknown> = {};
  let query = args.query ?? ""; let candidates: Candidate[] = []; let resolution: unknown = null; let ambiguity: unknown = null; let resolved: Candidate[] = [];
  if (args.work_id != null) {
    try {
      const idx = await worksIndex(doFetch);
      const m = new RegExp(`\\{"id":\\s*"${args.work_id}",\\s*"label":\\s*"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"\\}`).exec(idx.text);
      const rec = m ? JSON.parse(m[0]) : null; const pr = rec ? parseLabel(rec.id, rec.label) : null;
      if (pr) { query = pr.title; resolved = [{ rank: 1, panditWorkId: pr.id, title: pr.title, alternativeTitles: pr.alternativeTitles, annotations: pr.annotations, score: 1, confidence: "high", matchBasis: [{ part: String(args.work_id), role: "single", basis: "work_id_supplied", matchedOn: "title", lossy: false }], partial: false, providerUrl: PANDIT_NODE + pr.id, ambiguousWith: [], providerRecord: { id: pr.id, label: pr.label } }]; }
      else resolution = { status: "work_id_not_in_pandit", workId: args.work_id };
      providerStatus.panditIndex = { status: "ok" };
    } catch (e) { providerStatus.panditIndex = fail(e); }
  } else {
    try { const r = await findWorks(query, { limit: 8 }, doFetch); candidates = r.candidates; ambiguity = r.ambiguity; resolution = { status: r.status, totalMatched: r.totalMatched, commentaryNameOnlyMatches: r.commentaryNameOnlyMatches, note: r.note }; providerStatus.panditIndex = { status: "ok", indexFetchedAt: r.indexFetchedAt }; resolved = candidates.filter(c => c.confidence !== "low" && !c.partial).slice(0, 3); }
    catch (e) { providerStatus.panditIndex = fail(e); }
  }
  const { parts } = query ? splitQuery(query) : { parts: [] };
  const ids = resolved.map(c => Number(c.panditWorkId));

  const [seti, rels, ia, vw] = await Promise.allSettled([
    ids.length ? setiByWork(ids, doFetch) : Promise.resolve(null),
    Promise.all(resolved.map(c => workRelations(c.panditWorkId, doFetch).catch(e => ({ workId: c.panditWorkId, error: fail(e) })))),
    args.include_archive !== false && parts.length ? searchArchive(parts[0], parts[1], 8, doFetch) : Promise.resolve(null),
    vedawebTexts(doFetch)
  ]);

  const witnesses: Array<Record<string, unknown>> = [];
  for (const c of resolved) witnesses.push({ kind: "catalogue_record" satisfies WitnessKind, source: "Pāṇḍitya / Pandit Project", providerRecordId: c.panditWorkId, title: c.title, url: c.providerUrl, workId: c.panditWorkId, independentWitness: indep("A catalogue record of the work, not a text."), locusAccess: "none" });
  if (seti.status === "fulfilled" && seti.value) {
    providerStatus.seti = { status: seti.value.status, httpStatus: seti.value.httpStatus };
    for (const w of seti.value.works) for (const col of w.collections as SetiCollection[]) for (const l of col.links)
      witnesses.push({ kind: "electronic_transcription" satisfies WitnessKind, source: `SETI → ${col.collection}`, providerRecordId: `${w.workId}:${col.collection}`, workId: String(w.workId), title: w.label, url: l.url, format: l.format, collection: col.collection,
        independentWitness: indep(), underlyingEdition: "not stated by SETI", locusAccess: "locate the chapter inside the linked electronic text; the provider gives no passage index" });
  } else if (seti.status === "rejected") providerStatus.seti = fail(seti.reason); else providerStatus.seti = { status: "not_queried", reason: "no resolved work id" };
  if (ia.status === "fulfilled" && ia.value) {
    providerStatus.internetArchive = { status: ia.value.status, httpStatus: ia.value.httpStatus, numFound: (ia.value as { numFound?: number }).numFound };
    for (const it of (ia.value as { items: Array<Record<string, any>> }).items) {
      const reprint = /reprint|repr\./i.test(`${it.title} ${it.publisher}`);
      witnesses.push({ kind: (reprint ? "reprint_scan" : "printed_edition_scan") satisfies WitnessKind, source: "Internet Archive", providerRecordId: it.identifier, title: it.title, creator: it.creator, date: it.date, url: it.detailsUrl, licenseUrl: it.licenseUrl,
        commentaryTermInMetadata: it.commentaryTermInMetadata, independentWitness: indep("A scan of a printed book; its text tradition is that of the printed edition."),
        derivatives: [{ kind: "ocr_derivative", status: "not_verified", note: "Archive.org usually generates OCR text; not checked for this item. OCR is not authoritative." }],
        editionRole: "not stated by provider (edition, translation or study)", locusAccess: "open the scan and find the chapter by page; no chapter index from the provider" });
    }
  } else if (ia.status === "rejected") providerStatus.internetArchive = fail(ia.reason); else providerStatus.internetArchive = { status: "not_queried" };
  if (vw.status === "fulfilled") {
    const keys = [...resolved.map(c => foldCompact(c.title)), ...parts.flatMap(p => p.norm.foldedKeys)];
    for (const t of vw.value) if (keys.includes(foldCompact(t.title))) witnesses.push({ kind: "electronic_transcription" satisfies WitnessKind, source: "VedaWeb", providerRecordId: t.id, title: t.title, url: `https://vedaweb.uni-koeln.de/`, independentWitness: indep(), passageAccess: { tool: "read_passage", text: t.slug }, locusAccess: "read_passage supports stanza-level retrieval" });
    providerStatus.vedaweb = { status: "ok" };
  } else providerStatus.vedaweb = fail(vw.reason);

  const relations = rels.status === "fulfilled" ? rels.value : [];
  if (rels.status === "rejected") providerStatus.panditRelations = fail(rels.reason);
  const kinds = [...new Set(witnesses.map(w => w.kind as string))];
  const outages = Object.entries(providerStatus).filter(([, v]) => /provider_/.test(JSON.stringify(v))).map(([k]) => k);
  return {
    ...provenance("Atlas Scholarly Sources (aggregate)", "find_witnesses", null),
    status: witnesses.length ? (outages.length ? "partial" : "ok") : outages.length ? "providers_failed" : "no_witnesses_found",
    query: { submitted: args.query ?? null, workId: args.work_id ?? null, locus: args.locus ?? null }, workResolution: { ...(resolution as object | null), candidates, ambiguity, usedForWitnessSearch: resolved.map(c => c.panditWorkId) },
    witnesses, relations, kindsPresent: kinds,
    manuscripts: { status: "no_supported_provider", physicalManuscriptWitnessesFound: 0,
      note: "No stable public programmatic manuscript-catalogue API is available to this service (Pandit Project pages block automated clients). No physical manuscript was identified; this is a limit of the providers, not evidence none exists.",
      leads: [{ name: "Pandit Project", url: "https://www.panditproject.org/" }, { name: "Muktabodha digital library", url: "https://muktabodha.org/digital-library/" }] },
    locus: args.locus ? { requested: args.locus, note: "Providers give no chapter-level index except VedaWeb. Each witness lists how the locus can be reached; none was checked for the locus." } : null,
    independence: { established: false, note: "No witness here is shown to be independent of another. Electronic transcriptions and scans derive from printed editions." },
    providerStatus
  };
}
