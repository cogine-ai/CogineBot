# Optional ChatGPT plan model provider

Status: implemented; automated local validation passed; real-account acceptance remains pending.
Date: 2026-10-28.

## Outcome and decision

Add an optional `chatgpt-plan` model provider. An authenticated user connects a
ChatGPT account in model settings, grants plan usage, and selects one of that
registration's available models for bots and tasks. Existing product identity,
API-key providers, `openai-codex`, defaults and Pi agent/session behavior remain
compatible. Connecting this provider is never required to run the product.

Use Pi's MIT-licensed native OpenAI subscription implementation as the narrow
implementation reference. Keep both installed Pi packages at `0.87.1`; do not
introduce a second Pi agent loop or migrate session persistence. Do not copy or
depend on the noncommercial OpenAI DevKit code or assets.

## Evidence and readiness

The implementation base is the existing model credential/OAuth architecture.
The current ChatGPT connection uses `openai-codex` and device-code login. Model
credentials already have account isolation, encryption, request-scoped Pi
credential stores, refresh locks and scoped model preferences. Those mechanisms
are reused instead of introducing another secret store or product login.

Relevant owning files:

- `packages/adapters/src/pi-oauth.ts`: login lifecycle, serialization, refresh.
- `packages/adapters/src/pi-credentials.ts`: Pi credential-store adapter.
- `packages/adapters/src/pi-models.ts`: shared model catalog.
- `packages/adapters/src/pi-runtime.ts`: model registration and execution.
- `apps/api/src/router.ts`: authenticated model operations and persistence.
- `apps/desktop/src/browser-auth.ts`: native browser/loopback transport.
- `apps/web/src/lib/use-model-oauth-signin.ts`: connection lifecycle.
- `packages/contracts/src/domain.ts` and `rpc.ts`: shared contracts.

De-duplication: a successful repository issue search on 2026-10-28 for ChatGPT,
SIWC and dynamic_agent_client returned no matches. Local source inspection found
the legacy Codex connection and no direct-plan implementation. This document is
a local implementation spec; it does not create or publish an issue.

Pi reference:

- [Native provider, v1.3.0](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/providers/openai.ts).
- [OAuth implementation](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/auth/oauth/openai-chatgpt.ts).
- [Subscription request tests](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/test/openai-responses-chatgpt-sign-in.test.ts).

The native Pi implementation is a useful foundation, not a complete product
account manager. This integration adds verified identity, returning-client
authorization, account-specific model discovery, retained registrations and
remote session revocation. Pi 1.x removed session APIs used here, so upgrading
the entire runtime is explicitly outside this change.

## Scope and surfaces

In scope:

- Local desktop and local web authorization with the system browser, PKCE and a
  real IPv4 loopback listener started before authorization opens.
- Persistent opaque host ID scoped to this runtime's data directory.
- Multiple separately saved registrations; one active ChatGPT connection per
  product user, matching existing provider selection semantics. Switching is
  explicit; there is no account rotation or quota pooling.
- Encrypted issued-client/verified-identity records and renewable credentials.
- Account-specific model discovery, authenticated runtime registration and
  function-tool execution through the public Responses API.
- Deterministic offline tests for protocol, storage, transport and integration.

Outside scope:

- Product sign-up/login, importing Codex/Pi credentials, partner credentials,
  paid/managed hosting enablement, VM credential export/import, mobile-native
  first-time authorization, quota pooling, unrelated provider changes, native
  Responses computer-use tools, voice, image generation and hosted connectors.

Desktop can capture the callback on the user's machine even when its local
backend is in Docker. Local web without a desktop bridge uses a backend-owned
loopback listener and therefore requires browser and listener to share the host
network. A container-only listener is not advertised as a working web flow.
Remote web deployments and mobile reject new authorization with a concise,
actionable reason. They may use a previously authorized provider where that
deployment is eligible and its credentials are available.

## Contracts

### Provider and catalog

Internal ID: `chatgpt-plan`. Display name: `ChatGPT`. Action:
`Continue with ChatGPT`. A disconnected catalog placeholder exposes the connect
action but is never an executable model. API keys cannot connect this provider.

After authorization, GET `https://api.openai.com/v1/models` with the selected
registration's bearer token. Parse the `models` array, keep only
`visibility: "list"`, preserve server order, display `display_name` and execute
with `slug`. Bound response size, model count and field lengths. Unknown model
capabilities use conservative defaults, not capabilities inferred from a name.
No static API-key/Codex catalog substitutes for failed or empty discovery.
Switching registrations invalidates the old catalog. Execution refuses a model
outside the active connection's discovered catalog.

Preserve the current connection ID/revision binding contract for space defaults,
bots, routines, backups and helper models. A static catalog match or saved default
is never evidence that a ChatGPT registration can execute another model.
Switching to another saved registration must not carry over the previous
account's selected model ID. If saved registrations cannot be loaded, disable
ChatGPT authorization and show the scoped error while retaining other providers.

### Authorization lifecycle

1. Choose a saved registration or explicitly add another. Reuse the stable
   `urn:uuid:...` host ID across restarts, accounts and logout.
