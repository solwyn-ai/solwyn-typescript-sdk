# Contributing to `@solwyn/sdk`

Thank you for helping improve the Solwyn TypeScript SDK. The project is a public preview: changes
should be small, testable, and explicit about compatibility. Breaking changes must be documented
in `CHANGELOG.md` and release notes before users upgrade.

## Set up the repository

Use the Node.js range declared in `package.json` and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
```

Provider SDKs are optional peers. Core code must build and run without any provider package
installed; provider-specific development dependencies exist only for tests and surface review.

## Run checks

For most changes, run:

```bash
pnpm check
pnpm test
pnpm build
pnpm test:dist
```

Before requesting release review, also run the installed-package and public-surface checks:

```bash
pnpm test:pack
node scripts/check-public-surface.mjs
pnpm surfaces:check
```

The consumer verifier accepts an exact tarball and writes results outside the repository:

```bash
pnpm test:consumers -- \
  --tarball /absolute/path/solwyn-sdk-X.Y.Z.tgz \
  --out /absolute/path/outside-the-repository/results
```

Build before distribution and package checks. Tests must be offline and deterministic: mock
`fetch` and provider behavior; never call real LLM providers from the test suite. If an installed
provider exposes a changed surface, inspect the change before running `pnpm surfaces:capture`.
Never hand-edit a generated fingerprint to bypass review.

## Preserve privacy and budget behavior

Your LLM calls go directly to your provider. Solwyn receives usage and operational metadata,
plus tags you explicitly supply. Prompt and response content is not sent to Solwyn or logged by
the SDK.

Only `src/privacy.ts`, `src/providers/translation/`, and `src/ai-sdk/` may reference content
fields. For the drop-in client, content may be inspected inside the application process only for
length-based estimates or cross-dialect translation. Keep every other module content-free and do
not log, persist, concatenate, or transmit content. Run the privacy-firewall test after changes
near provider requests, responses, translation, telemetry, errors, or logging:

```bash
pnpm vitest run tests/unit/privacy-firewall.test.ts
```

Tags are explicit attribution metadata. They are transmitted verbatim, must never be inferred
from prompts or responses, and must not contain secrets, prompts, responses, personal data, or
other sensitive content.

Solwyn Cloud owns real provider/model pricing. The SDK's fixed
`$0.00003 × estimated input tokens` calculation has exactly two local uses: outage
decisions/bucketing, and the `estimatedCost` diagnostic on denial errors, including live Cloud
denials. It is not provider/model pricing. Applicable retained project and exact-run hard denials
take precedence during an outage. `failOpen: true` otherwise allows and accrues the estimate in a
UTC-day local bucket. `failOpen: false` denies without a prior successful budget snapshot, but can
allow within a known last budget limit.

Live enforcement mode comes from the Cloud response; `BudgetCheckRequest` does not carry the
constructor's `budgetMode`. That option only supplies the mode attached to SDK-local outage
results, while `failOpen` controls the local allow/deny posture. Preserve these rules and their
scope unless a change explicitly revises the public policy and its tests.

## Keep public content public

Everything committed here can appear in source archives, diffs, Actions logs, package source
maps, issue attachments, or npm artifacts. Do not add:

- internal plans, roadmaps, review transcripts, decision logs, or private issue references;
- personal absolute paths, private repository URLs, customer identifiers, or account details;
- credentials, realistic secret-shaped fixtures, prompt/response samples from real users, or
  sensitive tag values;
- generated reports or source maps containing any of the above.

Use synthetic and sanitized examples. `node scripts/check-public-surface.mjs` checks known policy
violations and broken links/symlinks, but it is not a complete secret scanner or a substitute for
human review.

## Dependencies, licensing, and notices

Keep runtime dependencies minimal. For every new dependency, copied code fragment, fixture, or
asset:

1. record its public source and license in the pull request;
2. confirm its license is compatible with Apache-2.0 distribution;
3. preserve attribution and add or update a third-party notice when its license requires one;
4. confirm the dependency remains external or intentionally included in the packed artifact.

Do not add code or media when ownership or redistribution rights are unclear.

## Open an issue or pull request

Bug reports should include the exact SDK, Node.js, package-manager, module-format, provider-SDK,
and operating-system versions; expected and actual behavior; and a minimal sanitized reproduction.
Prefer the provider-free `@solwyn/sdk/testing` entry when it can reproduce the problem. Remove
keys, content, sensitive tags, private URLs, and account data from logs and examples.

Pull requests should explain the user-visible outcome, list verification performed, and identify
API, wire-contract, privacy, provider-surface, packaging, and compatibility effects. Add focused
tests for behavior changes and update documentation and `CHANGELOG.md` when users need to know
about the change.

Do not report a suspected vulnerability in a public issue or pull request. Follow
[SECURITY.md](SECURITY.md) instead.
