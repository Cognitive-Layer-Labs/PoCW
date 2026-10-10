import pdfParse from "pdf-parse";
import { JSDOM } from "jsdom";
import { safeFetchBuffer } from "./safe-fetch";
import { isEpub, parseEpub, EPUB_MIME, EpubError, xhtmlToText } from "./epub";
import { looksLikeZip, ZipError } from "./zip-reader";
import {
  MAX_TEXT_CHARS,
  DocumentMeta,
  PreparedText,
  prepareText,
  normalizeParagraphs,
  collapseWhitespace,
  truncateText,
  meaningfulMeta,
} from "./book-text";

/**
 * Parse content from a URL into plain text.
 * Supported parsers:
 * - EPUB (application/epub+zip, *.epub, or an octet-stream body that is an EPUB archive)
 * - PDF (text + Title/Author from the document info when meaningful)
 * - TXT (paragraphs kept, hard wraps joined)
 * - Markdown (.md / .markdown)
 * - HTML
 * - YouTube transcript (HTTP transcript sources)
 * Every result goes through prepareText(): Project Gutenberg license header/footer removed (its
 * Title/Author kept as metadata) and the text cut to MAX_TEXT_CHARS.
 * Transport: http / https only. Every fetch of a user-supplied URL goes through
 * safeFetch (SSRF protection: private/internal targets and redirects to them are blocked).
 *
 * WS6: Errors propagate to the caller — no silent fallbacks.
 */
export async function parseContentToText(url: string): Promise<string> {
  return (await parseSource(url)).text;
}

/**
 * Like parseContentToText, but also returns the HTML <title> tag for web pages.
 * Only call this when you need the title; use parseContentToText otherwise.
 */
export async function parseWebContentWithTitle(url: string): Promise<{ text: string; htmlTitle: string | null }> {
  const doc = await parseSource(url);
  return { text: doc.text, htmlTitle: doc.htmlTitle ?? null };
}

/** Parsed document: text plus whatever metadata the format carries. */
export interface ParsedDocument extends PreparedText {
  /** HTML <title> (web pages only). */
  htmlTitle?: string | null;
}

/** Largest download accepted for a URL source (books up to 40 MB, with headroom). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** HTML larger than this is converted without jsdom (see parseSource). */
const LARGE_HTML_CHARS = 1_000_000;
/** Whole-request time budget for URL sources (a 40 MB book on a slow host needs more than 30 s). */
const SOURCE_FETCH_TIMEOUT_MS = 120_000;

/** Fetch and parse any supported URL source (see parseContentToText). */
export async function parseSource(url: string): Promise<ParsedDocument> {
  const validationError = validateSourceUrl(url);
  if (validationError) {
    throw new Error(validationError);
  }

  if (isYouTube(url)) {
    return prepareText(await parseYouTube(url));
  }

  const res = await safeFetchBuffer(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: SOURCE_FETCH_TIMEOUT_MS });
  if (!res.ok) {
    throw new Error(`Failed to fetch content: ${url} (HTTP ${res.status})`);
  }

  const contentType = res.contentType;
  const pathname = urlPath(res.url) || urlPath(url);
  const body = res.body;

  const genericBinary = contentType.includes("application/octet-stream") || isZipLike(contentType);
  if (isEpubType(contentType, pathname) || (genericBinary && isEpub(body))) {
    return parseEpubBuffer(body);
  }
  if (genericBinary) {
    // Generic binary: accept only what the bytes prove to be a supported format.
    if (isPdfBytes(body)) return parsePdfBuffer(body);
    throw new Error(`Unsupported binary content: ${url}`);
  }
  if (isBinary(contentType)) {
    throw new Error(`Unsupported binary content: ${url}`);
  }

  if (isPDF(contentType, pathname)) {
    return parsePdfBuffer(body);
  }

  if (isMarkdown(contentType, pathname)) {
    return prepareText(decodeUtf8(body).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim());
  }

  if (isText(contentType, pathname)) {
    return prepareText(normalizeParagraphs(decodeUtf8(body)));
  }

  if (isHTML(contentType, pathname)) {
    const html = decodeUtf8(body);
    // Book-sized HTML (e.g. a Project Gutenberg "read online" page) skips the jsdom pass: a DOM for
    // megabytes of markup takes seconds and hundreds of MB of heap. The tag stripper used for EPUB
    // chapters drops scripts/styles/nav and keeps the text.
    const text = html.length > LARGE_HTML_CHARS ? xhtmlToText(html) : extractMainContent(html);
    return { ...prepareText(collapseWhitespace(text)), htmlTitle: extractHtmlTitle(html) };
  }

  throw new Error(`Unsupported content type: ${contentType}`);
}

