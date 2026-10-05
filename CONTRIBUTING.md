# Contributing

Thanks for helping improve agent-web-search!

## Setup

Requires Node.js >= 22 and [pnpm](https://pnpm.io) (pinned via `packageManager`).

```sh
pnpm install
pnpm test        # vitest with coverage
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm format      # biome check --write
pnpm build       # ESM + CJS builds into dist/
pnpm check:browser  # verify the library bundles for the browser platform
```

## Project layout

- `source/types/` — Zod schemas and TypeScript types (the normalized shapes).
- `source/core/` — client, HTTP/retry layer, dispatch gate, aggregation, formatting.
- `source/adapters/` — one file per engine.
- `source/tools/` — LLM tool definitions (Anthropic / OpenAI / AI SDK).
- `source/mcp/` — MCP stdio server (Node-only).
- `source/cli.ts` — the `agent-web-search` binary (Node-only, ESM-only).
- `test/fixtures/` — recorded, sanitized provider payloads for contract tests.

Everything importable from the package root must stay browser-safe — no
Node builtins. CI enforces this with `pnpm check:browser`.

## Adding a new engine adapter

1. **Create `source/adapters/<engine>.ts`.** Copy the closest existing
   adapter as a starting point (`ceramic.ts` is the simplest GET/POST shape;
   `exa.ts` shows content options; `sonar.ts` shows streaming). Implement
   `buildRequest` and `parseResponse` and declare honest `capabilities` —
   anything the provider can't do must be `false` so the client can emit
   `unsupported_param` warnings instead of silently dropping params.
2. **Pick the right config schema.** Use `KeyedEngineConfigSchema` when the
   provider needs an API key; extend `EngineConfigSchema` for keyless or
   self-hosted engines (see `searxng.ts`).
3. **Register it.** Add the adapter to `builtInAdapters` and the exports in
   `source/adapters/index.ts`, add the engine id to `builtInEngineIds` in
   `source/types/index.ts`, and re-export from `source/index.ts`.
4. **Wire the CLI.** Add an entry to `engineEnvSources` in `source/cli.ts`
   and mention the env var in the CLI help text.
5. **Add a package export.** Add `./adapters/<engine>` to the `exports` map
   in `package.json`, mirroring the existing entries.
6. **Record a fixture.** Add a sanitized real response as
   `test/fixtures/<engine>.json` and an expectation entry in
   `test/contract.test.ts`. Strip anything sensitive (keys, tokens,
   personal data) and shrink it to a few results.
7. **Add a live test hook.** Add the engine's env var to `test/live.test.ts`
   and to `.github/workflows/live.yml`.
8. **Document it.** Add the engine to the README table and the capability
   matrix.
9. **Add a changeset.** Run `pnpm changeset` and describe the addition.

## Releases

Follow the [release checklist](./RELEASE.md) for setup, publishing, and verification.

Versions and changelogs are prepared with [Changesets](https://github.com/changesets/changesets).
Every user-facing change should include a changeset (`pnpm changeset`).

Prepare each release manually:

1. Run `pnpm changeset version` to apply pending changesets and update the
   package version and changelog.
2. Commit the version and changelog changes and merge them to `main`.
3. Create a GitHub Release for that merged commit with a tag of
   `v<package.json version>` (for example, `v0.2.0`), then publish the release.

The release workflow checks out the tagged commit, verifies the tag matches
the package version, and runs tests, type checking, the build, package-export
checks, and browser checks before publishing. Stable releases use the npm
`latest` tag; GitHub prereleases use `next`. Prepare a prerelease package
version with Changesets before publishing a GitHub prerelease.

Publishing authenticates exclusively through
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) using
GitHub OIDC. The workflow publishes with provenance and uses the existing
GitHub environment named `npm`.

Before publishing the first release, configure a GitHub Actions trusted
publisher in the npm settings for `agent-web-search`:

| Field | Value |
| --- | --- |
| Organization or user | `hbmartin` |
| Repository | `agent-web-search` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed action | Direct publishing with `npm publish` |

Use only the workflow filename, including the extension. The repository,
workflow, and environment values must match exactly. Trusted publishing
automatically generates provenance for this public repository and package.

After the first intended release confirms OIDC authentication and provenance,
select **Require two-factor authentication and disallow tokens** in the npm
package's **Publishing access** settings. Revoke obsolete npm publishing
tokens and remove the unused `NPM_TOKEN` secret from GitHub, including the
`npm` environment if it was stored there. Local package dry runs verify
contents; verifying registry trust requires an intended release.

## Code style

Biome enforces formatting and an intentionally strict lint config — run
`pnpm format` before committing. Tests use Vitest; fixtures over mocks where
practical. Keep adapters dependency-free: `zod` is the only runtime
dependency (and it's a peer).
