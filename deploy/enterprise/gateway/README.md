# Enterprise model gateway

English | [中文](README.zh.md)

The gateway accepts OIDC bearer access tokens from managed Desktop clients, verifies their signature and authorization claims, and forwards only allowlisted DeepSeek Messages requests with a server-held API key. It emits structured audit events without request or response content. A shared Redis store atomically enforces per-subject and per-tenant concurrency limits across gateway replicas. Development mode may use an in-memory limiter; production refuses to start without `REDIS_URL`.

Set `DEEPSEEK_UPSTREAM_BASE_URL` explicitly to an enterprise-approved HTTPS inference service; Compose does not silently send requests to a public model provider. Request and response content is forwarded to that upstream, and this gateway does not provide private inference or change the upstream's data-retention policy. Set the URL to the official DeepSeek API only after the enterprise approves its data handling, and enforce the corresponding outbound network rule.

## Deploy with Docker Compose

Use a pinned repository release or commit. From this directory, copy `.env.example` to `.env`, set the exact issuer, JWKS URL, audience, required scope, tenant claim, and approved model list. Compose supplies a local Redis quota store by default; set `REDIS_URL` to a shared authenticated `rediss://` endpoint when gateway replicas run outside this Compose project. Copy `tenants.json.example` to `tenants.json` and replace its sample entries with the tenant identifiers, model subsets, token ceilings, and concurrency limits authorized by the IdP. The gateway reads this file at startup; restart or replace the service to apply changes. Create `secrets/deepseek_api_key` with the upstream API key and restrict the file to the deployment administrator. Do not commit `.env`, `tenants.json`, or `secrets/`.

The Docker build context is limited to the gateway source, package manifests, lockfile, workspace configuration, and reviewed patches. `.env`, `tenants.json`, and `secrets/` are excluded from both Git and the image build context.

```sh
mkdir -p secrets
sudo chown root:root secrets
sudo chmod 700 secrets
sudo install -o root -g root -m 0440 /dev/null secrets/deepseek_api_key
cp tenants.json.example tenants.json
# Replace the sample tenant names, model lists, and limits before starting the service.
sudo chown root:root tenants.json
sudo chmod 0440 tenants.json
# Write the key using your secret manager while preserving root:root and mode 0440, then:
docker compose up --build -d
```

The gateway container listens only on host loopback port `8080`. Put the organization's TLS reverse proxy in front of it and forward `/anthropic/v1/messages`; configure the managed Desktop `modelGateway` and OIDC `audience` to use the public HTTPS URL. Keep `/healthz` and `/readyz` private to the host or monitoring network. `/readyz` fails when the quota store is unavailable, and model requests fail closed with HTTP 503 until Redis is available. Restrict inbound and outbound traffic with the organization's existing firewall or network policy. Compose applies a read-only filesystem, non-root gateway user, dropped Linux capabilities, and resource limits. Its Redis service uses a persistent volume, AOF with synchronous fsync, no eviction, no host-published port, and its own memory limit. The gateway container process receives supplementary group 0 to read only the root-owned `0440` secret file; do not broaden its host permissions.

## Identity and authorization

Register a public native OIDC client in the enterprise IdP. Configure its loopback PKCE redirect as described in the repository's [enterprise deployment guide](../../../ENTERPRISE.zh.md). The IdP must issue access tokens signed with RS256 and containing the exact configured `iss`, gateway `aud`, `sub`, `exp`, required scope (`scope` or `scp`), and a string claim named by `OIDC_TENANT_CLAIM`. `tenants.json` must list every accepted tenant. Each entry limits the models available to that tenant, the maximum `max_tokens` value in one request, and the number of simultaneous requests across its users. The global model list remains an upper bound, and the per-subject limit remains active. An unknown tenant or a request outside its model or token limit is denied. With `REDIS_URL`, tenant and subject leases are shared across gateway replicas. The store must be available before the gateway starts; Redis errors during requests fail closed instead of bypassing limits. Lease expiry bounds abandoned counters after a process crash.

The service accepts only `POST /anthropic/v1/messages`, rejects other paths, missing or invalid bearer tokens, missing scope, tenants absent from `tenants.json`, models outside the global or tenant allowlists, invalid or over-limit `max_tokens`, oversized request bodies, and excess concurrent requests per subject or tenant. It does not store conversations or tokens. The upstream API key remains in the mounted secret and is never sent to the client.

## Audit and operations

Each model request writes one JSON event to container stdout with a generated request ID, UTC timestamp, validated subject and optional tenant, model, authorization decision, outcome, HTTP status, duration, and token usage reported by the upstream. Prompts, attachments, model responses, access tokens, and the upstream API key are excluded. Forward stdout to the enterprise logging system with restricted access, an approved retention period, and tamper protection. The event stream itself does not provide durable storage or alerting.

Monitor `/healthz`, `/readyz`, upstream errors, authentication denials, rate limits, Redis health, and resource use. Rotate the upstream key through the secret manager and restart or replace the container. IdP key rotation is fetched from the configured JWKS URL. Configure TLS, backups of deployment configuration and the Redis volume, replicas, and log retention in enterprise infrastructure; the example does not include a reverse proxy, persistent audit store, or a highly available Redis topology.

Run the gateway unit and HTTP integration tests from the repository root with `pnpm exec vitest run apps/enterprise-gateway/tests/enterprise-gateway.spec.ts`. Verify shared leases against a running Redis service with `REDIS_URL=redis://127.0.0.1:6379/0 pnpm exec vitest run apps/enterprise-gateway/tests/redis-quota.integration.spec.ts`.
