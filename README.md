# Proof of Cognitive Work (PoCW)

Adaptive psychometric verification (IRT) + Knowledge Graph extraction + Soulbound credentialing on EVM.

## What is in this repo

- Smart contracts: ERC-1155 SBT + controller verification/mint logic
- Oracle service: indexing, adaptive questioning, grading, attestation signing
- Deployment scripts: local and Base Sepolia deployments
- Docker production backend stack: Oracle + Redis + FalkorDB

See the protocol/API reference in [docs/API.md](docs/API.md).

## Quick Start

### Local Development (single command)

```bash
cp .env.example .env
# fill required keys in .env
./start-local.sh
```

### Base Sepolia deploy (contracts)

```bash
npm ci
npm run deploy:base-sepolia
```

### Production backend on VPS (docker)

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

## Prerequisites

- Node.js 18+
- Docker + Docker Compose
- Foundry (for local Anvil workflow)
- Nginx + Certbot on VPS host (for HTTPS/domain in production)

## Environment

All services read from root .env.

```bash
cp .env.example .env
```

<details>
<summary><strong>Show Environment Variable Reference</strong></summary>

### Domain and TLS (VPS host)

| Variable | Required | Purpose |
|---|---|---|
| ORACLE_DOMAIN | VPS | Oracle domain used in host Nginx/Certbot setup |
| ACME_EMAIL | VPS | Let’s Encrypt registration email |

### Oracle API behavior

| Variable | Required | Purpose |
|---|---|---|
| CORS_ORIGIN | Recommended | Browser origin allowed by Oracle API |
| POCW_API_KEY | Recommended | Bearer token gate for /api routes |
| PORT | Optional | Oracle listen port (default 3000) |

### LLM

| Variable | Required | Purpose |
|---|---|---|
| OPENROUTER_API_KEY | Yes | OpenRouter key for generation/grading |

### Chain / wallets

| Variable | Required | Purpose |
|---|---|---|
| BASE_SEPOLIA_RPC_URL | Base Sepolia deploy | RPC endpoint |
| PRIVATE_KEY | Base Sepolia deploy | Deployer wallet private key |
| ORACLE_PRIVATE_KEY | Oracle runtime | Oracle signing wallet key |
| ORACLE_ADDRESS | Base Sepolia deploy | Oracle signer address registered in controller |

### Data stores

| Variable | Required | Purpose |
|---|---|---|
| FALKORDB_HOST | Optional | FalkorDB host (default localhost) |
| FALKORDB_PORT | Optional | FalkorDB port (default 6379) |
| FALKORDB_PASSWORD | Optional | Set only if your FalkorDB instance requires auth |
| FALKORDB_GRAPH | Optional | Graph name (default pocw) |
| REDIS_PASSWORD | VPS compose | Redis password for docker-compose.vps.yml |
| REDIS_URL | Optional | Needed if running Oracle directly outside compose |

</details>

## Local Development

<details>
<summary><strong>Show Manual Local Startup</strong></summary>

1. Start infra:

```bash
docker compose up falkordb redis
```

2. Start local chain:

```bash
anvil --chain-id 31337
```

3. Deploy contracts locally:

```bash
npm run deploy:local
```

4. Start Oracle in dev mode:

```bash
cd oracle-service
npm run dev
```

5. Optional local explorer (Otterscan):

```bash
docker run -d --name pocw-otterscan -p 5100:80 \
  -e ERIGON_URL="http://localhost:8545" \
  otterscan/otterscan:latest
```

</details>

## Base Sepolia Contract Deployment

1. Ensure these are set in .env:

- PRIVATE_KEY
- ORACLE_ADDRESS
- BASE_SEPOLIA_RPC_URL

2. Deploy:

```bash
npm run deploy:base-sepolia
```

3. Verify output:

```bash
cat deployments/base-sepolia.json
```

4. Current deployed record is in [deployments/base-sepolia.json](deployments/base-sepolia.json).

## VPS Hosting (Current Architecture)

Production split:

- Docker compose: oracle + redis + falkordb (backend only)
- Host Nginx + host Certbot: HTTPS termination + reverse proxy to 127.0.0.1:3000

<details>
<summary><strong>Show Backend Bring-up Commands (Docker)</strong></summary>

```bash
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
curl http://127.0.0.1:3000/health
```

</details>

<details>
<summary><strong>Show Nginx Host Config Example</strong></summary>

Create /etc/nginx/conf.d/pocw-oracle.conf:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name pocw-oracle.baghici.works;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

</details>

<details>
<summary><strong>Show Certbot (Email-only) Commands</strong></summary>

Issue cert and auto-configure Nginx redirect:

```bash
sudo certbot --nginx \
  -d pocw-oracle.baghici.works \
  -m you@example.com \
  --agree-tos --no-eff-email --redirect --non-interactive
```

Verify renewal:

```bash
sudo certbot renew --dry-run --cert-name pocw-oracle.baghici.works
```

</details>

<details>
<summary><strong>Show Final Production Checks</strong></summary>

```bash
# HTTPS health
curl https://pocw-oracle.baghici.works/health

# API should reject without bearer token
curl -i https://pocw-oracle.baghici.works/api/index

# API with token
curl -H "Authorization: Bearer $POCW_API_KEY" \
  https://pocw-oracle.baghici.works/api/index
```

</details>

## REST API

| Endpoint | Method | Description |
|---|---|---|
| /api/upload | POST | Upload file payload (pdf/text) and index it |
| /api/index | POST | Index source text/url |
| /api/index | GET | List indexed entries |
| /api/index/:knowledgeId | GET | Get indexing status |
| /api/verify | POST | Start verification session |
| /api/verify/:sessionId/answer | POST | Submit answer |
| /api/verify/:sessionId/result | GET | Get final result |
| /health | GET | Liveness endpoint |

## Tests

```bash
npm test
cd oracle-service && npm test
```

## Troubleshooting

<details>
<summary><strong>Deployment nonce errors (Base Sepolia)</strong></summary>

- If you see nonce mismatch errors, retry deployment from the same deployer key.
- The deploy script includes nonce retry logic and writes deployment output when successful.

</details>

<details>
<summary><strong>Oracle starts but cannot index with KG</strong></summary>

- Check backend status:

```bash
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs oracle --tail=200
```

- Verify Redis password in .env matches compose REDIS_PASSWORD.
- Ensure Oracle can reach FalkorDB on service name falkordb:6379.

</details>

<details>
<summary><strong>HTTPS cert renew issues</strong></summary>

- Ensure DNS A record points to this VPS public IP.
- Ensure port 80 is reachable externally during renewal challenge.
- Run targeted dry-run:

```bash
sudo certbot renew --dry-run --cert-name pocw-oracle.baghici.works
```

</details>
