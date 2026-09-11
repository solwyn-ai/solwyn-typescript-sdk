# Installed-package verification

Run these checks before publishing an SDK artifact. They install the supplied tarball into OS
temporary consumers, clear `NODE_PATH`, and use mocked provider/control-plane requests at runtime.
Setup may download public npm dependencies. No private review documents, historical commits,
workspace provider links, or pre-existing npm cache are required.

```sh
pnpm install --frozen-lockfile
pnpm test:pack
pnpm test:pack -- --tarball /absolute/path/solwyn-sdk.tgz
pnpm test:consumers -- --tarball /absolute/path/solwyn-sdk.tgz --out /absolute/output/path
```

`test:pack` builds and packs only when `--tarball` is absent. Supplying a tarball always tests those
bytes unchanged. `test:consumers` requires both absolute paths and never builds or packs the SDK.
The output directory must be outside the checkout. Standalone `--` forwarding is accepted.

Use Node 22 or newer to run the complete driver: the real-browser control uses the global
`WebSocket` API. Also install npm, pnpm, `tar`, and a Chromium browser. Set
`SOLWYN_VERIFICATION_BROWSER` to an absolute Chromium executable if automatic discovery cannot
find it. The browser runs headless with an isolated temporary profile and checks the exact
`edge-browser-bundle.js` emitted by `bundle-proofs` in the chosen output directory.
Its temporary profile is removed by default; `SMOKE_KEEP=1` retains the profile for debugging.
On Windows the shared package-manager launcher invokes the installed npm/pnpm JavaScript CLI
through Node (or a native `.exe`) with a literal argument array, never a `.cmd` shell command.
Install npm/pnpm alongside Node or expose their installation on PATH; `npm_execpath` from the
invoking package manager is also recognized. Missing CLI resolution fails immediately.

For runtime coverage across installed Node executables, set
`SOLWYN_VERIFICATION_NODE_BINARIES` to a JSON array of absolute executable paths. For example:

```sh
export SOLWYN_VERIFICATION_NODE_BINARIES='["/opt/node20/bin/node","/opt/node22/bin/node","/opt/node24/bin/node"]'
```

Omitting it runs the current executable. Results record the exact binaries and versions that
actually ran; one local version does not establish coverage of the full supported Node range.

## Required probes

| Probe | Durable assertions |
| --- | --- |
| `package-consumers` | Installed manifest realpath beneath each consumer and dynamic core/`./node` `VERSION` equality in ESM/CJS while core, node, testing, and AI entries resolve beneath that manifest; optional provider/tokenizer absence by module resolution; export targets and package file inventory; provider-free core/node/testing `.mts` and `.cts`; `ESNext.Disposable` positive and missing-lib negative controls; separate AI-peer consumer checking all four strict declarations and runtime entries; a clean strict compile of the README `ai` + `@ai-sdk/openai` imports; core and AI buffered/streaming dispatch, check, confirmation, ingest; manifest-bound mixed-format run enforcement, wrapper brands and error families in both import orders; copied-tarball missing-export rejection. |
| `native-type-consumer` | Genuinely installed OpenAI/Anthropic native typing, strict installed Responses fixtures, explicit compiler floor/current cells. |
| `ai-type-consumer` | Strict installed AI consumer and upstream baseline diagnostics; explicit compiler floor/current cells. The separate TypeScript 5.7.3 CJS diagnostic must be `upstream-invalid` with a normal nonzero compiler exit and TS1479. It never replaces a required floor/current cell or masks an SDK consumer failure. |
| `bundle-proofs` | Sixteen Node bundle controls, browser-target VM controls, edge bundle generation and artifact/bundle hashes. |
| `browser-proof` | Actual headless browser executes the verified edge bundle; no browser or missing bundle is a failure. |
| `runtime-matrix` | Every configured Node binary in ESM/CJS: installed-manifest realpath and dynamic `VERSION` identity across the entries each cell loads; package operation; manifest-bound mixed-format identity/run enforcement; native Anthropic promise behavior; foreign AWS Bedrock-control/S3 clients and subclasses rejected without requests; and all 11 error families with denial/stop/middleware enforcement. |
| `google-native-compat` | Separate genuine `@google/genai@0.3.1` and `@google/genai@2.20.0` installations; native lifecycle, cancellation and timeout controls. The driver supplies `--expose-gc`. |

Each probe also runs directly as `node scripts/verification/<probe>.mjs --tarball ABS --out ABS`
(add `--expose-gc` before the Google script). Browser proof requires bundle proof to run first
against the same tarball and output directory. Every report uses the required schema:

```text
{ schemaVersion: 1, probe, status, artifact: { path, sha256 }, versions,
  checks, details, failure, cleanup: { keepRequested, roots, failure } }
```

`checks` is canonical semantic evidence; `details` contains diagnostics and is never an acceptance
fallback. Missing/unknown schema versions, legacy-only evidence, incomplete/tampered checks,
skipped probes and unsuccessful commands fail the gate. Artifact identity must match the supplied
canonical path and SHA-256. `versions.node`, `checks`, `details`, both failure fields, and all
cleanup fields are required. `failure` may be null while a failed/incomplete report is in progress;
PASS requires both failures null and every root removed or intentionally retained.

