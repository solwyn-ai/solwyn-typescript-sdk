## Summary

Describe the user-visible outcome and why the change is needed.

## Changes

- <!-- Describe one concrete change. -->

## Verification

List the exact commands and focused scenarios you ran. Do not include credentials, prompt or
response content, sensitive tags, customer/account data, private URLs, or personal paths.

- [ ] `pnpm check`
- [ ] Focused tests for the changed behavior
- [ ] `pnpm test`
- [ ] `pnpm build` followed by relevant dist/package/consumer checks
- [ ] `node scripts/check-public-surface.mjs`
- [ ] Provider-surface review, if an intercepted provider surface changed

## Compatibility and release notes

- [ ] I described any public API, wire-contract, runtime, provider-peer, packaging, or behavior change.
- [ ] I added tests for behavior changes.
- [ ] I updated public documentation where users need new guidance.
- [ ] I updated `CHANGELOG.md` for a user-visible or breaking change, including migration guidance.
- [ ] This change is backward compatible, or the breaking change is clearly identified for the public preview.

## Privacy and public-surface review

- [ ] Prompt and response content stays inside the approved local estimation, translation, or AI middleware boundary and is never logged or sent to Solwyn.
- [ ] Tags remain explicit, non-sensitive attribution and are never inferred from content.
- [ ] Tests and examples use synthetic data; logs and errors contain only structural diagnostics.
- [ ] No internal plans, review transcripts, private links, personal paths, credentials, customer data, or sensitive source-map content are included.
- [ ] New dependencies, copied code, fixtures, and assets have compatible licenses and required notices.

Suspected vulnerabilities must not be disclosed in this pull request. Follow
[SECURITY.md](../SECURITY.md) instead.
