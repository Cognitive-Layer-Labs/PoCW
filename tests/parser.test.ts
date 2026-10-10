import { expect } from "chai";
import nock from "nock";
import fs from "fs";
import path from "path";
import { parseContentToText, parseWebContentWithTitle } from "../src/services/parser";
import { __setResolverForTest, isPrivateAddress } from "../src/services/safe-fetch";

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

  it("follows a redirect to another public URL", async () => {
    nock("https://example.com")
      .get("/old")
      .reply(301, "", { Location: "https://example.org/new.txt" });
    nock("https://example.org")
      .get("/new.txt")
      .reply(200, "Redirected text body", { "Content-Type": "text/plain" });

    const text = await parseContentToText("https://example.com/old");
    expect(text).to.contain("Redirected text body");
  });

  it("decodes gzip-compressed responses", async () => {
    const zlib = await import("zlib");
    nock("https://example.com")
      .get("/gz.txt")
      .reply(200, zlib.gzipSync(Buffer.from("Compressed hello")), {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      });

    const text = await parseContentToText("https://example.com/gz.txt");
    expect(text).to.contain("Compressed hello");
  });

  it("returns the HTML <title> via parseWebContentWithTitle", async () => {
    nock("https://example.com")
      .get("/page")
      .reply(200, "<html><head><title>My Page</title></head><body><p>Body text</p></body></html>", {
        "Content-Type": "text/html",
      });

    const parsed = await parseWebContentWithTitle("https://example.com/page");
    expect(parsed.htmlTitle).to.equal("My Page");
    expect(parsed.text).to.contain("Body text");
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

  it("parses YouTube transcript via InnerTube captionTracks fallback", async () => {
    const oldSkip = process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK;
    process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK = "0";

    nock("https://www.youtube.com")
      .post("/youtubei/v1/player")
      .query({ prettyPrint: "false" })
      .reply(200, {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr",
                languageCode: "en",
                kind: "asr",
              },
            ],
          },
        },
      });

    nock("https://www.youtube.com")
      .get("/api/timedtext")
      .query(true)
      .reply(
        200,
        "<?xml version=\"1.0\" encoding=\"utf-8\" ?><timedtext format=\"3\"><body><p t=\"0\" d=\"1000\"><s>Hello</s><s>world</s></p><p t=\"1000\" d=\"1000\"><s>from</s><s>InnerTube</s></p></body></timedtext>",
        { "Content-Type": "application/xml" }
      );

    try {
      const text = await parseContentToText(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      );

      expect(text).to.contain("Hello world from InnerTube");
    } finally {
      process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK = oldSkip;
    }
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

  it("rejects unsupported ws protocol", async () => {
    await expectErrorMessage(
      () => parseContentToText("ws://example.com/socket"),
      /unsupported url protocol/i
    );
  });

  it("rejects ipfs:// sources (not supported)", async () => {
    await expectErrorMessage(
      () => parseContentToText("ipfs://QmSomething"),
      /unsupported url protocol/i
    );
  });

  it("rejects file:// sources (no local file access)", async () => {
    await expectErrorMessage(
      () => parseContentToText("file:///etc/passwd"),
      /unsupported url protocol/i
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

describe("SSRF protection", function () {
  this.timeout(20000);

  afterEach(() => {
    nock.cleanAll();
    // restore the default test resolver (see tests/setup.ts)
    __setResolverForTest(async () => [{ address: "93.184.215.14", family: 4 }]);
  });

  const blockedLiterals = [
    "http://127.0.0.1/",
    "http://localhost:6379/",
    "http://10.0.0.5/x",
    "http://172.18.0.3/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://2130706433/",   // decimal form of 127.0.0.1
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
  ];

  for (const url of blockedLiterals) {
    it(`blocks ${url}`, async () => {
      await expectErrorMessage(() => parseContentToText(url), /ssrf blocked/i);
    });
  }

  it("blocks a hostname that resolves to a private address (e.g. a Docker service name)", async () => {
    __setResolverForTest(async (host) =>
      host === "redis" ? [{ address: "172.18.0.3", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]
    );
    await expectErrorMessage(() => parseContentToText("http://redis:6379/"), /ssrf blocked.*172\.18\.0\.3/i);
  });

  it("blocks when ANY resolved address is private", async () => {
    __setResolverForTest(async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ]);
    await expectErrorMessage(() => parseContentToText("https://mixed.example/"), /ssrf blocked/i);
  });

  it("blocks a redirect to a private IP", async () => {
    nock("https://example.com")
      .get("/redir")
      .reply(302, "", { Location: "http://169.254.169.254/latest/meta-data/" });
    await expectErrorMessage(() => parseContentToText("https://example.com/redir"), /ssrf blocked/i);
  });

  it("blocks a redirect to an internal hostname", async () => {
    __setResolverForTest(async (host) =>
      host === "falkordb" ? [{ address: "172.20.0.2", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]
    );
    nock("https://example.com")
      .get("/redir2")
      .reply(307, "", { Location: "http://falkordb:6379/" });
    await expectErrorMessage(() => parseContentToText("https://example.com/redir2"), /ssrf blocked/i);
  });

  it("stops after too many redirects", async () => {
    nock("https://example.com")
      .persist()
      .get("/loop")
      .reply(302, "", { Location: "https://example.com/loop" });
    await expectErrorMessage(() => parseContentToText("https://example.com/loop"), /too many redirects/i);
  });

  it("classifies addresses correctly", () => {
    expect(isPrivateAddress("8.8.8.8")).to.be.false;
    expect(isPrivateAddress("172.66.147.243")).to.be.false;
    expect(isPrivateAddress("2606:4700::6810:84e5")).to.be.false;
    expect(isPrivateAddress("172.31.255.255")).to.be.true;
    expect(isPrivateAddress("fe80::1%eth0")).to.be.true;
    expect(isPrivateAddress("not-an-ip")).to.be.true;
    // IPv4 embedded in IPv6 (mapped, compatible, translated, NAT64) and other non-public v6.
    for (const ip of ["::ffff:127.0.0.1", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::a00:1", "fec0::1", "2001::1"]) {
      expect(isPrivateAddress(ip), ip).to.be.true;
    }
  });
});