/* ================= uploads ================= */

/** Upload rejected: `status` is the HTTP status to answer with (400, 415 or 422). */
export class UploadParseError extends Error {
  constructor(message: string, public readonly status: 400 | 415 | 422) {
    super(message);
    this.name = "UploadParseError";
  }
}

/**
 * Parse an uploaded file body:
 *   application/epub+zip                       → EPUB
 *   application/pdf                            → PDF
 *   application/octet-stream / application/zip → EPUB or PDF when the bytes say so, else UTF-8 text
 *   text/*                                     → UTF-8 text (text/markdown kept verbatim)
 */
export async function parseUpload(body: Buffer, contentType: string): Promise<PreparedText> {
  const ct = contentType.toLowerCase();
  if (ct.includes(EPUB_MIME) || (isZipLike(ct) && looksLikeZip(body))) {
    if (!isEpub(body)) {
      throw new UploadParseError("Not a valid EPUB file (missing application/epub+zip mimetype)", 422);
    }
    try {
      return parseEpubBuffer(body);
    } catch (err) {
      throw new UploadParseError(uploadMessage(err, "Could not parse EPUB"), 422);
    }
  }
  if (looksLikeZip(body) && isEpub(body)) {
    // e.g. sent as application/octet-stream
    try {
      return parseEpubBuffer(body);
    } catch (err) {
      throw new UploadParseError(uploadMessage(err, "Could not parse EPUB"), 422);
    }
  }
  if (ct.includes("pdf") || isPdfBytes(body)) {
    let doc: PreparedText;
    try {
      doc = await parsePdfBuffer(body);
    } catch (err) {
      if (err instanceof UploadParseError) throw err;
      throw new UploadParseError("Could not parse PDF", 422);
    }
    return doc;
  }
  if (body.subarray(0, 8192).includes(0)) {
    throw new UploadParseError("Binary file not supported — upload a PDF, an EPUB or a text file", 415);
  }
  const raw = decodeUtf8(body);
  const text = ct.includes("markdown")
    ? raw.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim()
    : normalizeParagraphs(raw);
  if (!text.trim()) {
    throw new UploadParseError("Uploaded file is empty", 400);
  }
  return prepareText(text);
}

function uploadMessage(err: unknown, fallback: string): string {
  return err instanceof EpubError || err instanceof ZipError ? err.message : fallback;
}

/* ================= format parsers ================= */

function parseEpubBuffer(body: Buffer): PreparedText {
  const epub = parseEpub(body);
  return prepareText(epub.text, { title: epub.title, author: epub.author });
}

type PdfParseResult = { text: string; info?: Record<string, unknown> };

async function parsePdfBuffer(body: Buffer): Promise<PreparedText> {
  const parsePdf = pdfParse as unknown as (data: Buffer) => Promise<PdfParseResult>;
  const pdf = await parsePdf(body);
  if (!pdf.text.trim()) {
    throw new UploadParseError("No text found in PDF — it may be image-only", 422);
  }
  const meta: DocumentMeta = {
    title: meaningfulMeta(pdf.info?.Title, "title"),
    author: meaningfulMeta(pdf.info?.Author, "author"),
  };
  return prepareText(collapseWhitespace(pdf.text), meta);
}

/**
 * UTF-8 decode, reading at most what MAX_TEXT_CHARS can need (3 bytes per character covers
 * every BMP script) so a 40 MB text upload never becomes a 40 M-character string.
 */
