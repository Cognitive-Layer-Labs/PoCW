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
  const validationError = validateSourceUrl(url);
  if (validationError) {
    throw new Error(validationError);
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

function validateSourceUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return `Invalid URL: ${value}`;
  }

  if (trimmed.startsWith("ipfs://")) {
    const remainder = trimmed.slice("ipfs://".length).trim();
    if (!remainder || remainder.startsWith("/") || /\s/.test(remainder)) {
      return "Invalid IPFS URL. Use ipfs://<CID>[/path]";
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Invalid URL: ${value}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL protocol: ${parsed.protocol}. Use http://, https://, or ipfs://`;
  }

  if (!parsed.hostname) {
    return `Invalid URL: ${value}`;
  }

  return null;
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

function extractYouTubeId(url: string): string {
  const match = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
  if (!match) {
    throw new Error("Invalid YouTube URL");
  }
  return match[1];
}