2. Generate fresh state, nonce and S256 PKCE verifier/challenge. Bind them to the
   authenticated product user, space, registration and exact callback URI.
3. Listen on `http://127.0.0.1:<port>/auth/callback` before opening the browser.
   Desktop starts with port 1455 and reports a conflict; backend local-web
   listeners may allocate an available port. Never substitute `localhost`.
4. Authorize at `https://auth.openai.com/api/accounts/authorize`. New accounts
   use `dynamic_agent_client`, `agent_name_hint=CogineBot` and host ID. Returning
   registrations use their issued client ID and omit agent_name_hint. Retained
   ID-token/login hints belong only to the selected verified registration.
5. Request `openid profile email offline_access resource.invoke
   chatgpt.tokens.use.direct` and resource `https://api.openai.com/v1`.
6. Reject duplicate/ambiguous callback fields, wrong state/path/host, expired or
   replayed attempts and callbacks containing access/refresh tokens. Handle a
   state-validated OAuth error without exchanging a code.
7. New registration requires an issued client ID. Retain it durably before code
   exchange, so invalid_grant can restart using that issued ID. A returning
   callback may omit client_id but must not change it.
8. Exchange the code with that client ID, the same resource and exact redirect
   URI. Never exchange with dynamic_agent_client or a client secret.
9. Validate ID-token signature using published JWKS; validate issuer, audience,
   expiration, nonce and nonempty sub. For returning verified registrations,
   the identity must match before replacing active credentials. Check granted
   scopes independently before enabling plan inference.
10. Discover models and persist the complete connection atomically. A failed or
    cancelled replacement never overwrites the active connection. An empty or
    unavailable catalog cannot create an executable default.

Use HTTPS-only pinned OpenAI origins, reject HTTP redirects for secret-bearing
requests, bound response bodies/deadlines and sanitize errors. Never log token
responses, retained ID-token hints or authorization URLs containing hints.

### Transport contract

`models.beginOAuth` accepts optional `callbackTransport` (`desktop` or
`loopback`), `registrationId` and `newRegistration`. The auth-url result reports
the chosen transport. Existing providers retain their existing behavior.

Desktop advertises support for full callback capture. Its callback transports
the bounded safe callback URL, including issued client_id or OAuth error, to
the backend through the existing submit-code operation. PKCE, validation and
token exchange stay in the trusted backend. For backend-owned loopback, the UI
polls completion instead of asking for a pasted code. Cancellation/timeout closes
the listener, invalidates the attempt and prevents a later callback from saving.

`models.chatgptProfiles` returns only each registration's opaque `id`, display
`label` and status (`registered`, `connected`, `signed-out`, or `incomplete`).
Model settings lets the user select a saved registration or choose `Add account`.
An older desktop without full-callback support asks the user to update before
starting registration; it does not silently attempt a container-local callback.

### Credentials and registrations

Use the existing SecretStore and user-scoped Secret records, with record-bound
encryption. A separate encrypted registration record survives disconnect; no
database schema migration is required. A registration ID is opaque and checked
against the authenticated user before use. Separate registrations remain
separate even when their email/sub display values match.

Registration data: version, issued client ID, optional verified issuer/subject
and local display label. ID tokens stay in the active encrypted credential;
optional authorization hints are omitted because this product's authorization
URL crosses the RPC/renderer boundary. Pending issued
IDs are distinguishable from verified registrations. Active model credentials
contain access/refresh/ID tokens, expiry, granted scopes, host ID, registration
reference, verified identity and account-specific model descriptors. Token
material never appears in profile/catalog/credential RPC responses, browser
storage or telemetry. Retained ID tokens join the redaction set.

Refresh uses the saved issued client ID and resource, omits scope, respects
earliest_refresh_at, and replaces access/expiry/scopes/rotating refresh token
together. The existing process lock is paired with a PostgreSQL transaction
advisory lock for this provider only. Initial resolution, mid-run Pi refresh,
catalog refresh and disconnect reload the current encrypted record under the
same shared lock. No lock is held during inference or catalog HTTP discovery.
Publication of a discovered catalog rechecks the current connection, so an old
account's delayed response cannot replace a newly selected account's models.

Once rotation starts, cancellation waits for the bounded refresh and publication
before stopping inference. If a successor response has arrived but identity
verification is unavailable, commit an encrypted pending-rotation checkpoint
before reporting failure. Pending credentials cannot power inference. A retry
verifies the retained response without a second token exchange, preserves its
original expiration and only then promotes it. Pending-token fields join the
redaction set; error messages/properties never expose the checkpoint. Ordinary
transaction failures roll back. A stale failed refresh cannot delete newer
credentials.

Disconnect first cancels pending authorization, then attempts refresh-token
revocation using the validated discovery endpoint. Stop using and clear local
tokens even when remote revocation cannot be confirmed, and report that outcome
to the user. Keep the issued client/verified identity and host ID for later
authorization, but clear retained login hints. Do not delete another provider's
credentials or another user's registrations.

