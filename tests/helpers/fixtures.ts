/**
 * Test fixture builders: ZIP archives, EPUBs and a minimal PDF with an Info dictionary.
 */
import * as zlib from "zlib";
import { createHash } from "crypto";

const crc32 = (data: Buffer): number =>
  typeof (zlib as unknown as { crc32?: (d: Buffer) => number }).crc32 === "function"
    ? (zlib as unknown as { crc32: (d: Buffer) => number }).crc32(data)
    : 0; // the engine's reader does not verify CRCs

export interface ZipFile {
  name: string;
  data: string | Buffer;
  /** Store uncompressed (method 0) instead of deflate. */
  store?: boolean;
  /** Lie about the uncompressed size in the headers (zip-bomb tests). */
  claimedSize?: number;
}

/** Build a ZIP archive in memory. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const data = f.store ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(f.name, "utf8");
    const size = f.claimedSize ?? raw.length;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export interface EpubOptions {
  title?: string;
  /** dc:creator entries; role "aut" / "edt" set via opf:role. */
  creators?: Array<{ name: string; role?: string }>;
  /** Chapters in SPINE order (manifest lists them reversed to prove spine order is used). */
  chapters?: Array<{ id: string; body: string }>;
  /** Extra files (e.g. Gutenberg license page) appended to the spine. */
  extraSpine?: Array<{ id: string; body: string; linear?: "no" }>;
  /** Omit the mimetype entry (→ not an EPUB). */
  noMimetype?: boolean;
}

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
  `<head><title>t</title><style>p { color: red; }</style><script>var hidden = "SCRIPT_TEXT";</script></head>` +
  `<body>${body}</body></html>`;

/** Build a small but realistic EPUB 3 (OPF in a subdirectory, nav doc, NCX, CSS). */
export function makeEpub(opts: EpubOptions = {}): Buffer {
  const title = opts.title ?? "The Test Book";
  const creators = opts.creators ?? [{ name: "Jane Author", role: "aut" }];
  const chapters = opts.chapters ?? [
    { id: "ch1", body: "<h1>Chapter One</h1><p>It was a bright cold day.</p><p>The clocks were striking thirteen.</p>" },
    { id: "ch2", body: "<h1>Chapter Two</h1><p>Call me Ishmael &amp; friends&nbsp;&#8212; said he.</p><script>evil()</script>" },
  ];
  const spine = [...chapters, ...(opts.extraSpine ?? [])];
  const manifestItems = [...spine].reverse()
    .map(c => `<item id="${c.id}" href="text/${c.id}.xhtml" media-type="application/xhtml+xml"/>`).join("\n");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:1234</dc:identifier>
    <dc:title>${title}</dc:title>
    ${creators.map((c, i) => `<dc:creator id="cr${i}"${c.role ? ` opf:role="${c.role}"` : ""}>${c.name}</dc:creator>`).join("\n    ")}
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="nav"/>
    ${spine.map(c => `<itemref idref="${c.id}"${"linear" in c && c.linear ? ` linear="${c.linear}"` : ""}/>`).join("\n    ")}
  </spine>
</package>`;
  const files: ZipFile[] = [];
  if (!opts.noMimetype) files.push({ name: "mimetype", data: "application/epub+zip", store: true });
  files.push(
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: xhtml(`<nav epub:type="toc"><ol><li>NAV_ENTRY</li></ol></nav>`) },
    { name: "OEBPS/toc.ncx", data: `<ncx><navMap><navPoint><text>NCX_ENTRY</text></navPoint></navMap></ncx>` },
    { name: "OEBPS/style.css", data: "body { margin: 0 }" },
    ...spine.map(c => ({ name: `OEBPS/text/${c.id}.xhtml`, data: xhtml(c.body) })),
  );
  return makeZip(files);
}

/** Minimal single-page PDF with a text line and an Info dictionary. */
export function makePdf(text: string, info: Record<string, string> = {}): Buffer {
  const content = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
  const infoEntries = Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< ${infoEntries} >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  // Unique /ID: pdf.js identifies documents by it (falling back to the first KB of the file).
  const id = createHash("md5").update(text + JSON.stringify(info)).digest("hex");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** A Project Gutenberg style plain-text book (hard-wrapped, with header and license footer). */
export function gutenbergText(body = "Call me Ishmael. Some years ago--never mind how long\nprecisely--having little or no money in my purse.\n\nCHAPTER 2. The Carpet-Bag.\n\nI stuffed a shirt or two into my old carpet-bag."): string {
  return [
    "﻿The Project Gutenberg eBook of Moby-Dick; or The Whale, by Herman Melville",
    "",
    "This eBook is for the use of anyone anywhere in the United States and",
    "most other parts of the world at no cost and with almost no restrictions",
    "whatsoever. You may copy it, give it away or re-use it under the terms",
    "of the Project Gutenberg License included with this eBook.",
    "",
    "Title: Moby-Dick; or The Whale",
    "",
    "Author: Herman Melville",
    "",
    "Release Date: June, 2001 [eBook #2701]",
    "",
    "Language: English",
    "",
    "*** START OF THE PROJECT GUTENBERG EBOOK MOBY-DICK; OR THE WHALE ***",
    "",
    body,
    "",
    "*** END OF THE PROJECT GUTENBERG EBOOK MOBY-DICK; OR THE WHALE ***",
    "",
    "Updated editions will replace the previous one--the old editions will",
    "be renamed. Section 1. General Terms of Use and Redistributing Project",
    "Gutenberg-tm electronic works. LICENSE_FOOTER_TEXT",
  ].join("\r\n");
}
