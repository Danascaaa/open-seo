# BTPScale SEO pilot activation preflight

**Status: prepared, not active.** This document records the reviewed pilot
limits and the remaining activation steps. It does not authorize setting
`SEO_PAID_OPERATION_LIMITS_JSON`, adding scheduled keywords, or starting a
provider call. The deployed registry must stay `{}` until the central ledger's
production allowlist contains the OpenSEO project IDs and the end-to-end
reservation path has been verified.

## Prepared paid-operation registry

The exact candidate value is:

```json
{
  "dataforseo:fetchRelatedKeywords": 15,
  "dataforseo:fetchKeywordSuggestions": 15,
  "dataforseo:fetchKeywordIdeas": 15,
  "dataforseo:fetchKeywordOverview": 20,
  "dataforseo:fetchDomainRankOverview": 2,
  "dataforseo:fetchRankedKeywords": 4,
  "dataforseo:fetchBacklinksSummary": 3,
  "dataforseo:postRankCheckTasks": 300,
  "dataforseo:fetchRankCheckSerp": 10
}
```

Values are integer euro cents reserved per provider call. The first seven
entries come from the account-specific review in
`company-os/reports/chantier/2026-09-20-seo-autonome/dataforseo-paid-operation-limits.proposed.json`.
The two SERP entries are added only after commit `27eed9c` corrected the rank
cost estimator and kept the request bounds at 100 queued tasks per POST, one
live task per call and a depth of 10 to 100 results.

| Operation                 | Request bound covered by the reservation                                  | Reserved |
| ------------------------- | ------------------------------------------------------------------------- | -------: |
| `fetchRelatedKeywords`    | at most 500 items, depth at most 3, clickstream multiplier included       |  15 cEUR |
| `fetchKeywordSuggestions` | at most 500 items, clickstream multiplier included                        |  15 cEUR |
| `fetchKeywordIdeas`       | at most 500 items, clickstream multiplier included                        |  15 cEUR |
| `fetchKeywordOverview`    | at most 700 keywords, clickstream multiplier included                     |  20 cEUR |
| `fetchDomainRankOverview` | one result item                                                           |   2 cEUR |
| `fetchRankedKeywords`     | at most 200 result items                                                  |   4 cEUR |
| `fetchBacklinksSummary`   | one request and at most one summary row                                   |   3 cEUR |
| `postRankCheckTasks`      | at most 100 tasks, 10 pages per task, search-operator multiplier included | 300 cEUR |
| `fetchRankCheckSerp`      | one live task, 10 pages, search-operator multiplier included              |  10 cEUR |

`task_get` is intentionally absent: DataForSEO does not charge that polling
endpoint, and registering it would reserve the same spend twice. Unknown paid
operation names remain disabled by the runtime's fail-closed registry.

The provisioning convention remains `1 USD = 1 EUR`, followed by rounding up
to the next euro cent. This is a conservative reservation rule, not an exchange
rate. The [ECB reference table](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html)
records `1 EUR = 1.1460 USD` on 18 September 2026, so one dollar was about
`0.8726 EUR` at that reference rate. The parity rule therefore held about a
14.6% cushion before actual funding and foreign-exchange fees. Recheck the
provider account's effective debit before activation; if fees consume that
cushion, increase the affected reservations before enabling them.

Activation requires all of the following:

1. The central ledger production registry contains the three approved OpenSEO
   project IDs and only the approved tools.
2. A preflight proves that a permitted operation reserves before dispatch,
   settles the real charge, and leaves an ambiguous timeout `uncertain`.
3. The deployed OpenSEO registry is changed from `{}` to the exact object above
   in the same reviewed release. No individual key is enabled ad hoc.
4. The first metered canary is separately approved and remains within the
   research category. This document performs no canary.

Rollback is to restore the deployed registry to `{}` and redeploy. This blocks
new provider dispatches before network access. Existing `uncertain`
reservations must remain reserved until reconciled; rollback must not release
them automatically.

## Weekly BTPScale rank tracker without a provider call

The only target project is BTPScale:

- project ID: `29d32756-aacc-4659-9aa9-ace2098b6a3f`
- domain: `btpscale.fr`
- market: France (`locationCode: 2250`, `languageCode: "fr"`)

Do not create scheduled trackers for the other two pilot projects. The safe
configuration sequence uses the MCP tools but stops before adding keywords:

1. Call `get_rank_tracker` with the BTPScale project ID. It is read-only and
   prevents creating a duplicate.
