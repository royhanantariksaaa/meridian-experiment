# Deterministic Screening Experiment

This fork includes a first-pass deterministic scoring layer for DLMM pool candidates.

It does **not** replace the live Meridian screening/deploy loop yet. It is intentionally conservative: use it to inspect, score, and snapshot candidates before wiring anything into live execution.

Current architecture:

```text
candidate source
→ local deterministic observer score
→ JSONL snapshots for later tuning
```

Supported candidate sources:

```text
upstream / normal = restored upstream getTopCandidates()
official          = broad official DLMM /pools fetch, then local filtering + shortlist enrichment
multiscan         = current discovery endpoint across multiple timeframes/categories
auto              = official first, then normal, then multiscan fallback
```

## Files Added

```text
docs/strategy.md
tools/deterministic-scoring.js
tools/screening-observer.js
tools/official-dlmm-source.js
scripts/observe-screening.js
scripts/debug-screening-funnel.js
test/test-deterministic-screening.js
```

## Run It

Preferred observer command using the new broad official source:

```bash
npm run screen:observe -- --source=official --limit=10
```

Compare sources:

```bash
npm run screen:observe -- --source=upstream --limit=10
npm run screen:observe -- --source=official --limit=10
npm run screen:observe -- --source=multiscan --limit=10
npm run screen:observe -- --source=auto --limit=10
```

Useful variants:

```bash
npm run screen:observe -- --source=official --limit=15 --json
npm run screen:observe -- --source=official --limit=15 --no-snapshot
```

The observer script will:

1. Fetch candidates from the selected source.
2. Apply the deterministic score engine to the candidates.
3. Print score breakdowns.
4. Assign one of three decisions:

```text
AUTO_SKIP
ASK_LLM
AUTO_DEPLOY_CANDIDATE
```

5. Save a JSONL snapshot by default.

Snapshots are written to:

```text
logs/screening-observer/YYYY-MM-DD.jsonl
```

The `logs/` directory is already ignored by `.gitignore`, so local snapshots will not be committed.

## Official Broad Source

The official source intentionally avoids relying on a narrow server-side filtered query. It broadly fetches DLMM pools from the official DLMM data API, normalizes them into the existing pool shape, applies our local thresholds, then enriches only a shortlist with pool-discovery detail data for fields that the official endpoint does not provide directly.

Current source flow:

```text
GET https://dlmm.datapi.meteora.ag/pools
→ normalize multi-window metrics into pool shape
→ local filters: mcap, holders, volume, TVL, bin step, fee/active-TVL, blacklist/dev blocklist
→ rank locally
→ enrich shortlist with pool-discovery detail for volatility/organic/price/action fields
→ final local filters: organic + volatility
```

Cache files are written under:

```text
logs/market-cache/
```

Run paper simulation using the broad source:

```bash
npm run paper:stack -- --source=official --limit=10 --reset
```

## Screening Funnel Debugger

Use this when the observer returns only a few pools and you want to know where the candidate universe collapsed.

```bash
node scripts/debug-screening-funnel.js --page-size=100
```

Useful variants:

```bash
node scripts/debug-screening-funnel.js --page-size=100 --category=top
node scripts/debug-screening-funnel.js --page-size=100 --category=new
node scripts/debug-screening-funnel.js --page-size=100 --timeframe=30m
node scripts/debug-screening-funnel.js --page-size=100 --timeframe=1h --category=top
node scripts/debug-screening-funnel.js --page-size=100 --json
```

The funnel debugger does **not** deploy. It fetches a raw DLMM sample from Meteora and reports how many pools are removed by each local stage:

```text
critical warnings / ownership
market cap
holders
volume
TVL
bin step
fee/active-TVL
volatility
organic score
launchpad / token age
blacklist / dev blocklist
occupied / cooldown
```

It also compares the local funnel against upstream `discoverPools()` and `getTopCandidates()` output, so you can tell whether the final candidate count is caused by broad API filters, local thresholds, occupied/cooldown rules, or later upstream enrichment.

## Legacy Direct Test

The older direct test still exists:

```bash
node test/test-deterministic-screening.js --snapshot
```

That test is useful for scoring `discoverPools()` output directly, but the preferred workflow is now `npm run screen:observe` because it layers on top of selectable candidate sources.

## Decision Bands

Default bands:

```text
score < 65 → AUTO_SKIP
score 65–84 → ASK_LLM
score >= 85 → AUTO_DEPLOY_CANDIDATE
hard danger flag → AUTO_SKIP
```

`AUTO_DEPLOY_CANDIDATE` does **not** mean live deployment is enabled. It only means the deterministic scorer thinks the candidate is strong enough that, later, it could be deployed without asking the LLM.

## Scoring Inputs

Positive components:

```text
fee_active_tvl_ratio
volume_active_tvl_ratio
unique_traders
swap_count
organic_score
holders
volatility fit
trend
smart-wallet signal
safety baseline
```

Penalties:

```text
PVP risk
wash trading
rugpull
bundle percentage
sniper percentage
suspicious percentage
bot holder percentage
top-10 holder concentration
near/above ATH
old pool
```

Hard flags:

```text
wash trading flagged
rugpull flagged with no smart-wallet override
unusable volatility
bot holders over configured max
token fees below configured minimum
blocked launchpad
```

Notes:

```text
top10 concentration = penalty, not hard skip
rugpull = default skip unless smart-wallet override exists
wash trading = hard skip
low token fees = hard skip
```

## Next Step

Use `npm run screen:observe -- --source=official` and paper-test `--source=official` first. After enough snapshots, compare:

```text
deterministic score
source type
future fee capture
future PnL
out-of-range behavior
rug/wash failures
```

Only after that should the official broad source be considered for the live `runScreeningCycle()` path.
