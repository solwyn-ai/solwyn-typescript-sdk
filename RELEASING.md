# Releasing `@solwyn/sdk`

This checklist publishes the exact package artifact that passed review and verification. Nothing
before [Publish](#publish) changes registry state. Never reuse a version or publish from an
unreviewed working tree.

`0.x` is a public preview. Breaking changes must be identified in `CHANGELOG.md` and the GitHub
release notes before users upgrade.

## Release ownership gate

Before preparing a release, assign people who can complete and recover every external action:

- a GitHub repository owner and npm organization/package owner;
- a release operator and a second recovery owner with working multi-factor authentication;
- a reviewer for SDK behavior, privacy wording, and the final artifact;
- an issue-triage and security-response owner able to meet the commitments in `SECURITY.md`.

Verify live state rather than relying on this file:

```bash
npm whoami
npm org ls solwyn
npm owner ls @solwyn/sdk
npm view @solwyn/sdk versions dist-tags --json
```

Distinguish a package that does not exist from missing authentication, missing scope rights, or a
network failure. A registry `404` does not prove ownership of the `@solwyn` scope. Confirm package
publishing access, recovery access, 2FA, GitHub environment protection, required status checks, and
the repository's visibility through the relevant account interfaces.

Also confirm that `LICENSE`, `SECURITY.md`, and every required third-party attribution or notice
are present and correct for the files in the release. A dependency or copied asset with an
unresolved license blocks publication.

## Trusted publishing setup

Stable releases use npm trusted publishing from GitHub Actions. Configure the npm publisher with
these exact values; spelling and case are part of the trust policy:

- GitHub organization: `solwyn-ai`
- repository: `solwyn-typescript-sdk`
- workflow filename: `publish.yml`
- protected GitHub environment: `npm-publish`

The repository and workflow must be public before npm can use this trust relationship. New trusted
publisher configurations are stage-enabled by default; explicitly allow direct publishing for
this workflow. Staged publishing is not part of this release path. Create `npm-publish` before
enabling publication, restrict its deployment branches or tags to the approved release policy,
and require an environment reviewer who is not the release operator.

The publishing job must:

- run on a GitHub-hosted runner with Node.js 22.14 or newer and npm 11.5.1 or newer;
- default to read-only permissions and grant `id-token: write` only to the publish job;
- check out the exact release tag and assert that it is `v${package.json.version}`;
- run or require the release gates for that exact commit;
- pack once, record the artifact digest and file list, test that same tarball, and publish those
  same bytes after protected-environment approval;
- rebuild only by producing a new artifact and rerunning all artifact-dependent checks.

Trusted publishing requires an existing npm package. If `@solwyn/sdk` does not yet exist, follow
[Bootstrap a new package](#bootstrap-a-new-package). Optional npm staged publishing also requires
an existing package and npm 11.15.0 or newer; it is not part of the default release path. The
workflow deliberately fails before artifact creation when the package record is absent.

Publication also has a default-off repository latch. Leave the
`NPM_TRUSTED_PUBLISHING_ENABLED` Actions variable absent during preparation. Set it to exactly
`true` only after the owner authorizes the concrete release, npm trusted publishing matches all
four values above, direct publishing is allowed, and the protected environment is ready. Removing
the variable disables the publish job without weakening its tag, receipt, environment, or OIDC
checks. There is no `NPM_TOKEN` or `NODE_AUTH_TOKEN` fallback.

Treat npm registry configuration as part of the trust boundary. A scoped
`@solwyn:registry` setting overrides the ordinary registry setting, so both automated and manual
publication must assert the effective scoped registry and pass both
`--registry=https://registry.npmjs.org` and
`--@solwyn:registry=https://registry.npmjs.org`. This prevents repository, user, or runner npm
configuration from redirecting the tarball or OIDC exchange.

## Bootstrap a new package

Use this section only when the ownership gate proves that the package does not exist and trusted
publishing cannot yet be configured.

1. Prepare `0.1.0-rc.1` as a real prerelease: set both the manifest version and exported `VERSION`,
   add a dated changelog entry, and run every gate below on the reviewed commit.
2. Obtain explicit approval for the public bootstrap. An authenticated maintainer publishes the
   verified tarball with public access and the `next` tag. Run this block in Bash; it rejects an
   unexpected tarball `publishConfig`, ignores project and user npm configuration, authenticates
   into a disposable user config, clears proxy and custom-CA environment channels, and verifies
   every effective publish setting before sending bytes:

   ```bash
   SDK_TARBALL=/absolute/path/solwyn-sdk-0.1.0-rc.1.tgz
   EXPECTED_VERSION=0.1.0-rc.1
   BOOTSTRAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/solwyn-npm-publish.XXXXXXXX")"
   trap 'rm -rf -- "$BOOTSTRAP_DIR"' EXIT
   tar -xOf "$SDK_TARBALL" package/package.json > "$BOOTSTRAP_DIR/package.json"
   node --input-type=module - "$BOOTSTRAP_DIR/package.json" "$EXPECTED_VERSION" <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";
   const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
   assert.equal(manifest.name, "@solwyn/sdk");
   assert.equal(manifest.version, process.argv[3]);
   assert.deepEqual(manifest.publishConfig, { access: "public" });
   NODE
   while IFS= read -r name; do
     case "$name" in
       npm_config_*|NPM_CONFIG_*) unset "$name" ;;
     esac
   done < <(compgen -e)
   unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
   unset http_proxy https_proxy all_proxy no_proxy
   unset NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED SSL_CERT_FILE SSL_CERT_DIR
   : > "$BOOTSTRAP_DIR/user.npmrc"
   : > "$BOOTSTRAP_DIR/global.npmrc"
   export NPM_CONFIG_USERCONFIG="$BOOTSTRAP_DIR/user.npmrc"
   export NPM_CONFIG_GLOBALCONFIG="$BOOTSTRAP_DIR/global.npmrc"
   cd "$BOOTSTRAP_DIR"
   NPM_SAFE_ARGS=(
     "--userconfig=$NPM_CONFIG_USERCONFIG"
     "--globalconfig=$NPM_CONFIG_GLOBALCONFIG"
     "--registry=https://registry.npmjs.org"
     "--@solwyn:registry=https://registry.npmjs.org"
     "--proxy=null"
     "--https-proxy=null"
     "--strict-ssl=true"
     "--dry-run=false"
     "--ignore-scripts=true"
     "--access=public"
     "--provenance=false"
   )
   test "$(npm config get registry "${NPM_SAFE_ARGS[@]}")" = https://registry.npmjs.org/
   test "$(npm config get @solwyn:registry "${NPM_SAFE_ARGS[@]}")" = https://registry.npmjs.org
   test "$(npm config get proxy "${NPM_SAFE_ARGS[@]}")" = null
   test "$(npm config get https-proxy "${NPM_SAFE_ARGS[@]}")" = null
   test "$(npm config get strict-ssl "${NPM_SAFE_ARGS[@]}")" = true
   test "$(npm config get cafile "${NPM_SAFE_ARGS[@]}")" = null
   test "$(npm config get ca "${NPM_SAFE_ARGS[@]}")" = null
   test "$(npm config get dry-run "${NPM_SAFE_ARGS[@]}")" = false
   test "$(npm config get ignore-scripts "${NPM_SAFE_ARGS[@]}")" = true
   test "$(npm config get access "${NPM_SAFE_ARGS[@]}")" = public
   test "$(npm config get provenance "${NPM_SAFE_ARGS[@]}")" = false
   npm login "${NPM_SAFE_ARGS[@]}"
   npm publish "$SDK_TARBALL" "${NPM_SAFE_ARGS[@]}" --tag=next
   ```

3. Verify the registry artifact and package ownership. Configure trusted publishing against the
   exact repository/workflow/environment before preparing the stable release.
4. Prepare `0.1.0` as a separate commit and artifact, repeat every gate, and publish it through
   trusted publishing. Never relabel RC bytes as stable.

A maintainer bootstrap from a workstation has no GitHub Actions provenance. Record that limitation
in the RC release notes; the stable trusted-published release must have its own provenance.

## Prepare the release

1. Start from the reviewed release commit with no unrelated working-tree changes.
2. Confirm the target version is absent from both Git tags and npm. Never assume `latest` or reuse
   a published version.
3. Update these together:

   - `package.json` `version`;
   - `src/index.ts` exported `VERSION`;
   - the dated `CHANGELOG.md` section and comparison links, when present.

4. Review public-preview and breaking-change notes, supported runtime/compiler/provider claims,
   known limitations, outage policy, and privacy wording against the current source and tests.
5. Confirm the package metadata, README links, repository URL, issue route, and release notes are
   public and self-contained.

Release copy must preserve these data and outage boundaries:

- Your LLM calls go directly to your provider. Solwyn receives usage and operational metadata,
  plus tags you explicitly supply. Prompt and response content is not sent to Solwyn or logged by
  the SDK. The drop-in client inspects content locally only for length-based estimation and
  cross-dialect translation. Tags are transmitted verbatim and must contain no sensitive data.
- Solwyn Cloud owns real provider/model pricing. The SDK's
  `$0.00003 × estimated input tokens` calculation has exactly two local uses: outage
  decisions/bucketing and the `estimatedCost` diagnostic on denial errors, including live Cloud
  denials. Applicable retained project or exact-run hard-deny authority is checked first during an
  outage. `failOpen: true` otherwise allows and accrues the estimate in a UTC-day local bucket.
  `failOpen: false` denies without a prior successful budget snapshot, but can allow while locally
  accrued estimates plus the new estimate remain within a last-known limit. A tag-period denial is
  not retained as authority for later selectors. Live enforcement mode comes from the Cloud
  response; constructor `budgetMode` only labels SDK-local outage results.

## Run the release gates

Use the repository's pinned package manager. Run the complete suite on the release commit:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm test:dist
pnpm surfaces:check
pnpm check:public
```

Build must precede distribution and artifact checks. The unit suite is offline and must not call
real providers. Provider-surface drift requires review; never edit generated fingerprints merely
to make a gate pass.

The public-preview compatibility baseline is evidence that must remain green or be revised
explicitly with the manifest and public documentation:

- full quality, package, consumer, and AI integration lanes are Node.js `22.23.2` and `24.21.0`;
  if `engines.node` remains `>=20`, test exact final Node.js `20.20.2` in a separately labeled
  provider-free installed core, `./node`, and `./testing` lane and document that the current
  development toolchain and Vercel AI SDK 7 require Node.js 22 or newer. The `./ai-sdk` entry is
  deliberately excluded from Node 20 because its peer requires Node 22. Node.js 20 is end-of-life,
  so that lane is compatibility evidence, not a maintenance promise;
- strict ESM/CommonJS declaration consumers pass with TypeScript 5.8.3 (the tested floor) and
  6.0.3 (the tested current compiler), with `skipLibCheck: false`;
- deeper installed checks exercise OpenAI 6.45.0 and Anthropic 0.123.0 native types, Anthropic
  0.123.0 runtime, Vercel AI SDK 7.0.14 types/runtime, and Google GenAI 0.3.1 plus 2.20.0 native
  lifecycle behavior;
- provider-surface floor/latest boundary cells separately check OpenAI 4.41.0 and 6.45.0,
  Anthropic 0.30.0 and 0.123.0, Bedrock Runtime 3.422.0 and 3.1124.0, Google GenAI 0.3.1 and
  2.20.0, Together AI 0.16.0 and 0.50.0, plus Google Generative AI 0.24.1 as its reviewed cell.

Do not describe two boundary cells as continuous support evidence or full runtime/type coverage
for intervening versions. If a floor or current version changes, update the fixtures, lockfiles,
CI matrix, manifest peer range, README, and release notes together.

Create one candidate tarball in a clean release checkout and a dedicated directory outside that
checkout. The create command invokes `npm pack` exactly once and writes the tarball plus
`release-artifact-receipt.json`; the receipt binds the package name/version, source commit, sorted
file list, size, SHA-256, SHA-1 shasum, and SHA-512 integrity. Every later command verifies and
consumes those exact bytes:

```bash
mkdir -p /absolute/path/release-artifacts
RELEASE_COMMIT="$(git rev-parse HEAD)"
RELEASE_VERSION="$(node -p "require('./package.json').version")"
SDK_TARBALL="/absolute/path/release-artifacts/solwyn-sdk-$RELEASE_VERSION.tgz"

node scripts/release-artifact.mjs create \
  --out /absolute/path/release-artifacts \
  --ref "$RELEASE_COMMIT"

node scripts/release-artifact.mjs verify \
  --tarball "$SDK_TARBALL" \
  --receipt /absolute/path/release-artifacts/release-artifact-receipt.json \
  --ref "$RELEASE_COMMIT" \
  --version "$RELEASE_VERSION"

pnpm test:pack -- \
  --tarball "$SDK_TARBALL" \
  --out /absolute/path/outside-the-repository/pack-results
pnpm test:consumers -- \
  --tarball "$SDK_TARBALL" \
  --out /absolute/path/outside-the-repository/consumer-results
npm publish --dry-run \
  "$SDK_TARBALL" \
  --ignore-scripts
```

The package must include the four public entries (`.`, `./node`, `./ai-sdk`, and `./testing`),
declarations, source maps, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`, with no source,
tests, private material, credentials, or unexpected files. Scan the unpacked artifact, including
source-map `sourcesContent`:

```bash
mkdir -p /absolute/path/release-artifacts/unpacked
tar -xzf "$SDK_TARBALL" \
  -C /absolute/path/release-artifacts/unpacked
pnpm check:public \
  --artifact-dir /absolute/path/release-artifacts/unpacked
```

Retain the receipt with the review evidence. Any source, manifest, build output, or other package
input change invalidates the artifact and every dependent check; remove the old artifact directory,
create a new artifact, and start those checks again. Never call bare `test:pack` in a release flow,
because its convenience mode builds and packs a different tarball.

## Tag and approve

Create an annotated tag only after the release commit and local gates are approved:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Confirm that the tag resolves to the reviewed commit and that `package.json` and exported
`VERSION` both equal `X.Y.Z`. The publish workflow accepts a `v*` tag push or a manual dispatch
whose required `tag` input names an already-existing tag. Both paths check out that tag, require it
to be exactly `v${package.json.version}`, require the tag to resolve to the checked-out commit, and
require a successful complete `CI` run for that exact commit on `main`. A manual dispatch must use
the same tag as both its workflow ref and its input so GitHub's provenance identifies the release
tag rather than the default branch:

```bash
gh workflow run publish.yml --ref vX.Y.Z -f tag=vX.Y.Z
```

Use these exact CI check names when configuring the branch ruleset:

- `Required / CI` — the stable required check and fan-in for every gate below;
- `Quality / Node 22` and `Quality / Node 24`;
- `Package artifact`;
- `Consumers / Node 22` and `Consumers / Node 24`;
- `Legacy runtime / Node 20.20.2`;
- `Provider surface catalog` and every `Provider surface / <family> / <interval>` matrix cell.

`Required / CI` must be required on `main`; do not require only a subset of its underlying jobs.
The scheduled run selects all six latest provider cells, while pull requests and pushes run all 11
reviewed floor/latest cells.

## Publish

Push the protected exact tag or dispatch `publish.yml` with that tag. A release run has these exact
job names: `Verify release commit`, `Build release artifact`,
`Verify release artifact / Node 22`, `Verify release artifact / Node 24`, and `Publish to npm`.
The first job requires the successful complete CI run for the resolved commit. The build job packs
once and uploads only its tarball and receipt. Both verification jobs download, reverify, and test
that artifact. Only then can the `npm-publish` environment reviewer approve `Publish to npm`.

The protected job re-downloads the same artifact, rechecks its receipt, commit, tag, version,
Node/npm minimums, and registry availability, and does not install project dependencies, build, or
pack. It grants `id-token: write` only for that job and publishes with public access and provenance.
The command pins `https://registry.npmjs.org` so repository or runner npm configuration cannot
redirect the release. Prerelease versions always use the `next` dist-tag; only a version without a
prerelease suffix uses `latest`.

Every release version and channel shares the single `npm-publish-solwyn-sdk` concurrency group;
queued runs are never allowed to cancel an in-progress release. Immediately before publication,
the workflow fetches the current `latest` and `next` values from the npm packument and rechecks that
the candidate is absent. A stable candidate must be greater than the current `latest`; a
prerelease must be greater than both current `latest` and current `next`. Missing first-use tags are
allowed, while malformed, dangling, equal, or decreasing tag values fail closed. This prevents two
workflow runs from racing a channel backward. It does not serialize a separate workstation
publication, which remains prohibited for stable releases and must not run concurrently with CI.

Do not publish stable releases directly from a workstation, rebuild between final verification and
publication, use `--force`, or move a stable dist-tag to unverified bytes.

Create the GitHub release from the published tag. Use the matching changelog section as the basis
for release notes, including preview status, breaking changes, migration guidance, and known
limitations.

## Verify the registry release

Inspect the exact published version rather than an implicit dist-tag:

```bash
npm view @solwyn/sdk@X.Y.Z version dist.tarball dist.integrity dist.shasum --json
```

In a new directory outside every repository, clear `NODE_PATH`, install
`@solwyn/sdk@X.Y.Z` with no provider SDKs, and repeat the provider-free ESM/CommonJS and public-entry
smokes. Then verify:

- the registry integrity and unpacked file list match the approved publication receipt;
- manifest version and exported `VERSION` match;
- the npm package page renders the README and links to the correct public repository;
- the npm package page's provenance statement identifies `solwyn-ai/solwyn-typescript-sdk`,
  `.github/workflows/publish.yml`, the exact tag, and the receipt's commit (a manual bootstrap RC
  is the documented exception and must say that it has no GitHub Actions provenance);
- an exact-version provider-backed consumer works with mocked provider and control-plane traffic;
- the public documentation installs the exact released version successfully.

Treat missing provenance, a provenance identity mismatch, or a registry digest mismatch as a bad
release even when imports work. A stable publication assigns `latest` in the atomic publish step;
if verification fails, follow the bad-release procedure immediately. Only after these checks pass
should public documentation point to the release and an announcement be made.

## Respond to a bad release

Never reuse, overwrite, or silently unpublish a published version. Stop promotion, document the
impact, prepare a corrected patch, and repeat the full artifact workflow. Deprecate only the
affected version with a concise migration target:

```bash
npm deprecate @solwyn/sdk@X.Y.Z "Known issue — upgrade to X.Y.(Z+1)"
```

Publish the fixed patch, verify it from the registry, update release notes and documentation, and
remove the deprecation only if the original version is genuinely safe again. Handle suspected
credential or private-content exposure through the security incident process; deleting repository
content after publication does not undo distribution. For a compromised trusted-publishing path,
remove `NPM_TRUSTED_PUBLISHING_ENABLED`, stop environment approvals, remove or replace the npm
trusted publisher, preserve evidence, and follow the security incident process before publishing a
replacement version.
