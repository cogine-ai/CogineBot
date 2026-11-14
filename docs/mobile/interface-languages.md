# Mobile interface languages

Mobile and Web share the language list, native names, storage key and BCP-47
normalization in `@rakazo/core/ui-locale`. Electron hosts the Web UI.
The Account language action sheet offers en, de, ko, tr, hi, pt-BR, zh-CN, es, ru
and fr. iOS uses its native action sheet; Android uses the existing native alert
pagination so every option stays reachable within the three-button limit.

The nine non-English mobile catalogs cover every existing mobile translation ID.
English uses source messages. The six added catalogs were seeded from the current
Web translations and completed for mobile-only messages. They are maintained in
`apps/mobile/lib/locales`, alongside the existing German, Russian and Chinese
catalogs. No translator, model, service or network connection is required at runtime.
All catalogs are bundled statically: switching cannot fail because of a missing
network-loaded language bundle.

## Deliberately unchanged content

`apps/mobile/lib/locales/unchanged-messages.json` lists **every** catalog entry
whose value equals its English source, separately for each language. The catalog
test rejects additions or removals not reviewed in this list. It includes valid
same-spelling translations (for example French “Image”, Spanish “Color” and German
“Computer”), not just fallbacks. The technical entries retained verbatim are:

- `OpenAPI`, `OpenAPI JSON`: protocol and format names.
- `Webhook`: established technical term where the catalog retains it.
- `Bot`, `bot`, `CogineBot`: product terminology/brand where retained.
- `Tab`: the physical keyboard key.
- `@{name}`: mention syntax.
- `exact-model-id`: literal model identifier placeholder.
- `sk-…`: example credential prefix, not a real key.
- `http://127.0.0.1:8000/v1`: local protocol endpoint example.
- `http://localhost:53692/callback?code=…`: local authorization callback example.
- `https://example.com/graphql`: GraphQL endpoint example.
- `https://example.com/mcp`: MCP endpoint example.
- `https://example.com/openapi.json`: OpenAPI document example.
- `https://executor.example/mcp`: executor endpoint example.
- `OTA · {id}`, `OTA · {id} · {date}`: update identity formats.
- `{channel} · {id}`, `{channel} · {id} · {date}`: release identity formats.

Other intentional boundaries:

- Unknown translation IDs fall back to their English source, with interpolation.
  The coverage test requires known mobile literal IDs and shared disclosure/error
  messages to exist in all nine catalogs; fallback is not a substitute for them.
- User content, bot/model output, names, provider metadata and raw diagnostic details
  retain their original text. Known application error summaries are localized.
- OS-owned permission prompts, browser/authorization pages and remote computer
  contents follow their owning platform, service or document. The iOS one-shot
  date/time picker receives the active interface locale, including changes while
  open. The locked Expo UI Android picker has no locale override (its `locale`
  property is iOS-only); Android native calendar text still follows platform
  configuration. This limitation remains unproven/needs-owner, not a C3 exemption
  or a claim that Android native presentation follows the interface language.
- The application-owned recurring time menu formats its labels with the interface
  locale. Its original AM/PM selection keys and cron conversion remain unchanged;
  formatting does not convert the routine's time zone or execution instant.
- Release identity dates stay ISO `YYYY-MM-DD`, as diagnostic identifiers. Calendar
  dates in conversations, files, routine history, bot settings history and transfer
  expiry use the active interface locale. Clock/time-zone semantics are unchanged.

## Preference and fallback

Saved local choice wins over the configured default, then device language, then
English. A stored unsupported tag resolves to English rather than selecting a
second preference. Regional tags follow the existing Web rules, including `pt`
and `pt-PT` → `pt-BR`. `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant-*` use English;
they never silently select Simplified Chinese. An implicit display fallback is
not an explicit speech-language preference: original device speech tags remain
available. SecureStore writes retain the existing ordered, last-selection-wins
behavior and in-memory fallback if native storage is inaccessible. Preferences
remain local; no cross-device synchronization is promised.

## Verification boundary

Deterministic offline tests switch through all ten locales, assert main workflow
labels and error/confirmation messages, persist into a SecureStore substitute,
discard module state, and bootstrap again. They also verify native picker API
reachability, date formatting, regional/unknown tags, all catalog interpolations,
TypeScript AST source-ID coverage (single/double quotes and static templates),
artifact deletion confirmations and the explicit unchanged-entry list. Component
substitutes also check recurring time labels/unchanged cron keys and the iOS picker
locale prop without claiming to render native fonts or controls. These are **substitute
evidence**, not screenshots or a real native process restart.

Real iOS/Android App-entry screenshots, native storage across process termination,
layout/font quality (including Hindi), and authorized-instance cross-read evidence
remain **unproven / needs-owner**. Device access was disabled for this development
session. No platforms were installed, licenses accepted, paid upstreams contacted,
or acceptance sessions started. Independent acceptance and CI are managed outside
this development session. Local language preference itself has no backend row to
cross-read; any backend workflow verification requires an authorized synthetic-data
instance and its exact backend commit.
