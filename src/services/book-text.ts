/**
 * Book-scale text helpers shared by every source type (URL, upload, raw text):
 * size limit, whitespace normalisation, Project Gutenberg boilerplate removal and
 * title/author sanity checks.
 */

/**
 * Maximum characters kept per document (after boilerplate removal). Sized for whole novels:
 * Moby-Dick ≈ 1.2 M characters, War and Peace ≈ 3.2 M. 4 M characters is ~4–8 MB as a JS string
 * (one- vs two-byte encoding); longer texts are cut at the limit.
 */
export const MAX_TEXT_CHARS = 4_000_000;

export interface DocumentMeta {
  title?: string;
  author?: string;
}

export interface PreparedText extends DocumentMeta {
  text: string;
}

/** Cut to MAX_TEXT_CHARS. */
export function truncateText(text: string, limit = MAX_TEXT_CHARS): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Collapse ALL whitespace to single spaces (web pages, PDFs, transcripts). */
export function collapseWhitespace(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Plain-text books: keep paragraphs, drop hard wraps. Lines inside a paragraph (Gutenberg wraps at
 * ~70 columns) are joined with a space; blank lines become a single paragraph break ("\n\n").
 */
export function normalizeParagraphs(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")          // horizontal whitespace → one space
    .replace(/ *\n */g, "\n")           // trim around line breaks
    .replace(/\n{2,}/g, "\u0001")       // protect paragraph breaks
    .replace(/\n/g, " ")                // join wrapped lines
    .replace(/\u0001/g, "\n\n")
    .trim();
}

// ─── Project Gutenberg ───────────────────────────────────────────────────────

const PG_START = [
  /\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG E-?(?:BOOK|TEXT)[^*]{0,300}\*{3}/i,
  /\*END\*THE SMALL PRINT![\s\S]{0,300}?\*END\*/i,              // pre-2000 texts
];
const PG_END = [
  /\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG E-?(?:BOOK|TEXT)/i,
  /End of (?:the )?Project Gutenberg(?:'s)?\s/i,
  /\*{3}\s*END OF THE PROJECT GUTENBERG/i,
];

const HEADER_FIELDS = [
  "Title", "Author", "Release [Dd]ate", "Posting [Dd]ate", "Language", "Credits", "Translator",
  "Editor", "Illustrator", "Contributor", "Original publication", "Most recently updated",
  "Character set encoding", "Produced by", "Last [Uu]pdated", "Series",
];

/** "Title:" / "Author:" fields from a Gutenberg header (line-based or whitespace-collapsed). */
export function parseGutenbergHeader(header: string): DocumentMeta {
  const field = (name: string): string | undefined => {
    const others = HEADER_FIELDS.filter(f => f !== name).join("|");
    // Value runs to the next header field, a blank line, the START marker or the end. Indented
    // continuation lines (multi-line titles) are kept and joined below.
    const re = new RegExp(
      `(?:^|\\n|\\s)${name}:[^\\S\\n]*([\\s\\S]*?)(?=\\n\\s*\\n|\\s+(?:${others}):|\\*{3}|$)`,
    );
    const m = re.exec(header);
    if (!m) return undefined;
    const value = m[1].replace(/\s+/g, " ").trim();
    return value || undefined;
  };
  let title = field("Title");
  let author = field("Author");
  if (!title || !author) {
    // Older headers: "The Project Gutenberg EBook of <title>, by <author>"
    const m = /Project Gutenberg'?s? e-?(?:book|text) of ([^\n]+?), by ([^\n]+?)(?:\r?\n|\s{2,}|\s+This e-?(?:book|text)\b|$)/i.exec(header);
    if (m) {
      title = title ?? m[1].trim();
      author = author ?? m[2].trim();
    }
  }
  return {
    title: title && title.length <= 300 ? title : undefined,
    author: author && author.length <= 200 ? author : undefined,
  };
}

/**
 * Remove the Project Gutenberg license header and footer, returning the book body plus the
 * Title/Author found in the header. Text without Gutenberg markers is returned unchanged.
 * Idempotent (the markers are gone after the first pass).
 */
export function stripGutenberg(text: string): PreparedText {
  let start = -1;
  let headerEnd = -1;
  for (const re of PG_START) {
    const m = re.exec(text);
    if (m && (start === -1 || m.index < start)) {
      start = m.index;
      headerEnd = m.index + m[0].length;
    }
  }
  // Only treat it as a Gutenberg book when the start marker is near the beginning (the header is
  // a few KB); a stray quotation later in a text must not cut the document.
  const isGutenberg = start !== -1 && start < 50_000;
  const meta = isGutenberg ? parseGutenbergHeader(text.slice(0, start)) : {};

  let body = isGutenberg ? text.slice(headerEnd) : text;
  if (isGutenberg || /project gutenberg/i.test(text.slice(-30_000))) {
    let end = -1;
    const tailFrom = Math.max(0, body.length - 120_000); // the license footer is ~20 KB
    const tail = body.slice(tailFrom);
    for (const re of PG_END) {
      const m = re.exec(tail);
      if (m && (end === -1 || tailFrom + m.index < end)) end = tailFrom + m.index;
    }
    if (end !== -1) body = body.slice(0, end);
  }
  return { text: body.trim(), ...meta };
}

/**
 * Final step for every source: strip Gutenberg boilerplate (collecting its Title/Author) and cut to
 * MAX_TEXT_CHARS. Explicit metadata (EPUB OPF, PDF info) wins over the Gutenberg header.
 */
export function prepareText(text: string, meta: DocumentMeta = {}): PreparedText {
  const stripped = stripGutenberg(text);
  return {
    text: truncateText(stripped.text),
    title: meta.title ?? stripped.title,
    author: meta.author ?? stripped.author,
  };
}

// ─── Metadata sanity ─────────────────────────────────────────────────────────

const JUNK_TITLE = [
  /^untitled\b/i, /^microsoft (word|powerpoint|excel)\b/i, /\.(pdf|docx?|rtf|odt|txt|indd|tex|epub)$/i,
  /^document\d*$/i, /^(title|book|ebook|unknown|none|null|n\/a)$/i, /^[\d\s_.-]+$/,
];
const JUNK_AUTHOR = [
  /^(unknown|anonymous|administrator|admin|user|owner|author|none|null|n\/a|default)$/i,
  /^(microsoft|adobe|calibre|pdf|acrobat)\b/i, /^[\d\s_.-]+$/,
];

/** Clean a title/author candidate; undefined when it is empty or obviously not a real value. */
export function meaningfulMeta(value: unknown, kind: "title" | "author"): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  if (v.length < 2 || v.length > (kind === "title" ? 300 : 200)) return undefined;
  const junk = kind === "title" ? JUNK_TITLE : JUNK_AUTHOR;
  return junk.some(re => re.test(v)) ? undefined : v;
}
