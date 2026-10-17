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

Unmetered provider capabilities include these operations:

| Provider | Unmetered surfaces |
|----------|--------------------|
| OpenAI / Azure | Voice creation; beta Responses creation, compaction and retrieval; Agents hosted environments, file staging and session execution/event streams; Decisions, content-provenance checks, Live session creation/acceptance/forking; Realtime call creation/acceptance, client secrets, translation client secrets, and beta session/transcription-session creation; shared raw-request/client escapes below and `responsePromise`, `parseResponseWithTimeout`, `fetchWithAuth`. |
| Anthropic | Shared raw-request/client escapes below and `makeTracedRequest`, bypassing metered `messages.create`. |
| Together | Shared raw-request/client escapes below; Jig rollback; cluster creation/resizing, remediation creation/approval, and shared-storage creation/resizing. |
| Google GenAI | Direct continuation helpers on `models` and `chats.modelsModule`; `voices.create`; `voices.getClient` and `credentials.getClient`; `live.connect` and `live.music.connect`; underlying ApiClient methods on all 16 parent paths, including `apiClient`, `models.apiClient`, `live.apiClient`, `credentials.parentClient` and `voices.parentClient`. |

Native OpenAI, Azure OpenAI, Anthropic and Together share `arbitrary_endpoint` escapes:
`get`, `post`, `put`, `patch`, `delete`, `request`, `getAPIList`, `requestAPIList`,
`methodRequest`, `makeRequest`, `retryRequest`, `fetchWithTimeout` and `fetch`.
`getRequestClient` and `withOptions` have `client` scope. Availability depends on the provider
SDK version. Google ApiClient's `apiCall`, `downloadFile`, `fetchUploadUrl`, `getFetch`,
`request`, `requestStream`, `streamApiCall`, `unaryApiCall`, `uploadFile` and
`uploadFileToFileSearchStore` have `arbitrary_endpoint` scope on every parent.

These operations have no Solwyn budget check or settlement event. Use `onUnmetered: "raise"`
to refuse them, or explicitly review each exact acknowledgment token before permitting one.
Administrative, read-only and unevaluated accessor observations in the test baselines are
structural evidence; they do not grant metering or runtime safety to an otherwise unknown path.

Bedrock coverage lists `InvokeModelWithBidirectionalStreamCommand` as `blocked`, matching the
existing `send()` refusal for raw inference commands.

Google GenAI `2.30.0` enables automatic continuation on the metered `models.generateContent`
and `models.generateContentStream` paths. Solwyn checks the logical call once and, on success,
settles the SDK's cumulative usage across all continuation hops. `failoverHopReadTimeout`
(600 seconds by default) bounds the whole continuation sequence. If a later streaming hop
fails, streams using per-call budget checks settle the provider-reported usage observed before
the error and report an error event carrying those tokens. Lease-funded streams, the default
for untagged run-scoped text calls, still report zero usage on mid-stream provider errors and
release the local claim. Buffered calls retain a limitation: if a later hop fails,
the provider SDK does not return earlier-hop usage for Solwyn to settle. Set
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
  guarded_namespaces: "sha256:7c0f4a10e05274cdbadc7af64cb049f5cb9db078c9e87856c2056495c981d1b5",
  tracked: "sha256:901afc09bff7b5d104f6318dbcc2096b22384e3414eb9c60daa9191dc789121a",
  unknown: "sha256:f1175be4fe75d2f9253fca3d90b7b9b8000c0f91c3954dc73af15a0704ab7737",
  blocked: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  unsupported: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  safe: "sha256:53e52065adeab1166f4c12caf309be213176cf990fd610f0cdaf16df55b12365",
  scoped_escapes: "sha256:98648bf0910e2378951bd2ded14e2af9c477064c8c286b493dc0eccd8a9a7a73",
  untracked: "sha256:28690fd3d6bdbdd815e15cdf17c3265e6111b2169efb69cd5b8d59cac3f8b927",
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
Standalone OpenAI Realtime WebSocket helpers such as `OpenAIRealtimeWS`, even when constructed
with a wrapped client, open sockets without passing through guarded paths, so Solwyn does not
meter them or issue unmetered-surface warnings for those connections.
