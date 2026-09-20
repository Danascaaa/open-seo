# BTPScale autonomous SEO control plane

This fork adds two hard boundaries around the upstream OpenSEO application.

```mermaid
flowchart LR
  C[SEO scheduler] -->|Bearer service token| M[OpenSEO /mcp]
  M --> A{project and tool allowlists}
  A -->|allowed| T[OpenSEO tool]
  T --> R[central budget reservation]
  R -->|reserved| P[DataForSEO or OpenRouter]
  P -->|known cost| S[settle actual cost]
  P -->|timeout or ambiguous failure| U[mark uncertain and keep reservation]
  R -->|denied or unavailable| F[fail closed before provider]
```

## Required deployment values

All values belong in the Cloudflare/Alchemy secret or variable store. Never
commit them.

- `SEO_LEDGER_BASE_URL`: the BTPScale control-plane origin.
- `SEO_LEDGER_TOKEN`: bearer credential accepted only by the internal SEO
  budget routes.
- `SEO_PAID_OPERATION_LIMITS_JSON`: reviewed maximum euro-cent cost keyed by
  the exact internal operation name. Missing operations are disabled before
  network dispatch. Keep it `{}` until the current vendor tariff and every
  request-size cap have been reviewed. For OpenRouter, the maximum must cover
  the configured model at 160k input and 16k output tokens.
- `OPENSEO_SERVICE_TOKEN`: bearer credential accepted only by `/mcp`.
- `OPENSEO_SERVICE_EMAIL`: audit identity for the automation user.
- `OPENSEO_SERVICE_PROJECT_IDS`: comma-separated OpenSEO project IDs.
- `OPENSEO_SERVICE_TOOLS`: comma-separated MCP tool names.
- `CF_ACCESS_SERVICE_TOKEN_ID`: ID of a pre-created Cloudflare Access Service
  Token. Alchemy attaches it to a separate application for the exact `/mcp`
  path. The scheduler sends its client ID/secret using
  `CF-Access-Client-Id`/`CF-Access-Client-Secret`, plus
  `OPENSEO_SERVICE_TOKEN` as the normal bearer credential.

For the first private initialization only,
`OPENSEO_BOOTSTRAP_DISABLED_PAID=1` permits deployment without a DataForSEO
credential. It requires `DATAFORSEO_API_KEY` to remain unset and
`SEO_PAID_OPERATION_LIMITS_JSON={}`. The UI, authentication, D1, KV, R2 and
project records remain available, while every metered DataForSEO/OpenRouter
path fails before provider dispatch. A placeholder key is rejected.

Set `CF_ACCESS_PROVISION_SERVICE_TOKEN=1` to let Alchemy create the initial
one-year Access service token and keep its client secret redacted in the
Cloudflare-backed Alchemy state store. The associated Access application uses
the narrow `/mcp*` path so it covers the MCP endpoint and protocol suffixes
without authorizing UI routes. Use `CF_ACCESS_SERVICE_TOKEN_ID` instead when a
token already exists; never configure both.

Cloudflare Workers.dev can evaluate the hostname-wide Access application before
its more specific path application. The same Service Auth policy is therefore
attached to both applications. This does not grant application access to UI
routes: OpenSEO consumes the service bearer only on `/mcp`, and normal UI
resolution still requires an Access identity carrying an allowed e-mail.

Interactive Cloudflare Access still admits only the configured
`ACCESS_ALLOWED_EMAILS`. The Access service policy matches `/mcp` only; the
OpenSEO bearer is then checked by the Worker before any MCP tool is exposed.
The service token does not become a browser session and does not authorize UI
or account routes.

