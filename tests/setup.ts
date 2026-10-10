// Mocha root setup: runs before any test module loads.
import { __setResolverForTest } from "../src/services/safe-fetch";
import { __setDecisionsFetchForTest } from "../src/services/decisions-client";
import { __setKeyStatusFetchForTest } from "../src/services/openrouter-key";

// Never touch a real FalkorDB/Redis from unit tests (port 1 is never listening).
process.env.FALKORDB_HOST = "127.0.0.1";
process.env.FALKORDB_PORT = "1";

// Never call OpenRouter from unit tests: no key (decisions calls fail fast → callers fall back),
// the default ai-config.yml, and transports that refuse. Tests that exercise these clients set a
// key and install their own stub transport.
delete process.env.OPENROUTER_API_KEY;
delete process.env.AI_CONFIG_PATH;
__setDecisionsFetchForTest(async () => new Response("network disabled in tests", { status: 400 }));
__setKeyStatusFetchForTest(async () => new Response("network disabled in tests", { status: 400 }));

// Keep parser tests deterministic by forcing HTTP-only YouTube fallbacks in tests.
process.env.POCW_SKIP_YT_PKG_FALLBACK = "1";
process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK = "1";

// Deterministic DNS for SSRF checks: every hostname resolves to a public address unless a
// test overrides the resolver. (HTTP itself is intercepted by nock — no network needed.)
__setResolverForTest(async () => [{ address: "93.184.215.14", family: 4 }]);