Installed Node consumers resolve `@solwyn/sdk/package.json` with a `createRequire` rooted in the
generated consumer itself. They require that manifest's realpath to remain beneath the consumer,
require every loaded SDK entry target to remain beneath the manifest's package root, and compare
the imported core and `./node` `VERSION` values with the manifest version. Run-validation wrappers
also require the fixture's SDK root to be that same installed package. These checks are dynamic;
no release version is baked into the verifier. The aggregate driver invokes the probe-owned
package-consumer and runtime-matrix identity validators against `checks.artifactIdentity` and the
reported SDK version, so missing or inconsistent identity evidence cannot be accepted afterward.

The aggregate independently checks compiler formats/versions, the configured runtime matrix,
the exact 16 bundle labels plus registration/dispatch/check/confirmation/ingest counts, and every
scenario-specific timer, cancellation, reader-release and GC result in all 16 Google controls.
Correct checks pass without legacy diagnostic fields; valid-looking diagnostics cannot rescue
altered checks. `results.json` uses the same envelope with probe `verification`: `checks.probes`
holds the status summary and `details.probes` retains individual reports, commands and diagnostics.
Re-running clears the known previous probe results and bundle so stale successes cannot count.

Package commands have a 180-second wall deadline; the aggregate bounds each complete child probe
at 900 seconds. The native and AI type probes use the same bounded launcher for package setup and
also bound their SDK-resolution, compiler, and inference children. These use asynchronous process
supervision, not `spawnSync` signal timeouts.
Each command runs beneath a live Node ownership anchor: the anchor owns the process group on
macOS/Linux, or the tree targeted by `taskkill.exe /T /F` on Windows. Actual command exit is relayed
over IPC and does not release the anchor's identity while inherited pipes remain open. The launcher
allows 500 ms for those pipes to drain, then terminates only the still-live anchor group/tree. Once
the anchor exits, its former identifiers are never signaled. Parent IPC disconnect and source or
destination pipe errors trigger anchor cleanup; forwarded output obeys stream backpressure.
A bounded disconnect/unreference fallback applies when group termination itself fails: the anchor
can attempt its own disconnect cleanup, while the original termination error remains in evidence.
There are no global PID/PPID scans. A descendant that deliberately creates a new session/process group
can escape this boundary; this is not hostile-process containment. The browser uses the same live
anchor primitive for its long-lived process.
The caller still returns within its deadline plus at most 500 ms of cleanup. Captured pipes are then
closed so an unresponsive process cannot hold the caller open. Results retain stdout/stderr,
elapsed time, the configured deadline, timeout flag and termination diagnostics. A running
command record is written by `package-consumers` before setup starts. Its setup timeouts and
recognized npm network errors (including DNS `ENOTFOUND`) are marked separately in
`failure` as retryable setup failures, not artifact-check failures. The aggregate records
its own outer timeout and preserves any structured failure a child supplies. The native and AI
type probes likewise persist the failing setup step, retryability, artifact-failure attribution,
and command error code before exiting. Raw command output remains diagnostic; the aggregate does
not infer that every failure is a network fault. The gate exits
nonzero in all these cases.
Missing or non-executable tools such as `tar` are prerequisite failures with
`artifactFailure:false`. A tool that actually runs and rejects malformed archive bytes remains
an artifact-check failure; the classifier does not conflate a spawn error with an archive error.

The package smoke uses the checkout's installed TypeScript compiler but resolves every SDK type
from its temporary consumer. The full type probes establish the explicit compiler floor/current
matrix. AI types require a separate consumer with the genuine AI and Node declaration packages;
the provider-free runtime still loads the AI entry with no AI peer. No declaration stub or
`skipLibCheck` escape is used. A separate clean README-shaped consumer extracts the install fence
and TypeScript fence from the supplied artifact's own README. The customer command remains
`npm install ai @ai-sdk/openai`; the verifier requires those extracted names to exactly match its
reviewed lock map, then installs `ai@7.0.14` and `@ai-sdk/openai@4.0.65` alongside the candidate SDK
as the only runtime dependencies. Current upstream AI declarations additionally require the
verification-only development packages `@types/node@22.15.30` and
`@types/json-schema@7.0.15` when compiled with the exact TypeScript compiler, `strict: true` and
`skipLibCheck: false`; they are not SDK runtime or README installation prerequisites. The lane
compiles the extracted source with `types: ["node"]` and the documented `ESNext.Disposable`
library. The provider-free declaration lane repeats that library configuration and proves a
compile without `ESNext.Disposable` fails on the public async-disposal surface. The locked
broad-entry smoke's AI dependencies are pinned to `ai@7.0.14`,
`@types/json-schema@7.0.15`, `@types/node@22.15.30`, and `zod@4.4.3` in the checked-in
`fixtures/ai-smoke/package.json` and `package-lock.json`. The probe copies both files to its
temporary consumer and runs `npm ci --ignore-scripts --omit=optional --legacy-peer-deps` with an
isolated cache. It adds the supplied SDK using `--no-save`, with lockfile reading enabled, then
verifies every installed locked package's exact version and realpath. The full installed tree,
including nested dependencies, must match the lock plus the reviewed SDK; unpinned extras fail.
Both the fixture and consumer lock
must remain unchanged. Evidence retains `ai-smoke-package.json`, `ai-smoke-package-lock.json`,
the lock SHA-256, and all resolved package versions/paths even after consumer cleanup. Dependency
updates require an explicit reviewed fixture-lock update; ordinary runs never regenerate it.

