# Release process

Prepare versions and changelogs locally with Changesets, merge the changes,
then publish a GitHub Release. The [release workflow](./.github/workflows/release.yml)
publishes the tagged commit to npm through GitHub OIDC, with provenance.

## One-time npm setup

In the npm settings for `agent-web-search`, add a GitHub Actions trusted
publisher with these values:

| Field | Value |
| --- | --- |
| Organization or user | `hbmartin` |
| Repository | `agent-web-search` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed action | Direct publishing with `npm publish` |

Enter only the workflow filename, including `.yml`. All values must match
exactly. Keep the GitHub environment named `npm` configured in the repository.
See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
for the setup details.

## Stable release

### 1. Prepare a release branch

Start from an up-to-date `main` on a branch for the version changes. Install
dependencies and review the pending changesets:

```sh
pnpm install --frozen-lockfile
pnpm changeset status
```

Every user-facing change should have a changeset. Add missing entries with
`pnpm changeset` before versioning.

### 2. Update the version and changelog

```sh
pnpm changeset version
git diff
node --print "require('./package.json').version"
```

Review `package.json`, the generated `CHANGELOG.md`, and changes under
`.changeset/`. Use the resulting package version for the release tag.
For example, version `0.3.0` requires tag `v0.3.0`.

### 3. Run the release checks

```sh
pnpm run test
pnpm run typecheck
pnpm run build
pnpm exec publint --pack npm
pnpm run check:browser
npm pack --dry-run
```

Check that the package includes the expected ESM and CommonJS builds and
type declarations. The release job repeats the checks before publishing,
using Node 22 at least `22.22.2`, pnpm `11.5.2`, and npm `12.2.0`.

### 4. Commit and merge

Commit the version, changelog, and changeset updates. Include any lockfile
changes if needed. Open a pull request and merge it to `main` after CI passes.

### 5. Publish the GitHub Release

1. Open the repository's
   [Releases page](https://github.com/hbmartin/agent-web-search/releases).
2. Draft a new release.
3. Create a tag named `v<package.json version>` targeting the merged version
   commit. Confirm the commit includes the release workflow.
4. Add release notes from the changelog.
5. For a stable release, leave the prerelease option unchecked.
6. Publish the release.

Publishing triggers the workflow; saving a draft does not. The `published`
event covers both stable releases and prereleases.
[GitHub release event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)

### 6. Verify the result

Open the `release` run in
[GitHub Actions](https://github.com/hbmartin/agent-web-search/actions/workflows/release.yml)
and confirm the `publish` job succeeds. Check the published version and tags:

```sh
npm view agent-web-search@<version> version
npm view agent-web-search dist-tags --json
```

Replace `<version>` with the released package version. Confirm `latest`
points to the stable release and check provenance on the
[npm package page](https://www.npmjs.com/package/agent-web-search).

## Prereleases

Follow the same process, replacing the versioning command in step 2 with:

```sh
pnpm changeset pre enter next
pnpm changeset version
```

Commit the prerelease state under `.changeset/` along with the version and
changelog. Create the matching GitHub tag, such as `v0.3.0-next.0`, and mark
the GitHub Release as a prerelease before publishing. The workflow publishes
it under npm's `next` tag. Verify `next` in step 6.

For later prereleases, add changesets and run `pnpm changeset version`;
prerelease mode stays active until you exit it. When ready for a stable release:

```sh
pnpm changeset pre exit
pnpm changeset version
```

Commit and merge the resulting changes, then create a new stable GitHub
Release with its matching version tag. See the
[Changesets prerelease guide](https://changesets.dev/guide/prereleases)
for the versioning behavior.

## Complete the token migration

After the first intended release verifies OIDC authentication and provenance,
set npm **Publishing access** to **Require two-factor authentication and
disallow tokens**. Revoke obsolete npm publishing tokens and remove the unused
`NPM_TOKEN` GitHub secret wherever it was stored, including the `npm` environment.
This follows [npm's migration guidance](https://docs.npmjs.com/trusted-publishers/).

Package dry runs verify contents. Registry authentication and provenance are
verified by an actual release.

## If a release fails

- **Tag mismatch:** Create a release with the tag matching the version in the
  tagged commit's `package.json`.
- **Authentication failure:** Check the trusted publisher's owner, repository,
  workflow filename, environment, and direct publishing permission. Correct
  the npm settings, then rerun the failed job in GitHub Actions.
- **Build or test failure:** Fix the source and prepare a new version and release.
  Rerunning the old job still checks out the original tagged commit.
- **Version already published:** Check npm before retrying. A published package
  version cannot be reused; changes require a new version and release.
  [npm publishing documentation](https://docs.npmjs.com/cli/v12/commands/npm-publish/)
