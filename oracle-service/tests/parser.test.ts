import { expect } from "chai";
import nock from "nock";
import fs from "fs";
import path from "path";
import { parseContentToText } from "../src/services/parser";

async function expectErrorMessage(fn: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await fn();
    expect.fail("Expected function to throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).to.match(expected);
  }
}


describe("parseContentToText", function () {
  this.timeout(20000);

  afterEach(() => {
    nock.cleanAll();
  });

  /* ================= GOOD PATHS ================= */

  it("parses TXT content", async () => {
    nock("https://example.com")
      .get("/file.txt")
      .reply(200, "Hello TXT parser test", {
        "Content-Type": "text/plain"
      });

    const text = await parseContentToText("https://example.com/file.txt");
    expect(text).to.contain("Hello TXT");
  });

  it("parses HTML content", async () => {
    nock("https://example.com")
      .get("/file.html")
      .reply(
        200,
        "<html><body><h1>Title</h1><p>Hello HTML</p></body></html>",
        { "Content-Type": "text/html" }
      );

    const text = await parseContentToText("https://example.com/file.html");
    expect(text).to.contain("Hello HTML");
  });

  it("parses PDF content", async () => {
    const pdfBuffer = fs.readFileSync(
      path.join(__dirname, "fixtures/sample.pdf")
    );

    nock("https://example.com")
      .get("/file.pdf")
      .reply(200, pdfBuffer, {
        "Content-Type": "application/pdf"
      });

    const text = await parseContentToText("https://example.com/file.pdf");
    expect(text.length).to.be.greaterThan(10);
  });

  it("parses IPFS TXT via gateway", async () => {
    nock("https://ipfs.io")
      .get("/ipfs/QM_TEST_HASH")
      .reply(200, "IPFS text content", {
        "Content-Type": "text/plain"
      });

    const text = await parseContentToText("ipfs://QM_TEST_HASH");
    expect(text).to.contain("IPFS text");
  });

  it("parses YouTube transcript", async () => {
    nock("https://youtubetranscript.com")
      .get(/.*/)
      .reply(
        200,
        "<html><body>This is a transcript text</body></html>",
        { "Content-Type": "text/html" }
      );

    const text = await parseContentToText(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );

    expect(text).to.contain("transcript");
  });

  it("ignores blocked mirror payload and throws when no captions are available", async () => {
    nock("https://youtubetranscript.com")
      .get(/.*/)
      .reply(
        200,
        "<transcript><text start=\"0\" dur=\"5\">We're sorry, YouTube is currently blocking us from fetching subtitles preventing us from generating a summary for you. We're working on a fix!</text></transcript>",
        { "Content-Type": "application/xml" }
      );

    nock("https://video.google.com")
      .get("/timedtext")
      .query((q) => q.type === "list" && q.v === "dQw4w9WgXcQ")
      .reply(200, "<transcript_list></transcript_list>", {
        "Content-Type": "application/xml"
      });

    await expectErrorMessage(
      () => parseContentToText("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      /transcript unavailable/i
    );
  });

  /* ================= SAD PATHS ================= */

  it("rejects invalid URL", async () => {
    await expectErrorMessage(
      () => parseContentToText("not a url"),
      /invalid url/i
    );
  });

  it("handles 404 error", async () => {
    nock("https://example.com")
      .get("/missing.txt")
      .reply(404);

    await expectErrorMessage(
      () => parseContentToText("https://example.com/missing.txt"),
      /failed to fetch content/i
    );
  });

  it("rejects video content", async () => {
    nock("https://example.com")
      .get("/video.mp4")
      .reply(200, "binary", {
        "Content-Type": "video/mp4"
      });

    await expectErrorMessage(
      () => parseContentToText("https://example.com/video.mp4"),
      /unsupported binary content/i
    );
  });

  it("rejects image content", async () => {
    nock("https://example.com")
      .get("/image.png")
      .reply(200, "binary", {
        "Content-Type": "image/png"
      });

    await expectErrorMessage(
      () => parseContentToText("https://example.com/image.png"),
      /unsupported binary content/i
    );
  });

  it("rejects application/octet-stream", async () => {
    nock("https://example.com")
      .get("/bin")
      .reply(200, "binary", {
        "Content-Type": "application/octet-stream"
      });

    await expectErrorMessage(
      () => parseContentToText("https://example.com/bin"),
      /unsupported binary content/i
    );
  });
});
