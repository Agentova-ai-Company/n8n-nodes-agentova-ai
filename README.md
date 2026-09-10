# n8n-nodes-agentova-ai

Official n8n community node for the **Agentova public API v1** (`@n8n/node-cli`, declarative style).

## Status — B1: npm publishing pipeline

- [x] Project scaffolded (`declarative/custom` template — Bearer token auth, base URL `https://api.agentova.ai/v1`)
- [x] `package.json` conforms to n8n's community node requirements: name `n8n-nodes-agentova-ai`,
      MIT license, `n8n-community-node-package` keyword, `publishConfig.access=public` +
      `publishConfig.tag=alpha` (for the `0.0.1-alpha` prerelease)
- [x] `.github/workflows/publish.yml` — publishes to npm with provenance on push of a
      `*.*.*` version tag
- [x] `.github/workflows/ci.yml` — lint + build on every PR/push to `main`/`dev`
- Node/credentials content (`Automation` resource: list/get/activate/pause, webhook trigger):
  **out of scope for B1** — the scaffold ships the template's placeholder `User`/`Company`
  resources, replaced with the real Agentova resources in B2/B3.

## Develop locally

```bash
npm install
npm run lint
npm run build
npm run dev   # runs a local n8n instance with this node loaded
```

`requestDefaults.baseURL` and the credential's `test.request.baseURL` point to
`https://api.agentova.ai/v1` (production) — no mock override wired yet, since B1 only proves
the publish pipeline and doesn't call the API. Wiring a mock URL for local development is part
of B2, once the OpenAPI contract file is available (the Zapier connector and doc portal live in
their own separate repositories).

## Publishing

Publishing is done by the `publish.yml` GitHub Action, triggered by pushing a `*.*.*` tag. The
very first version is published manually by Agentova to create the package on npm (npm Trusted
Publishing can only be configured on a package that already exists) — every version after that
goes exclusively through this pipeline. See the workflow file for the npm Trusted Publisher
setup.

## Notes

- No secret/key ever committed — npm publishing uses OIDC Trusted Publishing (no `NPM_TOKEN`
  needed once configured on npmjs.com).
