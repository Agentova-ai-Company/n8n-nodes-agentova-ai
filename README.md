# n8n-nodes-agentova-ai

Official n8n community node for the **Agentova public API v1** (`@n8n/node-cli`, declarative style).

## Status

### B1 — npm publishing pipeline

- [x] Project scaffolded (`declarative/custom` template — Bearer token auth, base URL `https://api.agentova.ai/v1`)
- [x] `package.json` conforms to n8n's community node requirements: name `n8n-nodes-agentova-ai`,
      MIT license, `n8n-community-node-package` keyword, `publishConfig.access=public` +
      `publishConfig.tag=alpha` (for the `0.0.1-alpha` prerelease)
- [x] `.github/workflows/publish.yml` — publishes to npm with provenance on push of a
      `*.*.*` version tag
- [x] `.github/workflows/ci.yml` — lint + test + build on every PR/push to `main`/`dev`

### B2 — credentials & main node

- [x] `AgentovaApi` credential: Bearer auth (`agk_live_...`), connection test against
      `GET /automations?limit=1`
- [x] `Automation` resource: List (cursor pagination, filters on `status`/`type`/`agent_id`),
      Get, Activate, Pause — matches the v1 API contract exactly
- [x] `Automation ID` fields use a Resource Locator (`From List` + `ID` modes), per n8n's
      verification UX guidelines, backed by `GET /automations`
- [x] Vitest suite (`npm test`): the list-search helper, and a regression guard checking the
      node's `status`/`type` enums against the API contract
- [x] Credential exposes a **Base URL** field (default: production) — swap it for a mock or the
      test workspace without touching code

### B3 — trigger node

- [x] `AgentovaTrigger`: `webhookMethods.default.{checkExists,create,delete}` subscribe/unsubscribe
      on workflow activation/deactivation, no duplicate subscription on n8n restart
- [x] 3 selectable events (`automation.status_changed`, `lead.created`, `run.completed`), matching
      the contract's `WebhookEvent` enum exactly
- [x] Incoming deliveries are verified against `X-Agentova-Signature` (HMAC-SHA256 on the raw
      body, constant-time comparison, 5-minute anti-replay window) before starting the workflow —
      an unsigned or forged request is rejected with `401` and never reaches it
- [x] `checkExists` re-checks `GET /webhooks` and forgets a subscription that was deleted or
      disabled after prolonged delivery failures, so n8n recreates it instead of staying silently
      unsubscribed
- [x] Vitest suite covers the full webhook lifecycle: create/delete, signed/invalid/stale
      deliveries, and the `checkExists` edge cases above

## Develop locally

```bash
npm install
npm run lint
npm test
npm run build
npm run dev   # runs a local n8n instance with this node loaded
```

The credential's **Base URL** field defaults to `https://api.agentova.ai/v1` (production). Leave
it as-is unless Agentova gives you another URL — a local mock, or the test workspace promised at
the 80% milestone.

## API contract

- **Source of truth**: `annexes/openapi-v1-draft.yaml`, provided by Agentova with the brief. It
  wins over any code, doc or mock — the node's enums are checked against it in `npm test`.
- **Local mock**: `npx @stoplight/prism-cli mock annexes/openapi-v1-draft.yaml` starts a server
  on `http://127.0.0.1:4010` that answers the contract's routes with its examples. Point the
  credential's Base URL at it. It simulates neither persistence between calls, nor real webhook
  delivery, nor rate limiting.
- **Availability of the real API** is described at the top of the file (`info.description`): a
  route not served yet answers `404 route_not_found`.
- The contract is not edited in this repo. Any gap between the contract and observed behaviour
  is reported to Agentova; every contract change is announced (see the changelog in the file).

## Publishing

Publishing is done by the `publish.yml` GitHub Action, triggered by pushing a `*.*.*` tag. The
very first version is published manually by Agentova to create the package on npm (npm Trusted
Publishing can only be configured on a package that already exists) — every version after that
goes exclusively through this pipeline. See the workflow file for the npm Trusted Publisher
setup.

## Notes

- No secret/key ever committed — npm publishing uses OIDC Trusted Publishing (no `NPM_TOKEN`
  needed once configured on npmjs.com).
