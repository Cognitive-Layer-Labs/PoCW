import pdfParse from "pdf-parse";
import { JSDOM } from "jsdom";

/**
 * Parse content from a URL into plain text.
 * Supported real parsers:
 * - PDF
 * - TXT
 * - HTML
 * Transport:
 * - http / https
 * - ipfs
 * - youtube transcript only
 */
export async function parseContentToText(url: string): Promise<string> {
  try {
    if (!isValidUrl(url)) {
      return `Invalid URL: ${url}`;
    }

    if (isYouTube(url)) {
      return await parseYouTube(url);
    }

    if (isIPFS(url)) {
      url = normalizeIPFS(url);
    }

    const res = await fetch(url);

    if (!res.ok) {
      return `Failed to fetch content: ${url}`;
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    if (isBinary(contentType)) {
      return `Unsupported binary content: ${url}`;
    }

    if (isPDF(contentType, url)) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const parsePdf = pdfParse as unknown as (data: Buffer) => Promise<{ text: string }>;
      const pdf = await parsePdf(buffer);
      return truncate(cleanText(pdf.text));
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

    return `Unsupported content type: ${contentType}`;
  } catch {
    return `Content reference: ${url}`;
  }
}

/* ================= validation ================= */

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

async function parseYouTube(url: string): Promise<string> {
  try {
    const videoId = extractYouTubeId(url);
    const transcriptUrl =
      `https://youtubetranscript.com/?server_vid2=${videoId}`;

    const res = await fetch(transcriptUrl);

    if (!res.ok) {
      return `YouTube video reference: ${url}`;
    }

    const html = await res.text();
    const dom = new JSDOM(html);
    const text = dom.window.document.body.textContent || "";

    return truncate(cleanText(text));
  } catch {
    return `YouTube video reference: ${url}`;
  }
}

function extractYouTubeId(url: string): string {
  const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
  if (!match) {
    throw new Error("Invalid YouTube URL");
  }
  return match[1];
}
