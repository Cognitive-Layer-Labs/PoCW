/**
 * EPUB (2 and 3) → plain text + title/author.
 *
 * container.xml → OPF (metadata, manifest, spine) → spine documents in reading order → text.
 * container.xml and the OPF are small XML files and go through jsdom's XML parser. Spine
 * documents (XHTML) are converted with a lightweight tag stripper instead of jsdom: whole books
 * can ship as one multi-megabyte XHTML file, and building a DOM for that is both slow and several
 * hundred MB of heap (the engine container has 768 MB).
 *
 * Paragraphs within a chapter are separated by "\n", chapters (spine documents) by "\n\n".
 * Navigation documents, the NCX, scripts, styles, SVG/MathML and non-linear spine items are skipped.
 */

import { JSDOM } from "jsdom";
import * as path from "path";
import { listZipEntries, readZipEntry, newZipBudget, looksLikeZip, ZipEntry, ZipBudget } from "./zip-reader";
import { DocumentMeta, meaningfulMeta } from "./book-text";

export const EPUB_MIME = "application/epub+zip";

/** Size caps per decompressed file (on top of the archive-wide ZipBudget). */
const MAX_XML_BYTES = 4 * 1024 * 1024;     // container.xml, OPF
const MAX_DOC_BYTES = 24 * 1024 * 1024;    // one spine document

const DC_NS = "http://purl.org/dc/elements/1.1/";
const OPF_NS = "http://www.idpf.org/2007/opf";

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubError";
  }
}

export interface EpubDocument extends DocumentMeta {
  text: string;
  /** Number of spine documents that contributed text. */
  chapters: number;
}

/** True when `buf` is a ZIP whose `mimetype` entry is application/epub+zip. */
export function isEpub(buf: Buffer): boolean {
  if (!looksLikeZip(buf)) return false;
  // Fast path (OCF: first entry is an uncompressed "mimetype" file without extra field).
  if (buf.length >= 58 && buf.readUInt16LE(26) === 8 && buf.readUInt16LE(28) === 0
      && buf.toString("latin1", 30, 38) === "mimetype") {
    return buf.toString("latin1", 38, 58) === EPUB_MIME;
  }
  try {
    const entry = listZipEntries(buf).find(e => e.name === "mimetype");
    if (!entry) return false;
    return readZipEntry(buf, entry, newZipBudget(1024), 1024).toString("latin1").trim() === EPUB_MIME;
  } catch {
    return false;
  }
}

