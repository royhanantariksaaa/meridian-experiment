# Deterministic Screening Experiment

This fork includes a first-pass deterministic scoring layer for DLMM pool candidates.

It does **not** replace the live Meridian screening/deploy loop yet. It is intentionally conservative: use it to inspect, score, and snapshot candidates before wiring anything into live execution.

## Files Added

```text
docs/strategy.md
tools/deterministic-scoring.js
test/test-deterministic-screening.js
```

## Run It

Because `package.json` was not modified, run the test directly:

```bash
node test/test-deterministic-screening.js --snapshot
```

Optional parameters:

```bash
node test/test-deterministic-screening.js --page-size=50 --limit=15 --snapshot
```

The script will:

1. Call the existing `discoverPools()` screener.
2. Apply the deterministic score engine.
3. Print score breakdowns.
4. Assign one of three decisions:

```text
AUTO_SKIP
ASK_LLM
AUTO_DEPLOY_CANDIDATE
```

5. Save a JSONL snapshot if `--snapshot` is provided.

Snapshots are written to:

```text
logs/screening-snapshots/YYYY-MM-DD.jsonl
```

The `logs/` directory is already ignored by `.gitignore`, so local snapshots will not be committed.

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
rugpull flagged
unusable volatility
bot holders over configured max
top-10 holders over configured max
token fees below configured minimum
blocked launchpad
```

## Next Step

Use this script for dry-run observation first. After enough snapshots, compare:

```text
deterministic score
LLM decision
future fee capture
future PnL
out-of-range behavior
rug/wash failures
```

Only after that should the deterministic decision bands be wired into `runScreeningCycle()` for LLM bypass or auto-deploy behavior.