function decodeUtf8(body: Buffer): string {
  const maxBytes = MAX_TEXT_CHARS * 3 + 64 * 1024;
  const s = body.toString("utf8", 0, Math.min(body.length, maxBytes));
  // Keep generous headroom for the Gutenberg header/footer, which is stripped before the final cut.
  const text = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  return text.length > MAX_TEXT_CHARS + 200_000 ? truncateText(text, MAX_TEXT_CHARS + 200_000) : text;
}

/* ================= validation ================= */

function validateSourceUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return `Invalid URL: ${value}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Invalid URL: ${value}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL protocol: ${parsed.protocol}. Use http:// or https://`;
  }

  if (!parsed.hostname) {
    return `Invalid URL: ${value}`;
  }

  return null;
}

/* ================= type detection ================= */

/** Lower-cased URL path without query/fragment ("" when unparsable). */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isEpubType(contentType: string, pathname: string): boolean {
  return contentType.includes(EPUB_MIME) || pathname.endsWith(".epub");
}

function isZipLike(contentType: string): boolean {
  return contentType.includes("application/zip") || contentType.includes("application/x-zip");
}

function isPdfBytes(body: Buffer): boolean {
  return body.subarray(0, 5).toString("latin1") === "%PDF-";
}

function isPDF(contentType: string, pathname: string): boolean {
  return contentType.includes("application/pdf") || pathname.endsWith(".pdf");
}

function isText(contentType: string, pathname: string): boolean {
  return contentType.includes("text/plain") || pathname.endsWith(".txt");
}

function isMarkdown(contentType: string, pathname: string): boolean {
  return (
    contentType.includes("text/markdown") ||
    pathname.endsWith(".md") ||
    pathname.endsWith(".markdown")
  );
}

function isHTML(contentType: string, pathname: string): boolean {
  return contentType.includes("text/html") || pathname.endsWith(".html") || pathname.endsWith(".htm");
}

function isBinary(contentType: string): boolean {
  return (
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("image/")
  );
}

/* ================= helpers ================= */

function isYouTube(url: string): boolean {
  return isYouTubeStrict(url);
}

/**
 * Extract the HTML <title> tag value from a raw HTML string.
 * Returns null when absent or blank.
 */
export function extractHtmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() || null : null;
}

/**
 * Strict YouTube URL check — only returns true when the hostname is
 * youtube.com or youtu.be. Prevents false positives on Wikipedia, GitHub,
 * or any URL that happens to have an 11-character path segment.
 */
