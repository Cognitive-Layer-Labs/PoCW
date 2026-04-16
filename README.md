# Proof of Cognitive Work

Adaptive psychometric testing (IRT) + Knowledge Graph + Blockchain credentialing (Soulbound NFTs).

## SDK Quick Start

```ts
import { PoCW } from "./oracle-service/src/sdk/index";

const pocw = new PoCW();
await pocw.init();

// Index any content (URL, IPFS CID, raw text)
const { knowledgeId } = await pocw.index("https://example.com/article");
await pocw.waitForIndex(knowledgeId);

// Verify knowledge — adaptive questions, IRT scoring
const result = await pocw.verify(knowledgeId, "0xUserAddress", {
  max_questions: 5,
  q_types: ["open", "mcq", "true_false"],
  threshold: 0.7,
  onQuestion: async (q) => prompt(q.text),
});

console.log(result.score, result.passed); // 82, true
await pocw.close();
```

See [docs/API.md](docs/API.md) for the full protocol reference.

## Prerequisites

- Node.js 18+
- Docker (for FalkorDB + Otterscan)
- Foundry (for Anvil) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Hardhat (for tests + deployment scripts)

## Environment

Single `.env` file in project root (see `.env.example`):

```bash
cp .env.example .env
# Fill in your keys
```

All env vars are loaded from root `.env` — no separate oracle-service `.env` needed.

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for LLM access |
| `FALKORDB_HOST` | No | FalkorDB host (default: `localhost`) |
| `FALKORDB_PORT` | No | FalkorDB port (default: `6379`) |
| `FALKORDB_PASSWORD` | No | FalkorDB password (if set) |
| `FALKORDB_GRAPH` | No | FalkorDB graph name (default: `pocw`) |
| `PORT` | No | Oracle service port (default: `3000`) |
| `ORACLE_PRIVATE_KEY` | For signing | Oracle wallet private key |
| `PRIVATE_KEY` | For deploy | Deployer wallet private key |
| `ORACLE_ADDRESS` | For testnet | Oracle address for testnet deploy |
| `BASE_SEPOLIA_RPC_URL` | For testnet | Base Sepolia RPC endpoint |

## Local Development

### One-command startup

```bash
./start-local.sh
```

Starts everything in order, skips anything already running, and shuts it all down on `Ctrl+C`.

---

### Manual startup (individual services)

Run each in its own terminal, in this order:

**1 — Infra (FalkorDB + Redis)**
```bash
docker compose up falkordb redis
```

**2 — Anvil local chain**
```bash
anvil --chain-id 31337              # starts chain at http://127.0.0.1:8545
```

**3 — Deploy contracts** (once per chain restart)
```bash
npm run deploy:local
```

**4 — Oracle service** (hot-reload)
```bash
cd oracle-service
npm run dev                         # http://localhost:3000
```

**5 — Frontend** (separate repo)
```bash
cd ../PoCW-WEB
npm run dev                         # http://localhost:3001
```

**6 — Block explorer** (optional)
```bash
docker run -d --name pocw-otterscan -p 5100:80 \
  -e ERIGON_URL="http://localhost:8545" \
  otterscan/otterscan:latest
# http://localhost:5100
# docker rm -f pocw-otterscan  # to stop
```

---

### Ports

| Service | Port |
|---|---|
| Anvil RPC | 8545 |
| Oracle API | 3000 |
| Frontend | 3001 |
| FalkorDB | 6379 |
| Redis | 6380 |
| Otterscan | 5100 |
| FalkorDB UI | 8001 |

### MetaMask local network

| Field | Value |
|---|---|
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Deployer key | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Oracle key | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |

> These are well-known Hardhat/Anvil test keys — never use them on a real network.

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/index` | POST | Index content `{ source }` |
| `/api/index/:knowledgeId` | GET | Check indexing status |
| `/api/verify` | POST | Start verification session `{ knowledgeId, subject, config? }` |
| `/api/verify/:sessionId/answer` | POST | Submit answer `{ answer }` |
| `/api/verify/:sessionId/result` | GET | Get final result |

## Tests

```bash
cd oracle-service && npm test
```
