# Strict coverage controls

[Back to the README](https://github.com/solwyn-ai/solwyn-typescript-sdk/blob/main/README.md#strict-coverage-controls).

Solwyn classifies the public pre-call capability graph of each wrapped provider client.
Tracked leaves are intercepted as usual, while known untracked leaves and newly observed
leaves follow `onUnmetered`: `"warn"` logs once and permits the call, `"raise"` refuses it
before provider I/O, and `"allow"` permits it without warning. In strict mode, use
`acknowledgeUntracked` only for narrow, deliberately reviewed exceptions; an acknowledgment
does not make a whole namespace safe.

Native OpenAI and Azure OpenAI `responses.create`, `responses.parse`, and `responses.stream` are
tracked. Other OpenAI-compatible clients retain their native Responses managers under the
unmetered posture because their wire behavior is not assumed to match OpenAI's native client.

The newly reviewed provider capabilities include these unmetered operations:

| Provider | Unmetered surfaces |
|----------|--------------------|
| OpenAI / Azure | Voice creation; beta Responses creation, compaction and retrieval; Agents hosted environments, file staging and session execution/event streams; Decisions, content-provenance checks, Live session creation/acceptance/forking, Realtime call creation and translation client secrets; raw response/request helpers (`responsePromise`, `parseResponseWithTimeout`). |
| Anthropic | `makeTracedRequest`, a raw request escape that bypasses metered `messages.create`. |
| Together | Jig rollback; cluster creation/resizing, remediation creation/approval, and shared-storage creation/resizing. |
| Google GenAI | Direct continuation helpers on `models` and `chats.modelsModule`; `voices.create`; `voices.getClient` and `credentials.getClient`; raw `getFetch` accessors and the voice and credential managers' underlying request/upload methods. |

These operations have no Solwyn budget check or settlement event. Use `onUnmetered: "raise"`
to refuse them, or explicitly review each exact acknowledgment token before permitting one.
Administrative, read-only and unevaluated accessor observations in the test baselines are
structural evidence; they do not grant metering or runtime safety to an otherwise unknown path.

Google GenAI `2.30.0` enables automatic continuation on the metered `models.generateContent`
and `models.generateContentStream` paths. Solwyn checks the logical call once and, on success,
settles the SDK's cumulative usage across all continuation hops. `failoverHopReadTimeout`
(600 seconds by default) bounds the whole continuation sequence. If a later buffered hop
fails, the provider SDK does not return earlier-hop usage for Solwyn to settle. Set
`config.automaticContinuation: false` when the application needs separate admission and
settlement for each hop; increase the timeout for long continuation sequences.

Untracked-surface advisories coalesce occurrences for fifteen minutes per key. Retries keep the
same report ID and occurrence snapshot; later observations wait for a separate report. Closing
flushes unsent occurrences within `reporterShutdownDeadline`, bypassing local retry backoff while
respecting `Retry-After`. Exhausted reports produce aggregated warnings at most once per minute.

`coverage(client)` computes a local structural report without calling a provider operation or
transmitting data. For CI, pin an independently reviewed literal. This exhaustive strict,
unacknowledged example is reviewed against `openai@7.36.0`:

```ts
import OpenAI from "openai";
import { coverage, type CoverageFingerprint, Solwyn } from "@solwyn/sdk";

const client = new Solwyn(new OpenAI(), {
  apiKey: process.env.SOLWYN_API_KEY!,
  acknowledgeUntracked: [],
  onUnmetered: "raise",
});

const OPENAI_STRICT_FINGERPRINT: CoverageFingerprint = {
  conditional: "sha256:077917c04e6b5e20fd8ccc6a0eb8a580e83fac87669294994d289b2093ea8f18",
  guarded_namespaces: "sha256:0a25b65f25c51a07bf9fd3f3e9f31fb5e8a6e886050d40d71ce8ae31cca49181",
  tracked: "sha256:901afc09bff7b5d104f6318dbcc2096b22384e3414eb9c60daa9191dc789121a",
  unknown: "sha256:56626248c38bbd2342250da2b39f80d231e7f301bdf66e9930afb11a1c4bfb49",
  blocked: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  unsupported: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  safe: "sha256:53e52065adeab1166f4c12caf309be213176cf990fd610f0cdaf16df55b12365",
  scoped_escapes: "sha256:92ff5b06664289a1c19d73d15b2891f831766e911517531fedd90751277496ce",
  untracked: "sha256:3041aadf9018ae24a3cb8770fac31292d7c42c5119df3a352d7cfe7f80195da4",
};

coverage(client).expect(OPENAI_STRICT_FINGERPRINT);
await client.close();
```

When upgrading Solwyn or a provider SDK, inspect `coverage(client).entries`, review every category
change, and then paste a new literal. Do not derive the expected fingerprint from the same
report used by the assertion; that would make the check tautological. Azure OpenAI has a
different graph and needs its own reviewed fingerprint.

Strict mode is a cooperative pre-call guard, not a sandbox. Retaining the raw provider client,
reaching private wrapper state, acknowledging a scoped raw escape, or invoking behavior on a
returned response, page, stream, job, or operation object can bypass this guard. Fixed
non-configurable descriptors retain their native values and accessors to preserve JavaScript
Proxy invariants, and can also expose raw capabilities; keep those
capabilities out of code that relies on strict enforcement or review their use explicitly.
