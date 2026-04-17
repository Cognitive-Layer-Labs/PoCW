// Mocha root hook: set required env vars before any test modules load
if (!process.env.ORACLE_PRIVATE_KEY) {
  process.env.ORACLE_PRIVATE_KEY =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

// Keep parser tests deterministic by forcing HTTP-only YouTube fallbacks in tests.
process.env.POCW_SKIP_YT_PKG_FALLBACK = "1";
process.env.POCW_SKIP_YT_INNERTUBE_FALLBACK = "1";
