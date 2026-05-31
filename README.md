# Proof of Cognitive Work (PoCW)

**Prove you actually know something. Get a credential no one can fake.**

PoCW is a protocol that issues **Soulbound Tokens (SBTs)** as tamper-proof proof that a specific person understood a specific piece of content — not just that they read it or paid for a certificate. The verification is driven by an adaptive psychometric test calibrated with Item Response Theory (IRT), not a static quiz.

---

## How it works

```
  Content (URL / PDF / text)
         │
         ▼
  ┌─────────────────┐
  │  Oracle Service │  ← Parse → Chunk → LLM extracts Knowledge Graph
  │  (Node.js)      │            (nodes = concepts, edges = relationships)
  └────────┬────────┘
           │  KG stored in FalkorDB
           ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  Adaptive Test Session                                          │
  │                                                                 │
  │  1. Load important concepts from KG (importance ≥ 0.65)        │
  │  2. Select next concept to test (mastery loop + IRT Fisher)     │
  │  3. Generate question targeting that concept + Bloom level      │
  │     ┌──────────────┐   ┌─────────────────────┐                 │
  │     │  KAQG (LLM)  │ + │  IRT Predictor      │                 │
  │     │  b, bloom,   │   │  (XGBoost sidecar)  │                 │
  │     │  key points  │   │  a, refine b, d     │                 │
  │     └──────────────┘   └─────────────────────┘                 │
  │  4. User answers → claim-based grading (LLM)                    │
  │  5. MAP update of θ (user ability) using 4PL IRT                │
  │  6. Repeat until concepts mastered or max questions reached     │
  └──────────────────────────────────────────────────────────────┬──┘
                                                                 │
           θ + pass/fail
                │
                ▼
  ┌─────────────────────┐     ┌────────────────────────────────────┐
  │  Oracle signs       │────▶│  PoCW_Controller (EVM contract)    │
  │  attestation        │     │  verifyAndMint() → PoCW_SBT        │
  │  (EIP-191)          │     │  (ERC-1155 Soulbound Token)        │
  └─────────────────────┘     └────────────────────────────────────┘
```

The SBT is non-transferable and encodes a cognitive profile: θ score, content ID, oracle signature. It lives on-chain permanently.

---

## Services

| Service | Role |
|---|---|
| `oracle` | Node.js/Express — indexing, session management, LLM calls, attestation signing |
| `predictor` | Python/FastAPI — XGBoost IRT parameter sidecar (discrimination `a`, difficulty `b`, upper asymptote `d`) |
| `falkordb` | Redis-based graph DB — stores the Knowledge Graph built during indexing |
| `redis` | Session state and queue for the oracle service |
| Smart contracts | `PoCW_SBT` (ERC-1155) + `PoCW_Controller` (verification + mint) |

---

## Quick Start

### 1. Copy and fill environment

```bash
cp .env.example .env
# Required: OPENROUTER_API_KEY, ORACLE_PRIVATE_KEY
```

### 2. Start all backend services

```bash
docker compose up -d --build
```

This starts FalkorDB, Redis, the IRT predictor, and the Oracle service. The predictor image takes a few minutes to build the first time (downloads the sentence-transformer model).

### 3. Index content

```bash
curl -X POST http://localhost:3000/api/index \
  -H "Content-Type: application/json" \
  -d '{"source": "https://en.wikipedia.org/wiki/Ethereum"}'
```

### 4. Run the interactive simulation (local chain)

```bash
# Terminal 1 — local Ethereum node
npx hardhat node

# Terminal 2 — end-to-end simulation
npx hardhat run scripts/simulate-flow.ts --network localhost
```

---

## Prerequisites

- Node.js 18+
- Docker + Docker Compose
- An [OpenRouter](https://openrouter.ai) API key (for LLM calls)

---

## Environment Variables

```bash
cp .env.example .env
```

<details>
<summary><strong>Full variable reference</strong></summary>

### LLM

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | API key for OpenRouter (question generation, grading, KG extraction) |

### Oracle signing

| Variable | Required | Purpose |
|---|---|---|
| `ORACLE_PRIVATE_KEY` | Yes | Ethereum private key the oracle uses to sign attestations |

### API security

| Variable | Required | Purpose |
|---|---|---|
| `CORS_ORIGIN` | Recommended | Browser origin allowed by Oracle API |
| `POCW_API_KEY` | Recommended | Bearer token gate for `/api` routes |
| `PORT` | Optional | Oracle listen port (default `3000`) |

### IRT predictor

| Variable | Optional | Purpose |
|---|---|---|
| `PREDICTOR_URL` | Optional | Predictor sidecar URL (default `http://predictor:3001` in compose, `http://127.0.0.1:3001` standalone) |

### Data stores

| Variable | Optional | Purpose |
|---|---|---|
| `FALKORDB_HOST` | Optional | Default: `falkordb` (compose) / `localhost` (standalone) |
| `FALKORDB_PORT` | Optional | Default `6379` |
| `FALKORDB_GRAPH` | Optional | Graph name (default `pocw`) |
| `REDIS_URL` | Optional | Full Redis URL (default: `redis://redis:6379/1`) |
| `REDIS_PASSWORD` | VPS compose | Redis password for `docker-compose.vps.yml` |

### Chain / wallets

| Variable | Required | Purpose |
|---|---|---|
| `ORACLE_ADDRESS` | Base Sepolia deploy | Oracle signer address registered in controller |
| `PRIVATE_KEY` | Base Sepolia deploy | Deployer wallet private key |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia deploy | RPC endpoint |

</details>

---

## Contract Deployment

### Local (Hardhat)

```bash
npx hardhat node
npx hardhat run scripts/simulate-flow.ts --network localhost
```

### Base Sepolia

```bash
npm run deploy:base-sepolia
cat deployments/base-sepolia.json
```

---

## Production (VPS)

The VPS compose file runs the full stack: FalkorDB, Redis, predictor, oracle, nginx (reverse proxy), and certbot (auto-renewing TLS). Set `ORACLE_DOMAIN` and `ACME_EMAIL` in `.env`, then:

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

Nginx config is in `nginx/nginx.conf`. On first run, certbot provisions the Let's Encrypt certificate automatically.

---

## Testing

```bash
npm test                    # contract tests
cd oracle-service && npm test  # oracle unit tests
```

---

## Further Reading

| Doc | Contents |
|---|---|
| [docs/API.md](docs/API.md) | SDK and REST API reference |
| [docs/OPTIONS.md](docs/OPTIONS.md) | IRT parameters, Bloom weights, data flow internals |
