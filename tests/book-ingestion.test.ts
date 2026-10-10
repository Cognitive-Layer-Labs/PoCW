import { expect } from "chai";
import nock from "nock";
import { makeZip, makeEpub, makePdf, gutenbergText } from "./helpers/fixtures";
import { listZipEntries, readZipEntry, newZipBudget, ZipError } from "../src/services/zip-reader";
import { isEpub, parseEpub, xhtmlToText } from "../src/services/epub";
import {
  stripGutenberg, parseGutenbergHeader, prepareText, meaningfulMeta, normalizeParagraphs, MAX_TEXT_CHARS,
  cleanAuthorName,
} from "../src/services/book-text";
import { parseUpload, parseSource, UploadParseError } from "../src/services/parser";

async function uploadError(body: Buffer, ct: string): Promise<UploadParseError> {
  try {
    await parseUpload(body, ct);
  } catch (err) {
    expect(err).to.be.instanceOf(UploadParseError);
    return err as UploadParseError;
  }
  throw new Error("expected parseUpload to fail");
}

describe("Book ingestion", function () {
  this.timeout(20000);

  describe("zip reader", () => {
    it("lists and reads stored and deflated entries", () => {
      const zip = makeZip([
        { name: "a.txt", data: "stored text", store: true },
        { name: "dir/b.txt", data: "deflated ".repeat(100) },
      ]);
      const entries = listZipEntries(zip);
      expect(entries.map(e => e.name)).to.deep.equal(["a.txt", "dir/b.txt"]);
      const budget = newZipBudget();
      expect(readZipEntry(zip, entries[0], budget).toString()).to.equal("stored text");
      expect(readZipEntry(zip, entries[1], budget).toString()).to.equal("deflated ".repeat(100));
    });

    it("caps total decompressed size even when an entry lies about its size (zip bomb)", () => {
      const bomb = makeZip([{ name: "bomb.xhtml", data: Buffer.alloc(5 * 1024 * 1024), claimedSize: 10 }]);
      expect(bomb.length).to.be.below(20_000);
      const [entry] = listZipEntries(bomb);
      expect(() => readZipEntry(bomb, entry, newZipBudget(1024 * 1024))).to.throw(ZipError, /too large/);
      // The shared budget also spans entries.
      const two = makeZip([{ name: "a", data: Buffer.alloc(600_000) }, { name: "b", data: Buffer.alloc(600_000) }]);
      const budget = newZipBudget(1_000_000);
      const [a, b] = listZipEntries(two);
      readZipEntry(two, a, budget);
      expect(() => readZipEntry(two, b, budget)).to.throw(ZipError, /too large/);
    });

    it("refuses archives with too many entries, and garbage", () => {
      const zip = makeZip([{ name: "1", data: "x" }, { name: "2", data: "y" }, { name: "3", data: "z" }]);
      expect(() => listZipEntries(zip, 2)).to.throw(ZipError, /too many entries/);
      expect(() => listZipEntries(Buffer.from("definitely not a zip file, just some bytes"))).to.throw(ZipError);
    });
  });

  describe("EPUB", () => {
    it("extracts text in spine order with chapter breaks, skipping nav/NCX/scripts/styles", () => {
      const doc = parseEpub(makeEpub());
      expect(doc.chapters).to.equal(2);
      expect(doc.text).to.equal(
        "Chapter One\nIt was a bright cold day.\nThe clocks were striking thirteen.\n\n" +
        "Chapter Two\nCall me Ishmael & friends — said he.",
      );
      for (const hidden of ["NAV_ENTRY", "NCX_ENTRY", "SCRIPT_TEXT", "evil()", "color: red", "margin"]) {
        expect(doc.text).to.not.contain(hidden);
      }
      expect(doc.title).to.equal("The Test Book");
      expect(doc.author).to.equal("Jane Author");
    });

    it("prefers creators with role aut, skips non-linear spine items", () => {
      const doc = parseEpub(makeEpub({
        creators: [{ name: "Some Editor", role: "edt" }, { name: "Leo Tolstoy", role: "aut" }],
        extraSpine: [{ id: "notes", body: "<p>FOOTNOTES_ONLY</p>", linear: "no" }],
      }));
      expect(doc.author).to.equal("Leo Tolstoy");
      expect(doc.text).to.not.contain("FOOTNOTES_ONLY");
    });

    it("Gutenberg's reordered creator (\"active 6th century B.C. Sunzi\") is rebuilt from file-as → \"Sunzi\"", () => {
      const doc = parseEpub(makeEpub({
        creators: [
          { name: "active 6th century B.C. Sunzi", role: "aut", fileAs: "Sunzi, active 6th century B.C." },
          { name: "Lionel Giles", role: "trl", fileAs: "Giles, Lionel" },
        ],
      }));
      expect(doc.author).to.equal("Sunzi");
      // Without file-as the leading qualifier is still stripped.
      expect(parseEpub(makeEpub({ creators: [{ name: "active 6th century B.C. Sunzi", role: "aut" }] })).author).to.equal("Sunzi");
      // A pen name that differs from file-as stays the display name.
      expect(parseEpub(makeEpub({ creators: [{ name: "Lewis Carroll", role: "aut", fileAs: "Dodgson, Charles Lutwidge" }] })).author)
        .to.equal("Lewis Carroll");
      expect(parseEpub(makeEpub({ creators: [{ name: "Carroll, Lewis, 1832-1898", role: "aut" }] })).author).to.equal("Lewis Carroll");
    });

    it("detects EPUBs by their mimetype entry", () => {
      expect(isEpub(makeEpub())).to.equal(true);
      expect(isEpub(makeEpub({ noMimetype: true }))).to.equal(false);
      expect(isEpub(makeZip([{ name: "mimetype", data: "application/zip", store: true }]))).to.equal(false);
      expect(isEpub(Buffer.from("%PDF-1.4\n%fake"))).to.equal(false);
    });

    it("converts XHTML without a DOM (entities, breaks, comments)", () => {
      expect(xhtmlToText("<body><p>A&#x27;s<br/>B</p><!-- c --><div>C&hellip;</div></body>")).to.equal("A's\nB\nC…");
    });

    it("rejects an EPUB without text", () => {
      expect(() => parseEpub(makeEpub({ chapters: [{ id: "img", body: "<img src='x.png'/>" }] }))).to.throw(/No text found/);
    });
  });

  describe("Project Gutenberg", () => {
    it("strips the license header and footer and keeps Title/Author", () => {
      const doc = stripGutenberg(normalizeParagraphs(gutenbergText()));
      expect(doc.title).to.equal("Moby-Dick; or The Whale");
      expect(doc.author).to.equal("Herman Melville");
      expect(doc.text.startsWith("Call me Ishmael. Some years ago--never mind how long precisely--having")).to.equal(true);
      expect(doc.text).to.contain("CHAPTER 2. The Carpet-Bag.");
      expect(doc.text).to.contain("my old carpet-bag.");
      for (const boiler of ["Project Gutenberg", "LICENSE_FOOTER_TEXT", "START OF", "END OF", "Release Date"]) {
        expect(doc.text).to.not.contain(boiler);
      }
    });

    it("works on whitespace-collapsed text (web pages) and is idempotent", () => {
      const collapsed = gutenbergText().replace(/\s+/g, " ");
      const once = stripGutenberg(collapsed);
      expect(once.title).to.equal("Moby-Dick; or The Whale");
      expect(once.author).to.equal("Herman Melville");
      expect(once.text).to.not.contain("Gutenberg");
      expect(stripGutenberg(once.text).text).to.equal(once.text);
    });

    it("reads the legacy one-line header and leaves non-Gutenberg text alone", () => {
      expect(parseGutenbergHeader("The Project Gutenberg EBook of War and Peace, by Leo Tolstoy\r\n\r\nThis eBook is for…"))
        .to.deep.equal({ title: "War and Peace", author: "Leo Tolstoy" });
      const plain = "A normal essay. It quotes *** START OF THE PROJECT GUTENBERG EBOOK X *** only at the end.";
      expect(stripGutenberg("x".repeat(60_000) + plain).text).to.equal("x".repeat(60_000) + plain);
      expect(stripGutenberg("Just text.")).to.deep.equal({ text: "Just text." });
    });
  });

  describe("metadata", () => {
    it("cleanAuthorName strips life dates / floruit qualifiers and turns \"Surname, Forename\" round when unambiguous", () => {
      const cases: Array<[string, string]> = [
        ["Sunzi, active 6th century B.C.", "Sunzi"],
        ["active 6th century B.C. Sunzi", "Sunzi"],
        ["Carroll, Lewis, 1832-1898", "Lewis Carroll"],
        ["Carroll, Lewis (1832–1898)", "Lewis Carroll"],
        ["Lewis Carroll", "Lewis Carroll"],
        ["Lewis Carroll (1832-1898)", "Lewis Carroll"],
        ["Shakespeare, William, b. 1564", "William Shakespeare"],
        ["Shakespeare, William, d. 1616", "William Shakespeare"],
        ["Shakespeare, William, 1564?-1616", "William Shakespeare"],
        ["fl. 1200 Marie de France", "Marie de France"],
        ["Marie, de France, fl. 12th century", "Marie, de France"],
        ["Le Guin, Ursula K.", "Ursula K. Le Guin"],
        ["Wells, H. G. (Herbert George), 1866-1946", "H. G. Wells"],
        // ambiguous → left alone
        ["Lewis Carroll, John Tenniel", "Lewis Carroll, John Tenniel"],
        ["Smith, John, Jr.", "Smith, John, Jr."],
        ["Homer", "Homer"],
      ];
      for (const [raw, clean] of cases) expect(cleanAuthorName(raw), raw).to.equal(clean);
      expect(cleanAuthorName(42)).to.equal(undefined);
      expect(parseGutenbergHeader("Title: The Art of War\n\nAuthor: active 6th century B.C. Sunzi\n\nTranslator: Lionel Giles\n").author)
        .to.equal("Sunzi");
    });

    it("keeps meaningful titles/authors and drops placeholders", () => {
      expect(meaningfulMeta("  Moby  Dick ", "title")).to.equal("Moby Dick");
      for (const junk of ["Untitled", "Microsoft Word - draft.docx", "book1.pdf", "", "  ", "123", "Document1"]) {
        expect(meaningfulMeta(junk, "title"), junk).to.equal(undefined);
      }
      for (const junk of ["Administrator", "user", "Unknown", "Microsoft Office User"]) {
        expect(meaningfulMeta(junk, "author"), junk).to.equal(undefined);
      }
      expect(meaningfulMeta(42, "author")).to.equal(undefined);
    });

    it("explicit metadata wins over the Gutenberg header", () => {
      const doc = prepareText(gutenbergText(), { title: "From OPF" });
      expect(doc.title).to.equal("From OPF");
      expect(doc.author).to.equal("Herman Melville");
    });
  });

  describe("uploads (parseUpload)", () => {
    it("EPUB as application/epub+zip and as application/octet-stream", async () => {
      for (const ct of ["application/epub+zip", "application/octet-stream"]) {
        const doc = await parseUpload(makeEpub(), ct);
        expect(doc.title, ct).to.equal("The Test Book");
        expect(doc.author, ct).to.equal("Jane Author");
        expect(doc.text, ct).to.contain("Call me Ishmael");
      }
    });

    it("a zip that is not an EPUB is refused (422), binary junk is 415, empty text is 400", async () => {
      expect((await uploadError(makeZip([{ name: "a.txt", data: "hi" }]), "application/epub+zip")).status).to.equal(422);
      expect((await uploadError(Buffer.from([0, 1, 2, 3]), "application/octet-stream")).status).to.equal(415);
      expect((await uploadError(Buffer.from("   \n  "), "text/plain")).status).to.equal(400);
    });

    it("PDF (sniffed from octet-stream): text plus Title/Author from the document info", async () => {
      // One synthetic PDF per process: pdf-parse's bundled pdf.js 1.10 misreads a second
      // hand-built PDF parsed in the same process. Placeholder values are covered by meaningfulMeta.
      const doc = await parseUpload(makePdf("Hello book", { Title: "Moby Dick", Author: "Herman Melville" }), "application/octet-stream");
      expect(doc.text).to.contain("Hello book");
      expect(doc.title).to.equal("Moby Dick");
      expect(doc.author).to.equal("Herman Melville");
    });

    it("Gutenberg TXT: boilerplate stripped, paragraphs kept, hard wraps joined", async () => {
      const doc = await parseUpload(Buffer.from(gutenbergText()), "text/plain");
      expect(doc.title).to.equal("Moby-Dick; or The Whale");
      expect(doc.author).to.equal("Herman Melville");
      expect(doc.text.split("\n\n")).to.have.length(3);
      expect(doc.text).to.not.match(/Gutenberg|LICENSE_FOOTER/);
    });

    it(`cuts text to MAX_TEXT_CHARS (${MAX_TEXT_CHARS.toLocaleString("en")} characters)`, async () => {
      const big = Buffer.alloc(MAX_TEXT_CHARS + 500_000, "word ");
      const doc = await parseUpload(big, "text/plain");
      expect(doc.text.length).to.be.at.most(MAX_TEXT_CHARS);
      expect(doc.text.length).to.be.greaterThan(MAX_TEXT_CHARS - 10);
    });
  });

  describe("URL sources (parseSource)", () => {
    afterEach(() => nock.cleanAll());

    it("EPUB by content type, by .epub path and as a sniffed octet-stream", async () => {
      const epub = makeEpub();
      nock("https://books.example").get("/a").reply(200, epub, { "Content-Type": "application/epub+zip" });
      nock("https://books.example").get("/b.epub").query(true).reply(200, epub, { "Content-Type": "binary/octet-stream" });
      nock("https://books.example").get("/c").reply(200, epub, { "Content-Type": "application/octet-stream" });
      for (const url of ["https://books.example/a", "https://books.example/b.epub?download=1", "https://books.example/c"]) {
        const doc = await parseSource(url);
        expect(doc.title, url).to.equal("The Test Book");
        expect(doc.author, url).to.equal("Jane Author");
        expect(doc.text, url).to.contain("bright cold day");
      }
    });

    it("plain-text Gutenberg books are stripped and keep their metadata", async () => {
      nock("https://www.gutenberg.example").get("/files/2701-0.txt").reply(200, gutenbergText(), { "Content-Type": "text/plain; charset=utf-8" });
      const doc = await parseSource("https://www.gutenberg.example/files/2701-0.txt");
      expect(doc.title).to.equal("Moby-Dick; or The Whale");
      expect(doc.author).to.equal("Herman Melville");
      expect(doc.text).to.not.contain("Gutenberg");
    });

    it("book-sized HTML is converted without a DOM and keeps its title", async () => {
      const paragraphs = Array.from({ length: 9000 }, (_, i) => `<p>Paragraph ${i} of the book.</p>`).join("\n");
      const html = `<html><head><title>Moby Dick (HTML)</title><style>.x{}</style></head><body><nav>MENU</nav>${paragraphs}</body></html>`;
      expect(html.length).to.be.above(250_000);
      nock("https://books.example").get("/big.html").reply(200, html.repeat(5), { "Content-Type": "text/html" });
      const started = Date.now();
      const doc = await parseSource("https://books.example/big.html");
      expect(Date.now() - started).to.be.below(5000);
      expect(doc.htmlTitle).to.equal("Moby Dick (HTML)");
      expect(doc.text).to.contain("Paragraph 8999 of the book.");
      expect(doc.text).to.not.contain("MENU");
    });

    it("still blocks private targets for book URLs (SSRF)", async () => {
      try {
        await parseSource("http://127.0.0.1/book.epub");
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.match(/SSRF blocked/);
      }
    });
  });
});