function decodeText(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.toString("utf16le", 2);
  const s = data.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseXml(xml: string, what: string): Document {
  try {
    return new JSDOM(xml, { contentType: "application/xml" }).window.document;
  } catch {
    throw new EpubError(`Invalid EPUB: malformed ${what}`);
  }
}

/** Elements by namespace + local name, falling back to the plain tag name (namespace-less OPFs). */
function elements(doc: Document | Element, ns: string, local: string): Element[] {
  const byNs = Array.from(doc.getElementsByTagNameNS(ns, local));
  return byNs.length > 0 ? byNs : Array.from(doc.getElementsByTagName(local));
}

function creatorNames(opf: Document): string[] {
  const creators = elements(opf, DC_NS, "creator");
  const metas = Array.from(opf.getElementsByTagName("meta"));
  const roleOf = (el: Element): string | null => {
    const legacy = el.getAttributeNS(OPF_NS, "role") || el.getAttribute("opf:role");
    if (legacy) return legacy.trim().toLowerCase();
    const id = el.getAttribute("id");
    if (!id) return null;
    const refine = metas.find(m => m.getAttribute("refines") === `#${id}` && m.getAttribute("property") === "role");
    return refine?.textContent?.trim().toLowerCase() || null;
  };
  const named = creators
    .map(el => ({ name: (el.textContent ?? "").replace(/\s+/g, " ").trim(), role: roleOf(el) }))
    .filter(c => c.name);
  const authors = named.filter(c => c.role === "aut");
  const chosen = authors.length > 0 ? authors : named.filter(c => c.role === null || c.role === "aut");
  return (chosen.length > 0 ? chosen : named).map(c => c.name);
}

// ─── XHTML → text ────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", shy: "", ensp: " ", emsp: " ",
  thinsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", sect: "§", para: "¶",
  dagger: "†", Dagger: "‡", times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
  pound: "£", euro: "€", cent: "¢", yen: "¥", iexcl: "¡", iquest: "¿", prime: "′", Prime: "″",
  aelig: "æ", AElig: "Æ", oelig: "œ", OElig: "Œ", szlig: "ß", ccedil: "ç", Ccedil: "Ç",
  eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", euml: "ë", aacute: "á",
  agrave: "à", acirc: "â", auml: "ä", Auml: "Ä", aring: "å", iacute: "í", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", Ouml: "Ö", oslash: "ø", uacute: "ú",
  ugrave: "ù", ucirc: "û", uuml: "ü", Uuml: "Ü", ntilde: "ñ", Ntilde: "Ñ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

const SKIP_ELEMENTS = "script|style|nav|head|svg|math|noscript|template";
const BLOCK_ELEMENTS =
  "p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|blockquote|section|article|header|footer|" +
  "aside|figure|figcaption|pre|hr|title|caption|address|center|body";

/** XHTML/HTML chapter → plain text, one paragraph per line. */
export function xhtmlToText(html: string): string {
  let s = html;
  const body = s.search(/<body[\s>]/i);
  if (body >= 0) s = s.slice(body);
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(new RegExp(`<(?:${SKIP_ELEMENTS})\\b[^>]*\\/>`, "gi"), " ")           // self-closing
    .replace(new RegExp(`<(${SKIP_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(new RegExp(`<\\/?(?:${BLOCK_ELEMENTS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(s)
    .replace(/­/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ─── EPUB ────────────────────────────────────────────────────────────────────

/** Parse an EPUB archive held in memory. Throws EpubError / ZipError on invalid input. */
export function parseEpub(buf: Buffer): EpubDocument {
  const entries = listZipEntries(buf);
  const byName = new Map<string, ZipEntry>();
  const byLower = new Map<string, ZipEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
    byLower.set(e.name.toLowerCase(), e);
  }
  const budget: ZipBudget = newZipBudget();
  const read = (name: string, max: number): Buffer | null => {
    const entry = byName.get(name) ?? byLower.get(name.toLowerCase());
    return entry ? readZipEntry(buf, entry, budget, max) : null;
  };

  const containerXml = read("META-INF/container.xml", MAX_XML_BYTES);
  if (!containerXml) throw new EpubError("Invalid EPUB: META-INF/container.xml is missing");
  const container = parseXml(decodeText(containerXml), "container.xml");
  const rootfiles = Array.from(container.getElementsByTagName("rootfile"));
  const rootfile = rootfiles.find(r => r.getAttribute("media-type") === "application/oebps-package+xml") ?? rootfiles[0];
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new EpubError("Invalid EPUB: no package document in container.xml");

  const opfXml = read(opfPath, MAX_XML_BYTES);
  if (!opfXml) throw new EpubError(`Invalid EPUB: package document ${opfPath} is missing`);
  const opf = parseXml(decodeText(opfXml), "package document");

  const title = meaningfulMeta(elements(opf, DC_NS, "title")[0]?.textContent ?? undefined, "title");
  const creators = creatorNames(opf);
  const author = meaningfulMeta(
    creators.length > 3 ? `${creators.slice(0, 3).join(", ")} et al.` : creators.join(", "),
    "author",
  );

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of elements(opf, OPF_NS, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) {
      manifest.set(id, {
        href,
        mediaType: (item.getAttribute("media-type") ?? "").toLowerCase(),
        properties: item.getAttribute("properties") ?? "",
      });
    }
  }

  const baseDir = path.posix.dirname(opfPath);
  const chapters: string[] = [];
  for (const ref of elements(opf, OPF_NS, "itemref")) {
    if ((ref.getAttribute("linear") ?? "yes").toLowerCase() === "no") continue;
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item) continue;
    if (!/^(application\/xhtml\+xml|text\/html|application\/xml|text\/xml)$/.test(item.mediaType)) continue;
    if (/\bnav\b/.test(item.properties)) continue;
    let href = item.href.split("#")[0];
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    const docPath = path.posix.normalize(baseDir === "." ? href : path.posix.join(baseDir, href));
    const data = read(docPath, MAX_DOC_BYTES);
    if (!data) continue;
    const text = xhtmlToText(decodeText(data));
    if (text) chapters.push(text);
  }

  const text = chapters.join("\n\n");
  if (!text.trim()) throw new EpubError("No text found in EPUB (it may contain only images)");
  return { text, title, author, chapters: chapters.length };
}
