// Mocha root hook: set required env vars before any test modules load
if (!process.env.ORACLE_PRIVATE_KEY) {
  process.env.ORACLE_PRIVATE_KEY =
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}