Package inventory is a complete reviewed 88-file shape, not just a shipping allowlist: four
metadata files; four public entries in both runtime, declaration and sourcemap formats; six
provider chunks in both runtime formats with maps; eight shared chunks per runtime format with
maps; and two shared declarations in both formats. Hashed filename suffixes may change with
content. LF and CRLF tar listings are normalized before inventory comparison. Missing entries,
duplicate entries, new unexpected files, and unmatched sourcemaps fail.
Intentional publication layout changes require updating the inventory assertion and its tests.

All verification consumer roots and browser profiles are removed after successful and failed
runs; set `SMOKE_KEEP=1` to retain them for debugging. The aggregate creates one exact temporary
container per probe and passes it through `SOLWYN_VERIFICATION_TEMP_ROOT`; all child consumers and
profiles allocate beneath that container. After a probe exits or is forcibly timed out, the
aggregate removes its own container, even if the child never wrote a final report or ran its
cleanup. It never uses paths from child reports as deletion authority. A simultaneous cleanup
failure is recorded in `cleanup.failure` and the affected root record; aggregate child entries
also retain their container outcome under `consumerCleanup`. The primary child/setup failure or
outer timeout remains in `failure`. Direct probe invocations retain their exact-root cleanup.
Cleanup failure makes the gate fail and records the observed
retained state; it cannot leave a stale PASS report. Paths and retention/cleanup evidence remain
in results even after removal. No cleanup uses a prefix or glob.
The negative export control extracts a separate copy, changes its AI
export target, repacks and installs that copy, and requires module loading to fail for that exact
missing target. It never rewrites the reviewed artifact.

Catchable SIGINT/SIGTERM invokes the shared lifecycle: stop active owned anchors, remove registered
roots, persist interruption/cleanup evidence, then remove only the lifecycle's signal handlers and
re-raise the original signal. Total teardown is bounded to two seconds. A second signal forces
exit with the original signal; unfinished cleanup is explicitly recorded as failed, not reported
as successful removal. Unregistered paths and replaced/symlinked roots are never deleted.
Report destinations beneath roots being removed are suppressed before shutdown, including later
finalizer writes; external report destinations still receive cleanup state. Finalized writers are
unregistered, so subsequent signals cannot recreate discarded output directories.
SIGKILL or host failure cannot run these handlers and may leave temporary roots; parent-owned
containers cover killed child probes, not termination of the aggregate itself.
The real POSIX signal fixtures explicitly skip Windows. Native Windows console-event/signal
behavior is **NOT RUN** by those fixtures; the separate Windows taskkill/IPC simulations do not
claim to prove console-event delivery.

## Module ownership

- `process.mjs` is the leaf for bounded commands, npm/pnpm resolution, classification and live
  ownership anchors. It never imports support or a concrete probe.
- `support.mjs` owns canonical arguments/outside-checkout validation, environment sanitation,
  hashes, schema creation/validation/writing, private temporary ownership and signal cleanup.
  Writers take a full filename: `writeReport(file, report)` and `finalizeReport(report, file)`.
  A root created by `createTemporaryRoot(prefix, report, options)` is registered privately;
  editing report paths does not grant cleanup authority.
- `runtime-support.mjs` contains runtime-family command/install/run helpers and depends only on
  the shared modules. Concrete probes never import generic infrastructure from another probe.
- `artifact-identity.mjs` owns side-effect-free identity generation, the ordered run-validation
  fixture catalog and wrapper source, and the package/runtime identity validators. Both concrete
  probes import this owner; neither re-exports its validators.
- `readme-consumer.mjs` side-effect-free extracts the Vercel AI SDK install and TypeScript fences,
  resolves the extracted package names through the reviewed lock map, and validates the observed
  compile evidence. `package-consumers.mjs` compiles that exact extracted source; it does not keep
  a second approximation of the README example.
- `package-consumers.mjs` owns package execution plus its inventory, dependency-tree, and AI
  harness helpers; `pack-smoke.mjs` delegates to it. AI harness entry arguments use file URLs so
  native Windows paths and URL-sensitive characters are loaded correctly.

## Assertion migration

The previous package-consumer export/file checks, optional-peer policy, ESM/CJS runtime and
strict declarations now live in `package-consumers.mjs`. The former pack smoke's legacy budget
result shape, materialized lease fields, testing helpers, local health seam and provider-free
dispatch are retained there. Repository fixtures `package-identity-remediation.mjs`,
`post-remediation-errors.mjs`, and `ai-sdk-harness.mjs` run from copies in the installed consumer.
The native and AI typing, bundle, real-browser, runtime and Google proofs retain their dedicated
probe names. All paths to repository fixtures are resolved from script location.
