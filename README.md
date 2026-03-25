# Proof of Cognitive Work

Adaptive psychometric testing (IRT) + Knowledge Graph + Blockchain credentialing (Soulbound NFTs).

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

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/start` | POST | Start adaptive test `{ contentUrl, userAddress }` |
| `/api/session/answer` | POST | Submit answer `{ sessionId, answer }` |
| `/api/session/result` | POST | Get final result + oracle signature `{ sessionId, userAddress }` |

## Tests

```bash
cd oracle-service && npm test
```