Behind Cloudflare Access, clients send the OpenSEO application credential in
`X-OpenSEO-Service-Token`; Access may consume or replace `Authorization` while
validating its own `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.
Plain Bearer authentication remains a compatibility fallback outside Access.

On the Cloudflare path, OpenSEO verifies the signed Access JWT against the
service application's own `SERVICE_POLICY_AUD` and requires its service-token
`common_name` claim before applying the project/tool allowlists. It also
compares `X-OpenSEO-Service-Token` in constant time against the versioned
application secret. Both proofs are mandatory. Bearer fallback is accepted
only when `AUTH_MODE` is not `cloudflare_access`.

Cloudflare `secret_text` values are write-only, so Alchemy cannot reliably
diff a rotated value under the same binding name. Runtime reads the versioned
`OPENSEO_SERVICE_TOKEN_V3` and `SEO_LEDGER_TOKEN_V2` bindings first; older
names remain rollback fallbacks only.

## Budget behavior

Every DataForSEO call made through `createDataforseoClient` reserves from the
`research` category before network dispatch. SAM reserves from `writing`
before **each** OpenRouter model step and before each standalone compaction.
One `openrouter:sam-step` reservation covers one generation, never the whole
40-step turn. One `openrouter:sam-compaction` reservation covers exactly one
summary generation. Reservations use an idempotent operation ID. A timed-out
reservation POST is reconciled once by operation ID and is never replayed
blindly.

SAM bounds every step's serialized messages to 128,000 UTF-8 bytes in addition
to Think's 160,000-token context guard and 16,000-token output cap. The tariff
for `openrouter:sam-step` must cover the configured model at the full
160,000-input/16,000-output token limits, including the fixed system prompt and
skills. Compaction is independently bounded to 128,000 UTF-8 input bytes and
4,000 output tokens.

The reservation amount comes only from `SEO_PAID_OPERATION_LIMITS_JSON`; there
is no permissive default. Known provider cost settles the reservation and
releases the unused amount.
A timeout, connection loss, or ambiguous provider error marks it `uncertain`
and preserves the reservation. A provider response without valid usage-cost
metadata is also uncertain; it is never settled as a zero-cost call. If actual cost exceeds the reservation, the
central ledger records the debt and freezes the category. Concurrent calls may
each hold a reservation; the central ledger enforces their aggregate against
the category balance. No claim is made that only one operation can be in
flight or that a third-party vendor can never report a higher final cost.

DataForSEO automatic 5xx retries are disabled because a failed HTTP response
does not prove that a paid live request was not processed.

## Service authorization

`tools/list` exposes only `OPENSEO_SERVICE_TOOLS`. Every service `tools/call`
must also carry a `projectId` from `OPENSEO_SERVICE_PROJECT_IDS`; `whoami` is
the only projectless discovery call. Existing Cloudflare Access, OAuth and
personal API-key authentication paths are preserved. Paid calls from the UI,
MCP and cron still fail closed when their project or exact paid-operation cost
is not configured.

The deployed pilot allowlist contains exactly eight MCP tools:
`whoami`, `research_keywords`, `get_domain_overview`, `get_rank_tracker`,
`estimate_rank_tracker_cost`, `run_rank_tracker`, `get_ranked_keywords`, and
the read-only `get_search_console_performance`. Adding a tool requires a
reviewed redeploy; discovery never expands this list dynamically.

## Rollback

Before deployment, retain the previously deployed Worker version. Roll back
the Worker first if the new MCP or provider gate breaks normal traffic. The
central ledger reservations are independent records: do not delete or release
`uncertain` entries during rollback; reconcile them against provider usage.

Removing the six control-plane variables disables the service identity and
makes paid calls fail closed. It is a safe emergency stop, not a way to restore
ungated provider access.

## Current deployment gate

Deployment requires all of the following:

1. DataForSEO credentials in the platform vault.
2. Central ledger URL/token and allowlists for the three real OpenSEO project
   IDs.
3. Cloudflare R2 enabled. Alchemy OAuth `access:write` was verified on the
   BTPScale account on 2026-09-20; do not repeat the login during deployment.
4. A reviewed plan/diff, followed by the first deploy with Worker logs open.

No paid provider call is part of validation. Unit tests use mocked ledger and
provider responses.

## Observed self-host deployment — 2026-09-21

- Private URL: `https://open-seo-selfhost.daniel-344.workers.dev`
- App Worker: `open-seo-selfhost`; bundle hash
  `02538c18ea821088245094840de93d647156215f0b5bb2e15d5e1871e6e435ac`
- Audit Worker: `open-seo-selfhost-audit`; bundle hash
  `81df487b00142431c28d2049045c96b42149c6e767d04fa024c533073bf53306`
- Human Access: `daniel@btpscale.fr`, `selam@btpscale.fr`
- Machine headers stored outside Git: `CF_ACCESS_CLIENT_ID`,
  `CF_ACCESS_CLIENT_SECRET`, `OPENSEO_SERVICE_TOKEN`
- Paid registry: the exact nine per-call ceilings recorded in
  [`btpscale-seo-pilot-activation-preflight.md`](./btpscale-seo-pilot-activation-preflight.md).
  The central runtime remained stopped during the deployment smoke; no
  DataForSEO request was dispatched by that smoke.
- Health: authenticated `/api/health` returned `status: ok`,
  `cloudflare_access`, DataForSEO set, and database ok. Anonymous UI and health
  requests redirect to Access.
- MCP: machine-authenticated `tools/list` returned HTTP 200 and exactly the
  eight configured tools. An invalid application token returned HTTP 401 and
  a project outside the allowlist was refused.
- GSC service-account mapping is server-managed for BTPScale
  (`sc-domain:btpscale.fr`) and Luvabat (`sc-domain:luvabat.fr`) only. Real
  `get_search_console_performance` calls through MCP and the deployed Worker
  returned HTTP 200 with `ok: true` for both projects over `last_28_days`
  (`query`, `web`, `final`, `rowLimit: 10`): 4 rows for BTPScale and 10 rows for
  Luvabat, covering 2026-08-20 through 2026-09-17. Carnet Renovation returned
  `gsc_oauth_not_configured`; the human UI state was not observed.

Projects use France (`2250`) and French (`fr`):

| Project                   | ID                                     | Domain                 |
| ------------------------- | -------------------------------------- | ---------------------- |
| BTPScale                  | `29d32756-aacc-4659-9aa9-ace2098b6a3f` | `btpscale.fr`          |
| Luvabat                   | `850a3ac9-8a43-4e98-a706-05d5222e8469` | `luvabat.fr`           |
| Carnet Rénovation Essonne | `8a3efc32-f947-44c1-b5bd-93afbf122b0f` | `carnet-renovation.fr` |

Rollback preserves data: redeploy the previous Git commit with the same
`selfhost` stage. Alchemy updates the Worker versions in place and keeps the
D1, KV and R2 resources. Do not run `alchemy destroy`; that is the destructive
teardown path and deletes the deployment data.