Before revocation, validate the selected connection revision and existing
references. ChatGPT binding writes hold a shared row lock; disconnect holds an
exclusive row lock through reference validation and removal. Re-read the exact
credential ID, secret pointer and revision after acquiring the refresh lock; a
reconnected successor or a newly appeared first connection causes a conflict,
not revocation/deletion under a stale snapshot.

All documented terminal refresh errors survive safe error formatting and only
retire credentials with terminal OAuth rejection statuses. Transient errors and
quoted/lookalike markers do not retire a session. Pending-rotation recognition
follows bounded, cycle-safe error causes because Pi wraps provider errors.

## Pi runtime integration

Register a custom provider with the existing Pi 0.87.1 APIs. Reuse the installed
OpenAI Responses serializer/parser and adapt its outgoing payload at the final
network boundary, after caller hooks. The provider pins requests to the public
OpenAI API and sends the selected fresh OAuth token as Bearer.

Enforce the preview request contract:

- `store:false`, `stream:true`, full-history array input; no HTTP
  previous_response_id or server conversation state.
- Convert system instructions to supported developer/instructions form.
- Omit unsupported sampling, output-limit, metadata, cache-retention and other
  preview-incompatible fields.
- Group function/custom tools into a namespace; preserve tool identity and
  results through the existing Pi parser/agent loop. Fail unsupported tools
  explicitly. Host-side shell/MCP execution continues through function calls.
- Treat only response.completed as success. A failed/incomplete event, malformed
  event or EOF/abort without completion is a failure even after text arrived.
  Surface usage-limit errors with a link to ChatGPT usage settings; never
  silently spend an API key or switch accounts.

If discovery fails, keep unrelated providers and a non-executable ChatGPT
connection placeholder available. Never advertise a stale account catalog as a
successful response. Distinct saved registrations have stable display suffixes
even when their verified email addresses match.

Settings and recognized usage failures expose `Manage usage` linking to the
fixed `https://chatgpt.com/settings/usage` address. Never render a recovery URL
supplied by a provider response. The disconnected placeholder shows a sign-in
action without claiming an available model count.

The provider must work for bots, scheduled tasks and delegated runs through the
same model resolution path. No product-specific orchestration enters the UI.

## Acceptance and validation

| Area | Required offline evidence |
| --- | --- |
| Registration | Exact initial/returning parameters; issued ID saved before exchange; missing/mismatched/duplicate ID rejected; expired code can restart |
| Identity | Valid generated-key JWT accepted; bad signature/issuer/aud/nonce/expiry/subject rejected; same-email registrations separate |
| Callback | Listener before browser; correct127 host/path/state; error and replay; cancellation and port conflict; fullclientID preserved |
| Storage | Encrypted records, restart/reauthorization, ownership isolation, failed replacement preserves active connection, disconnect retains registration |
| Refresh | SavedclientID/resource, rotation, earliest refresh, concurrent request serialization, transient failure preserves credential, terminal failure fencing |
| Catalog | Account bearer and correctendpoint, visibility/order/slug, limits, malformed/empty catalogs, no stale cross-account/default fallback |
| Inference | Actual old-Pi serializer/parser with mock SSE; text and tool round trip; unsupported fields removed after hooks; failed/incomplete/EOF fail |
| Product | Optional provider appears, authorizedmodel selectable; activeBot uses correctcredential; otherproviders/productlogin unchanged |
| Surfaces | Desktopfullcallback +localwebpolling; mobile/remote newauthorization fails safely; connectedmodel use retained |

Run focused Vitest suites for new modules plus existing OAuth, credential,
catalog, runtime, router, desktop and web/mobile model-auth coverage. Run TypeScript
checks for affected packages/apps, repository formatting checks on changed files,
and the relevant web build. Do not run native desktop E2E locally because it
steals focus. Add browser coverage/screenshots where the existing harness permits.

Real-account acceptance is a separate, explicitly reported result: complete
authorization with an eligible account, refresh after restart, list available
models, complete text and function-tool inference, then revoke/disconnect. Offline
tests do not establish real account eligibility, quota behavior or native device
acceptance. No API key is required or provisioned for this OAuth-only provider.

## Risks, rollback and completion record

Official SIWC is a preview; request/model metadata may change. Pin references,
validate external data and fail closed rather than guessing capabilities. Local
loopback topology must not be presented as remote hosted support. Browser-owned
registration state and backend model credentials are separate security domains.

Rollback: remove the optional provider UI/runtime registration and new code.
Existing encrypted records remain inert; do not delete user data on rollback.
No Pi version or database migration needs reversing. Never replace an existing
provider's stored credential with this provider's tokens.

Implementation completion must record actual commands/results and remaining
acceptance gaps here or in a companion validation report. A written spec,
passing mocked requests, and live end-to-end success are distinct evidence.

The completed local validation and its limits are recorded in
[implementation and validation](chatgpt-plan-validation.md). The separate
[PostgreSQL report](chatgpt-plan-postgres-validation.md) records actual lock and
transaction tests against a disposable database.

## Official sources

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference).
- [Availability](https://developers.openai.com/siwc/quickstart).
