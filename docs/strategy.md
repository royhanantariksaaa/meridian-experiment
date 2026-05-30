# Meridian Experiment Strategy Notes

_Last updated: 2026-05-30_

This fork is for experimenting with a more deterministic DLMM screening layer before allowing any serious live-capital deployment.

## Main Thesis

The edge is not simply `high APR = good pool`.

A better DLMM pool selection model looks for:

```text
fresh volume
+ high volume / active TVL
+ high fee / active TVL
+ useful but not insane volatility
+ acceptable token safety
+ real narrative or smart-wallet support
+ low crowding / low copy-LP risk
+ deterministic exits
```

## What Meridian Already Does

The upstream repo already has a strong foundation:

1. Discovers Meteora DLMM pools.
2. Applies hard filters for token warnings, single ownership, market cap, holder count, volume, TVL, bin step, fee/active-TVL, organic score, and launchpad constraints.
3. Condenses candidate pool data.
4. Enriches candidates with Jupiter, OKX, smart-wallet, narrative, memory, and PVP-risk context.
5. Lets the LLM choose whether to deploy.
6. Uses deterministic management checks for stop-loss, take-profit, out-of-range, trailing take-profit, low yield, and fee claiming.

## What This Fork Should Improve

The screening side should become more deterministic and token-efficient.

Current style:

```text
code screens → LLM reviews → LLM calls deploy_position
```

Preferred experiment style:

```text
code screens → deterministic score + decision band → LLM only for gray-zone/narrative cases
```

Eventually, the ideal architecture is:

```text
deterministic screener
+ deterministic risk engine
+ optional LLM reviewer
+ deterministic range/bin selection
+ deterministic exit logic
+ full snapshot logging
+ replay/backtest tooling
```

## What Should Be Deterministic

These should not require an LLM:

```text
min/max TVL
min volume
min holders
min organic score
min/max market cap
bin step range
fee/active-TVL ratio
volume/active-TVL ratio
top-10 holder percentage
bundler percentage
bot holder percentage
rug/wash flags
existing position count
wallet balance
cooldown checks
score threshold
range size from volatility
take-profit / stop-loss / out-of-range rules
```

These are structured numerical or boolean checks. A normal script is faster, cheaper, easier to test, and less likely to hallucinate.

## What the LLM Should Still Do

The LLM is still useful for ambiguous context:

```text
Is the token narrative real or fake?
Is the volume organic or suspicious?
Does this look like a copycat/PVP token?
Is there a current X/Discord catalyst?
Does this match lessons from previous losing positions?
Should a gray-zone candidate be skipped despite passing filters?
```

A better use of the LLM is to produce structured judgment:

```text
narrative_score = 0–100
catalyst_score = 0–100
copycat_risk = true/false
reason = concise explanation
```

Then deterministic code can use those outputs.

## Deterministic Decision Bands

Initial proposed bands:

```text
hard danger flag → AUTO_SKIP
score < 65 → AUTO_SKIP
score 65–84 → ASK_LLM
score >= 85 and no danger flags → AUTO_DEPLOY_CANDIDATE
```

Important: `AUTO_DEPLOY_CANDIDATE` means the screener thinks it is strong enough to deploy without an LLM. It should still be tested in dry-run before being wired to live execution.

## Core Scoring Signals

Recommended scoring components:

```text
fee_active_tvl_ratio
volume_active_tvl_ratio
unique_traders
swap_count
organic_score
holder_count
volatility fit
volume_change_pct
fee_change_pct
smart-wallet bonus if available
```

Recommended penalties:

```text
wash trading flag
rugpull flag
PVP conflict
bundle percentage
sniper percentage
suspicious percentage
bot holder percentage
top-10 holder concentration
too close to ATH
blocked launchpad
bad pool memory
```

## Range / Bin Selection

Range should be deterministic. The prompt currently describes a volatility-based formula; this should be code-owned.

Suggested helper:

```js
function calculateBinsBelow(volatility, minBins, maxBins) {
  const v = Number(volatility);
  if (!Number.isFinite(v) || v <= 0) return null;

  const raw = minBins + (v / 5) * (maxBins - minBins);
  return Math.round(Math.max(minBins, Math.min(maxBins, raw)));
}
```

For single-sided SOL deploys:

```text
amount_y only
amount_x = 0
bins_above = 0
upper bin pinned to active bin
bins_below selected from volatility
```

## Required Before Serious Live Capital

Before using meaningful capital, this fork needs:

1. Screening snapshot logs.
2. Score breakdowns per candidate.
3. Dry-run cycles showing what would be selected.
4. Replay/backtest against future outcomes.
5. Risk-based position sizing.
6. Conservative burner-wallet live testing only after dry-run behavior is stable.

## Development Order

Recommended order:

```text
1. Add deterministic scoring module.
2. Add deterministic screening test/snapshot script.
3. Compare deterministic decisions against LLM choices.
4. Tune thresholds using logs.
5. Move more prompt-only rules into code.
6. Add replay/backtest mode.
7. Wire auto-deploy only after enough dry-run evidence.
```

## Caution

DLMM LPing can lose money from token dumps, rugs, impermanent loss, going out of range, bad range selection, crowding, bot bugs, RPC/API issues, private-key exposure, and agent mistakes.

Use dry-run first, then a burner wallet, then tiny capital only.
