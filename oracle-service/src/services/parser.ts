import pdfParse from "pdf-parse";
import { JSDOM } from "jsdom";

/**
 * Parse content from a URL into plain text.
 * Supported parsers:
 * - PDF
 * - TXT
 * - Markdown (.md / .markdown)
 * - HTML
 * - YouTube transcript (via youtube-transcript package)
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
 * WS6: Use the youtube-transcript package instead of brittle JSDOM scraping.
 * Throws explicitly when captions are unavailable.
 */
async function parseYouTube(url: string): Promise<string> {
  const videoId = extractYouTubeId(url);

  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      throw new Error(
        `YouTube transcript unavailable for video ${videoId} — only videos with captions are supported`
      );
    }

    const text = transcript.map((entry: { text: string }) => entry.text).join(" ");
    return truncate(cleanText(text));
  } catch (err) {
    if (err instanceof Error && err.message.includes("youtube-transcript")) {
      throw err;
    }
    throw new Error(
      `YouTube transcript unavailable for video ${videoId} — only videos with captions are supported`
    );
  }
}

function extractYouTubeId(url: string): string {
  const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
  if (!match) {
    throw new Error("Invalid YouTube URL");
  }
  return match[1];
}