2. If none exists, call `create_rank_tracker` with the following arguments:

   ```json
   {
     "projectId": "29d32756-aacc-4659-9aa9-ace2098b6a3f",
     "domain": "btpscale.fr",
     "locationCode": 2250,
     "languageCode": "fr",
     "devices": "mobile",
     "serpDepth": 100,
     "scheduleInterval": "weekly"
   }
   ```

   This inserts an empty tracker. It adds no keyword, starts no check and makes
   no DataForSEO request. If it becomes due while empty, the five-minute cron
   records `no_keywords`, advances the schedule and still makes no provider
   request.

3. Copy the returned tracker UUID. In **Cloudflare Dashboard > Storage &
   Databases > D1 > `open-seo-db-selfhost` > Console**, anchor the next run to
   the next Monday at 10:00 in Paris. For the current preflight date, the next
   occurrence is 28 September 2026 at 08:00 UTC:

   ```sql
   UPDATE rank_tracking_configs
   SET next_check_at = '2026-09-28T08:00:00.000Z'
   WHERE id = '<tracker UUID returned by create_rank_tracker>'
     AND project_id = '29d32756-aacc-4659-9aa9-ace2098b6a3f'
     AND domain = 'btpscale.fr'
     AND schedule_interval = 'weekly'
     AND is_active = 1;
   ```

   Run this only while the tracker has zero keywords. Then call
   `get_rank_tracker` with the project and tracker IDs and verify exactly that
   one BTPScale row is weekly with the expected `nextCheckAt`. Neither action
   calls DataForSEO. If 28 September is no longer in the future, calculate the
   next Monday 10:00 in `Europe/Paris` and store its UTC instant instead.

4. Stop there while the paid registry is inactive. Do not call
   `add_rank_tracking_keywords` or `run_rank_tracker`.

After the ledger and registry are active, call `estimate_rank_tracker_cost`
with the intended `additionalKeywordCount`. It is read-only and free. Only
after the recurring estimate and live-fallback caveat are accepted may
`add_rank_tracking_keywords` receive the returned per-check estimate as
`maxEstimatedScheduledCheckCredits`. Adding keywords makes the later cron run
billable even though the add operation itself does not call the provider.

### Scheduling limitation

OpenSEO does not currently model a schedule timezone or a local wall-clock
hour. Creating or editing a weekly schedule chooses a random hour between
04:00 and 09:59 UTC, and subsequent checks advance from the stored UTC anchor
by exactly seven days. The D1 anchor above keeps Monday stable and the cron
runs on the first five-minute tick at or after it, but it does not preserve
10:00 Paris across daylight-saving changes. For example, `08:00Z` is 10:00 in
Paris before the October 2026 change and 09:00 afterwards.

An exact year-round “Monday 10:00 Europe/Paris” schedule therefore remains
unsupported. It needs a timezone-aware scheduling field and computation, or a
reviewed operational adjustment of `next_check_at` before each clock change.
Do not report the D1 anchor as native timezone support.

## Google Search Console integration gap

The existing control-plane service account and OpenSEO's UI use different
authentication models:

| Existing control-plane access                                  | OpenSEO self-hosted UI                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Server-to-server service account, already used outside OpenSEO | Interactive Google OAuth web client                                                     |
| Reads the properties granted directly to that service account  | Requires a human Google grant and refresh token                                         |
| No OpenSEO account or project mapping exists                   | Stores the encrypted OAuth grant in OpenSEO's database and maps a property to a project |

OpenSEO currently accepts only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a
minimum 32-character `BETTER_AUTH_SECRET` for this flow. Its redirect URI must
be the deployed origin followed by `/api/gsc/oauth/callback`. No current UI,
MCP tool or runtime binding accepts a Google service-account credential, so
the existing control-plane credential cannot be connected to OpenSEO without a
new implementation. No credential was read while preparing this preflight.

For the pilot, leave GSC disconnected in OpenSEO and keep the control plane as
the source of GSC baselines. A future activation can either provision a
dedicated Google OAuth web client and connect an authorized human account in
the UI, or add and review explicit service-account support in OpenSEO. GSC API
reads are not DataForSEO operations and do not belong in the paid-operation
registry.

## Evidence and non-actions

- Pricing source reviewed: the account-specific BTPScale report plus the ECB
  reference rate above.
- Code paths reviewed: Labs fetcher guards, rank estimator, MCP rank tools,
  scheduled-rank cron and self-hosted Google OAuth configuration.
- Commit containing the provider-size guards and corrected SERP page cost:
  `27eed9c`.
- No paid operation, tracker mutation, D1 statement, environment change or
  deployment was executed while preparing this document.
