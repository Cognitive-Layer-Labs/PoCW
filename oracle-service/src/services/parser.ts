import pdfParse from "pdf-parse";
import { JSDOM } from "jsdom";

/**
 * Parse content from a URL into plain text.
 * Supported parsers:
 * - PDF
 * - TXT
 * - Markdown (.md / .markdown)
 * - HTML
 * - YouTube transcript (HTTP transcript sources)
 * Transport:
 * - http / https
 * - ipfs
 * - youtube transcript only
 *
 * WS6: Errors propagate to the caller — no silent fallbacks.
 */
export async function parseContentToText(url: string): Promise<string> {
  if (!isValidUrl(url)) {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (isYouTube(url)) {
    return await parseYouTube(url);
  }

  if (isIPFS(url)) {
    url = normalizeIPFS(url);
  }

  // 3.5 — SSRF protection: block private/internal IP ranges
  blockPrivateIp(url);

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch content: ${url} (HTTP ${res.status})`);
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if (isBinary(contentType)) {
    throw new Error(`Unsupported binary content: ${url}`);
  }

  if (isPDF(contentType, url)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const parsePdf = pdfParse as unknown as (data: Buffer) => Promise<{ text: string }>;
    const pdf = await parsePdf(buffer);
    if (!pdf.text.trim()) {
      throw new Error("No text found in PDF — it may be image-only");
    }
    return truncate(cleanText(pdf.text));
  }

  if (isMarkdown(contentType, url)) {
    const text = await res.text();
    return truncate(text.replace(/\u0000/g, "").trim());
  }

  if (isText(contentType, url)) {
    const text = await res.text();
    return truncate(cleanText(text));
  }

  if (isHTML(contentType, url)) {
    const html = await res.text();
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";
    return truncate(cleanText(text));
  }

  throw new Error(`Unsupported content type: ${contentType}`);
}

/* ================= validation ================= */

/**
 * 3.5 — SSRF protection.
 * Throws if the URL resolves to a private/internal IP range.
 * Only called for http/https URLs (not IPFS, not raw text).
 */
function blockPrivateIp(rawUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return; // not a parseable URL — other validation will catch it
  }

  const privateRanges = [
    /^127\./,               // loopback
    /^10\./,               // RFC 1918 class A
    /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 class B
    /^192\.168\./,         // RFC 1918 class C
    /^169\.254\./,         // link-local / cloud metadata
    /^::1$/,               // IPv6 loopback
    /^fc00:/,              // IPv6 unique local
    /^fe80:/,              // IPv6 link-local
    /^0\./,                // 0.0.0.0/8
    /^localhost$/,
  ];

  if (privateRanges.some(r => r.test(hostname))) {
    throw new Error(`SSRF blocked: private/internal URL not allowed — ${rawUrl}`);
  }
}

function isValidUrl(value: string): boolean {
  try {
    if (value.startsWith("ipfs://")) {
      return value.length > 7;
    }
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/* ================= type detection ================= */

function isPDF(contentType: string, url: string): boolean {
  return contentType.includes("application/pdf") || url.endsWith(".pdf");
}

function isText(contentType: string, url: string): boolean {
  return contentType.includes("text/plain") || url.endsWith(".txt");
}

function isMarkdown(contentType: string, url: string): boolean {
  return (
    contentType.includes("text/markdown") ||
    url.endsWith(".md") ||
    url.endsWith(".markdown")
  );
}

function isHTML(contentType: string, url: string): boolean {
  return contentType.includes("text/html") || url.endsWith(".html");
}

function isBinary(contentType: string): boolean {
  return (
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("image/") ||
    contentType === "application/octet-stream"
  );
}

/* ================= helpers ================= */

function isYouTube(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

function isIPFS(url: string): boolean {
  return url.startsWith("ipfs://");
}

function normalizeIPFS(url: string): string {
  return url.replace("ipfs://", "https://ipfs.io/ipfs/");
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

function truncate(text: string, limit = 500_000): string {
  return text.slice(0, limit);
}

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

async function fetchTranscriptViaMirror(videoId: string): Promise<string | null> {
  try {
    const transcriptUrl = `https://youtubetranscript.com/?server_vid2=${videoId}`;
    const res = await fetch(transcriptUrl);
    if (!res.ok) {
      return null;
    }

    const html = await res.text();
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";
    const cleaned = truncate(cleanText(text));
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

    return truncate(cleanText(chunks.join(" ")));
  } catch {
    return null;
  }
}

function extractYouTubeId(url: string): string {
  const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
  if (!match) {
    throw new Error("Invalid YouTube URL");
  }
  return match[1];
}
