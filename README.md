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
- Docker (for FalkorDB)
- Hardhat

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

## Quick Start

```bash
docker compose up -d           # Start FalkorDB
npx hardhat node               # Terminal 1
npx hardhat run scripts/simulate-flow.ts --network localhost  # Terminal 2
```

FalkorDB Browser available at `http://localhost:8001`.

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