export function isYouTubeStrict(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const host = hostname.toLowerCase().replace(/^(www|m)\./, "");
    return host === "youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

/** Extract YouTube video ID from a confirmed YouTube URL. */
export function extractYouTubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/youtube\.com\/embed\/([\w-]{11})/) ||
    url.match(/youtube\.com\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * Re-derive a human-readable title for any indexed URL.
 * Uses LLM for web pages, oEmbed for YouTube.
 * Suitable for patching already-indexed entries that have stale/wrong titles.
 */
export async function rederiveTitle(source: string, existingText?: string): Promise<string | null> {
  try {
    if (isYouTubeStrict(source)) {
      const videoId = extractYouTubeId(source);
      if (videoId) {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (res.ok) {
          const data = await res.json() as { title?: string };
          if (data.title) return data.title;
        }
      }
      return null; // YouTube but oEmbed failed
    }

    // Re-fetch: books carry their own title (EPUB/PDF metadata, Gutenberg header).
    const parsed = await parseSource(source);
    if (parsed.title) return parsed.title;
    const text = existingText ?? parsed.text;

    // Call LLM (dynamic import to avoid circular deps from sdk/index.ts)
    const { getOpenAIClient } = await import("./llm-client");
    const snippet = text.slice(0, 4000);
    const prompt = [
      "Given the following information about a web page, provide a concise accurate title (under 120 characters). Reply with ONLY the title — no quotes, no explanation.",
      `URL: ${source}`,
      parsed.htmlTitle ? `HTML <title>: ${parsed.htmlTitle}` : null,
      `Content excerpt:\n${snippet}`,
    ].filter(Boolean).join("\n");

    const completion = await getOpenAIClient().chat.completions.create({
      model: "google/gemini-2.5-flash",
      max_tokens: 80,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    const result = (completion.choices[0]?.message?.content ?? "").trim();
    if (result.length > 5 && result.length < 200) return result;

    // LLM gave nothing useful — fall through to htmlTitle or first line
    if (parsed.htmlTitle && parsed.htmlTitle.length > 5) return parsed.htmlTitle.slice(0, 200);
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    return lines[0]?.slice(0, 200) || null;
  } catch {
    return null;
  }
}

/**
 * Extract main article content from HTML, removing all navigation/UI boilerplate.
 * Strategy:
 *   1. Remove known noise elements (nav, footer, sidebars, scripts, ads, Wikipedia UI).
 *   2. Find the best main content container (article, main, #bodyContent, etc.).
 *   3. Fall back to cleaned body if nothing specific found.
 */
function extractMainContent(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Remove all noise elements before extracting any text
  const noiseSelectors = [
    "script", "style", "noscript", "iframe",
    "nav", "header", "footer", "aside",
    // Wikipedia-specific
    "#mw-navigation", "#mw-head", "#mw-panel", "#footer", "#catlinks",
    ".navbox", ".navbox-inner", ".navbox-title",
    ".sidebar", ".mw-portlet", ".mw-indicators",
    ".reflist", ".references", ".reference",
    "#toc", ".toc",
    ".hatnote", ".ambox", ".tmbox", ".ombox",
    // General boilerplate
    "[role=navigation]", "[role=banner]", "[role=contentinfo]",
    ".cookie-notice", ".cookie-banner", ".gdpr",
    ".advertisement", ".ad", ".ads",
    ".related-articles", ".recommended",
    ".share-buttons", ".social-share",
    ".breadcrumb", ".pagination",
    ".comments", "#comments",
  ];

  for (const sel of noiseSelectors) {
    try {
      doc.querySelectorAll(sel).forEach((el: Element) => el.remove());
    } catch { /* ignore invalid selectors */ }
  }

  // Try to find the main content region in priority order
  const mainSelectors = [
    // Wikipedia
    "#mw-content-text",
    "#bodyContent",
    // Semantic HTML5
    "main",
    "article",
    // Common CMS/blog patterns
    "#content",
    "#main-content",
    "#article-body",
    ".article-content",
    ".post-content",
    ".entry-content",
    "[role=main]",
  ];

  for (const sel of mainSelectors) {
    try {
      const el = doc.querySelector(sel);
      if (el) {
        const text = (el as HTMLElement).textContent || "";
        if (text.trim().length > 200) return text;
      }
    } catch { /* ignore */ }
  }

  return doc.body?.textContent || "";
}

const cleanText = collapseWhitespace;
const truncate = (text: string): string => truncateText(text);

/**
 * Split text into overlapping chunks for large documents.
 * Each chunk is ~chunkSize chars with `overlap` chars of overlap
 * to preserve context at boundaries.
 */
export function chunkText(text: string, chunkSize = 4000, overlap = 500): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

/* ================= YouTube ================= */

/**
 * Parse YouTube captions without loading ESM/CJS-dependent libraries at runtime.
 * Throws explicitly when captions are unavailable.
 */
async function parseYouTube(url: string): Promise<string> {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error(`Could not extract YouTube video ID from: ${url}`);

  // Most reliable server-side path: InnerTube captionTracks.
  const innerTubeText = await fetchTranscriptViaInnerTube(videoId);
  if (innerTubeText) {
    return innerTubeText;
  }

  // First try the dedicated transcript library via explicit ESM entrypoint.
  // The package's default entry can break in CJS runtimes due packaging metadata.
  const packageText = await fetchTranscriptViaYoutubeTranscriptEsm(videoId);
  if (packageText) {
    return packageText;
  }

  // Fast path used in tests and many production cases.
  const mirrorText = await fetchTranscriptViaMirror(videoId);
  if (mirrorText) {
    return mirrorText;
  }

  // Fallback to YouTube timedtext API if the mirror is unavailable.
  const timedText = await fetchTranscriptViaYouTubeTimedText(videoId);
  if (timedText) {
    return timedText;
  }

  throw new Error(
    `YouTube transcript unavailable for video ${videoId} — only videos with captions are supported`
  );
}

type YoutubeTranscriptRow = {
  text?: string;
};

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

type InnerTubeResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
};

type YoutubeTranscriptModule = {
  YoutubeTranscript?: {
    fetchTranscript: (videoId: string) => Promise<YoutubeTranscriptRow[]>;
  };
};

const dynamicImport = new Function(
  "specifier",
  "return import(specifier)"
) as (specifier: string) => Promise<unknown>;

const YOUTUBE_ANDROID_CLIENT_VERSION = "20.10.38";
const YOUTUBE_ANDROID_UA =
  `com.google.android.youtube/${YOUTUBE_ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;
const YOUTUBE_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)";

function selectCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;

  return (
    tracks.find((track) => track.languageCode === "en" && track.kind !== "asr") ||
    tracks.find((track) => track.languageCode === "en") ||
    tracks.find((track) => track.kind !== "asr") ||
    tracks[0]
  );
}

function parseYouTubeTranscriptXml(xml: string): string | null {
  const dom = new JSDOM(xml, { contentType: "text/xml" });

  // Legacy timedtext format.
  const textNodes = Array.from(dom.window.document.querySelectorAll("text"))
    .map((node) => (node.textContent || "").replace(/\n/g, " ").trim())
    .filter(Boolean);

  if (textNodes.length > 0) {
    const candidate = cleanText(textNodes.join(" "));
    if (!candidate || isBlockedTranscriptPayload(candidate)) {
      return null;
    }
    return truncate(candidate);
  }

  // Timedtext format=3 uses <p><s>...</s></p> segments.
  const paragraphNodes = Array.from(dom.window.document.querySelectorAll("p"));
  if (paragraphNodes.length === 0) {
    return null;
  }

  const chunks = paragraphNodes
    .map((paragraph) => {
      const spanChunks = Array.from(paragraph.querySelectorAll("s"))
        .map((span) => (span.textContent || "").replace(/\n/g, " ").trim())
        .filter(Boolean);

      if (spanChunks.length > 0) {
        return spanChunks.join(" ");
      }

      return (paragraph.textContent || "").replace(/\n/g, " ").trim();
    })
    .filter(Boolean);

  if (chunks.length === 0) {
    return null;
  }

  const candidate = cleanText(chunks.join(" "));
  if (!candidate || isBlockedTranscriptPayload(candidate)) {
    return null;
  }

  return truncate(candidate);
}

async function fetchTranscriptViaInnerTube(videoId: string): Promise<string | null> {
  if (process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK === "1") {
    return null;
  }

  try {
    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": YOUTUBE_ANDROID_UA,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: YOUTUBE_ANDROID_CLIENT_VERSION,
            },
          },
          videoId,
        }),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as InnerTubeResponse;
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return null;
    }

    const selectedTrack = selectCaptionTrack(tracks);
    const baseUrl = selectedTrack?.baseUrl;
    if (!baseUrl) {
      return null;
    }

    const transcriptResponse = await fetch(baseUrl, {
      headers: {
        "User-Agent": YOUTUBE_BROWSER_UA,
      },
    });

    if (!transcriptResponse.ok) {
      return null;
    }

    const transcriptXml = await transcriptResponse.text();
    return parseYouTubeTranscriptXml(transcriptXml);
  } catch {
    return null;
  }
}

async function fetchTranscriptViaYoutubeTranscriptEsm(videoId: string): Promise<string | null> {
  if (process.env.POCW_SKIP_YT_PKG_FALLBACK === "1") {
    return null;
  }

  try {
    const mod = (await dynamicImport(
      "youtube-transcript/dist/youtube-transcript.esm.js"
    )) as YoutubeTranscriptModule;

    const fetchTranscript = mod?.YoutubeTranscript?.fetchTranscript;
    if (typeof fetchTranscript !== "function") {
      return null;
    }

    const rows = await fetchTranscript(videoId);
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const candidate = cleanText(
      rows
        .map((row) => (typeof row?.text === "string" ? row.text : ""))
        .join(" ")
    );

    if (!candidate || isBlockedTranscriptPayload(candidate)) {
      return null;
    }

    return truncate(candidate);
  } catch {
    return null;
  }
}

const YOUTUBE_BLOCK_PATTERNS: RegExp[] = [
  /youtube\s+is\s+currently\s+blocking\s+us\s+from\s+fetching\s+subtitles/i,
  /preventing\s+us\s+from\s+generating\s+a\s+summary/i,
  /we'?re\s+working\s+on\s+a\s+fix/i,
  /video\s+unavailable/i,
  /sign\s+in\s+to\s+confirm\s+your\s+age/i,
  /this\s+video\s+is\s+private/i,
  /captions\s+are\s+not\s+available/i,
];

function isBlockedTranscriptPayload(text: string): boolean {
  const normalized = cleanText(text);
  if (!normalized) {
    return true;
  }
  return YOUTUBE_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function fetchTranscriptViaMirror(videoId: string): Promise<string | null> {
  try {
    const transcriptUrl = `https://youtubetranscript.com/?server_vid2=${videoId}`;
    const res = await fetch(transcriptUrl);
    if (!res.ok) {
      return null;
    }

    const raw = await res.text();

    // Most mirror responses are XML transcripts. Prefer explicit <text> nodes.
    const xmlDom = new JSDOM(raw, { contentType: "text/xml" });
    const xmlChunks = Array.from(xmlDom.window.document.querySelectorAll("text"))
      .map((node) => (node.textContent || "").replace(/\n/g, " ").trim())
      .filter(Boolean);

    let candidate = "";
    if (xmlChunks.length > 0) {
      candidate = cleanText(xmlChunks.join(" "));
    } else {
      const htmlDom = new JSDOM(raw);
      candidate = cleanText(htmlDom.window.document.body.textContent || "");
    }

    if (isBlockedTranscriptPayload(candidate)) {
      return null;
    }

    const cleaned = truncate(candidate);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

async function fetchTranscriptViaYouTubeTimedText(videoId: string): Promise<string | null> {
  try {
    const listUrl = `https://video.google.com/timedtext?type=list&v=${videoId}`;
    const listRes = await fetch(listUrl);
    if (!listRes.ok) {
      return null;
    }

    const listXml = await listRes.text();
    const listDom = new JSDOM(listXml, { contentType: "text/xml" });
    const trackEls = Array.from(listDom.window.document.querySelectorAll("track"));

    if (trackEls.length === 0) {
      return null;
    }

    const preferred = trackEls.find(t => t.getAttribute("lang_code") === "en") || trackEls[0];
    const lang = preferred.getAttribute("lang_code");
    if (!lang) {
      return null;
    }

    const name = preferred.getAttribute("name") || "";
    const params = new URLSearchParams({ v: videoId, lang, fmt: "srv3" });
    if (name) {
      params.set("name", name);
    }

    const transcriptUrl = `https://video.google.com/timedtext?${params.toString()}`;
    const transcriptRes = await fetch(transcriptUrl);
    if (!transcriptRes.ok) {
      return null;
    }

    const transcriptXml = await transcriptRes.text();
    const transcriptDom = new JSDOM(transcriptXml, { contentType: "text/xml" });
    const chunks = Array.from(transcriptDom.window.document.querySelectorAll("text"))
      .map(node => (node.textContent || "").replace(/\n/g, " ").trim())
      .filter(Boolean);

    if (chunks.length === 0) {
      return null;
    }

    const candidate = cleanText(chunks.join(" "));
    if (isBlockedTranscriptPayload(candidate)) {
      return null;
    }

    return truncate(candidate);
  } catch {
    return null;
  }
}

// extractYouTubeId is now exported above (strict version that returns string | null)
