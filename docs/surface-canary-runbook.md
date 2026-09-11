# Provider surface canary and drift runbook

Use this runbook when a `provider-surface-inventory` cell or the scheduled Monday run
fails. An unclassified provider surface is not an immediate runtime failure: it resolves
to `unknown` and follows the configured `onUnmetered` policy, which defaults to `"warn"`.
The failing canary prevents unnoticed provider-SDK drift from reaching a release.

## 1. Identify

Open the failing cell and download its `provider-surface-<family>-<interval>` artifact.
Actionable lines, in order of information:

- `fingerprint drift: <shape>@<interval> (…counts…)` — structure changed.
- `no reviewed rule or baseline row for '<path>' in <shape>` — the exact new path.
- `Surface canary failed for <family> <version> at '<path>' during unknown_classification|shape_drift` — a reviewed surface no longer matches reality.

## 2. Classify

Classification precedence is `blocked` > `unsupported` > `metered` > `namespace` >
`metadata/infrastructure` > `unmetered_spend`. Decision-bearing paths, including new
escape hatches, spend operations, and `*Command` exports, get a curated rule in
[`src/surface-rules.ts`](../src/surface-rules.ts); everything else is accepted as
baseline evidence. When uncertain, preserve the observation as baseline evidence and
request review before assigning a stronger classification.

## 3. Apply

1. Before capturing a scheduled `latest` drift, read the affected provider package name
   and exact installed version from the failing artifact's `distributions` array.
   Install and pin that release, then update its `latest` row in
   [`tests/provider-surface-intervals.json`](../tests/provider-surface-intervals.json)
   and the corresponding catalog expectations in
   [`tests/unit/real-sdk-surface-inventory.test.ts`](../tests/unit/real-sdk-surface-inventory.test.ts)
   together.
2. Edit [`src/surface-rules.ts`](../src/surface-rules.ts) if curating.
3. After every intended latest provider package is installed to match the latest catalog
   cells, run `pnpm surfaces:capture` to merge fingerprints and baseline evidence for
   all latest cells. `surfaces:capture` never installs `@latest`; it captures the
   installed graph. This convenience command is latest-only. For another catalog cell,
   including a floor cell,
   overlay that cell's corresponding provider packages from
   [`tests/provider-surface-intervals.json`](../tests/provider-surface-intervals.json),
   without changing the frozen lockfile, then run:

   ```bash
   pnpm add --no-lockfile -D <package@catalog-version>
   pnpm tsx scripts/capture-surface-inventory.ts --update --interval <name> --family <name>
   ```

   Do not append `--interval` to `pnpm surfaces:capture`: its script already supplies
   `--interval latest`, and the parser permits that option only once.
4. A floor or other nonlatest overlay changes the installed graph and may transiently edit
   `package.json`. After its focused capture, return `package.json` to the reviewed latest pins,
   verify that `pnpm-lock.yaml` did not change, and force a reinstall from the frozen lockfile:

   ```bash
   pnpm install --frozen-lockfile --force
   pnpm surfaces:check
   ```

   Do this **before** `pnpm check`, the full unit suite, any build/dist/pack gate, or a latest
   capture. Otherwise those gates exercise the floor overlay while appearing to validate the
   release graph. The reinstall restores dependencies; it does not update the lockfile.
5. Update the expected digests in
   [`tests/unit/surface-context-pins.test.ts`](../tests/unit/surface-context-pins.test.ts).
   If the OpenAI graph moved, refresh the [README](../README.md) strict-fingerprint
   example. Review each delta before updating an expectation.
6. Run `pnpm check && pnpm test` only on the restored latest graph.

## 4. PR

- Paste `pnpm surfaces:diff <PR-base-ref>` output.
- Give one sentence per curated rule explaining why its classification is correct; baseline
  acceptances may be summarized in bulk.
- A provider-SDK devDependency bump uses this same loop, started deliberately: bump
  the pin and the catalog's `latest` row together.
- Never disable, skip, or filter the canary to unblock a release; the release path
  (`test:dist`, pack smoke, publish) already excludes it.
