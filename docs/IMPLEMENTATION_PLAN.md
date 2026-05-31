# Meridian Experiment Implementation Plan

This document tracks what we discussed, what has already been implemented, what is currently being validated, and the next planned batches.

Status principle: keep everything in observe/paper mode until paper outcomes prove the logic is reliable. Do not wire new sources, WebSocket refresh, or paper realism assumptions into live deployment without a separate review.

---

## Current Direction

We are not trying to force live deployment yet.

The system repeatedly finds the same weak/gray candidates, especially `ballish-SOL`, usually around score `66–68`. Forced paper tests showed that high fee intensity alone can be misleading when volume/active-TVL is weak and price moves against us.

Current operating mode:

```text
observe + paper research only
```

Primary goals:

```text
1. Make candidate discovery broad and fast.
2. Make paper monitoring react quickly.
3. Make paper PnL less optimistic and more realistic.
4. Collect enough paper outcomes before tuning thresholds or considering live deployment.
```

---

## Safety Boundaries

The following must remain true until explicitly changed:

```text
- No live deployment changes from these experiments.
- No auto-deploy based on forced paper results.
- Raydium/Orca work is observe-only until normalized and paper-tested.
- WebSocket/gRPC is used as a paper monitoring trigger first, not execution logic.
- Paper PnL is still a proxy, not proof of true realized LP PnL.
```

Live deployment should only be revisited after:

```text
- Paper simulator realism is improved.
- Paper outcome analyzer exists.
- We have enough closed paper trades to evaluate thresholds.
- Candidate quality improves beyond recurring gray-zone pools.
```

---

## Completed Work

### 1. Official Meteora broad source

Problem:

```text
The upstream discovery path appeared too narrow and sometimes returned only a few pools.
```

Implemented:

```text
tools/official-dlmm-source.js
tools/official-dlmm-fast-source.js
```

Current default source behavior:

```text
source=official       -> fast official Meteora broad source
source=official-recon -> slower recon source with token info / narrative / smart-wallet checks
```

Result:

```text
- official-fast is faster than upstream
- official-fast usually converges on the same best candidates
- discovery is no longer the main bottleneck
```

Conclusion:

```text
Candidate quality, scoring, and paper realism matter more than adding more Meteora discovery variants.
```

---

### 2. Source-aware observer and paper candidate sources

Implemented:

```text
tools/paper-candidate-sources.js
scripts/observe-screening.js
```

Supported source options:

```text
upstream / normal
official / official-fast
official-recon
multiscan
auto
```

Typical commands:

```bash
npm run screen:observe -- --source=official --limit=10
npm run screen:observe -- --source=official-recon --limit=10
npm run paper:stack -- --source=official --limit=10 --reset
```

---

### 3. Official recon pass

Problem:

```text
The fast source was mostly numerical and did not include smart-wallet/token-risk/narrative context.
```

Implemented:

```text
source=official-recon
```

Adds:

```text
smart_wallets_present
smart_wallet_count
smart_money_buy
narrative_present
token_info
audit
top10_pct
bot_holders_pct
global_fees_sol
bundle/sniper/suspicious pct
risk fields
```

Result from testing:

```text
- narrative_hits were common
- smart_wallet_hits and smart_money_hits were usually 0
- recon was much slower
```

Conclusion:

```text
official-recon is useful occasionally for risk context, but official-fast should remain default.
```

---

### 4. Paper timeframe consistency

Problem:

```text
A paper entry could be scored on 1h metrics, then monitored using default 5m metrics.
This made volume/active-TVL look like it collapsed unfairly.
```

Implemented:

```text
Paper refresh now uses position.source_timeframe when available.
```

Expected `last_check` fields:

```json
{
  "timeframe": "1h",
  "configured_timeframe": "5m",
  "entry_timeframe": "1h"
}
```

Conclusion:

```text
Entry and monitoring windows should now be comparable for paper positions.
```

---

### 5. Force-best paper exit tightening

Problem:

```text
Forced weak candidates were being tested with exit rules intended for better candidates.
5% TP was too optimistic for forced/weak pools.
```

Implemented in paper agent:

```text
--force-best default paper exits:
  take-profit = 1.5%
  stop-loss   = -4%
  max-hold    = 15m
  weak-exit   = 5m
```

Manual overrides still work:

```bash
npm run paper:stack -- --source=official --limit=10 --reset --force-best --take-profit=2 --stop-loss=-5
```

Conclusion:

```text
Forced paper mode is for research, not deployment. Weak entries should be scalped or cut faster.
```

---

### 6. WebSocket Batch 1 — watched-pool event logger

Problem:

```text
30s paper updates felt too slow.
We wanted to know whether open pools emit useful on-chain activity events.
```

Implemented:

```text
scripts/watch-paper-pools.js
```

Purpose:

```text
- reads open paper positions
- subscribes to watched pool accounts through Solana WebSocket
- logs account changes and optional logs
- does not refresh state
- does not trade
```

Command:

```bash
node scripts/watch-paper-pools.js --no-logs
```

Result:

```text
ballish-SOL emitted frequent account_change events.
```

Conclusion:

```text
WebSocket can be used as a trigger source for watched/open pools.
```

---

### 7. WebSocket Batch 2 — event-triggered paper refresh

Implemented:

```text
scripts/watch-refresh-paper-pools.js
```

Purpose:

```text
account_change -> debounced refreshPaperState()
```

Command:

```bash
node scripts/watch-refresh-paper-pools.js --debounce-ms=3000 --weak-exit-min=5 --take-profit=1.5 --stop-loss=-4 --max-hold=15
```

Observed behavior:

```text
account_change -> refresh_start -> refresh_done
```

with refreshes happening roughly every 3 seconds instead of waiting for a 30s polling tick.

Conclusion:

```text
WebSocket-triggered refresh works and is useful for faster paper monitoring.
```

---

### 8. WebSocket stale-timer cleanup

Problem:

```text
After a paper position closed, a previously scheduled debounced refresh could still fire for the old pool.
```

Implemented:

```text
Clear pending debounce timers on unsubscribe / no-open-position.
```

Expected behavior:

```text
position closes
-> unsubscribe
-> pending_timers becomes 0
-> no stale refresh for old closed position
```

---

### 9. WebSocket Batch 3a — offline event analyzer

Implemented:

```text
scripts/analyze-ws-refresh-events.js
```

Purpose:

```text
- read logs/paper-sim/ws-refresh-events.jsonl
- count account_change / refresh_start / refresh_done / errors
- measure event intervals
- measure refresh latency
- summarize per pool
```

Commands:

```bash
node scripts/analyze-ws-refresh-events.js
node scripts/analyze-ws-refresh-events.js --window-min=10
node scripts/analyze-ws-refresh-events.js --json
```

What to inspect:

```text
account_changes_per_refresh_done
refresh_latency
refresh_errors
pending_timer_cleared
refresh_skipped
```

---

### 10. Paper realism R1 — fee delta model

Problem:

```text
Paper mode credited the full rolling pool fee/aTVL as if the position earned it instantly.
This caused immediate fake profit after re-entry into the same pool.
```

Implemented:

```text
paper fee proxy = max(0, current fee/aTVL - entry fee/aTVL)
```

Example:

```text
entry fee/aTVL   = 1.00%
current fee/aTVL = 1.05%
credited fee     = 0.05%
```

New fields:

```text
entry_fee_active_tvl_ratio
fee_active_tvl_ratio
fee_active_tvl_ratio_delta
fee_proxy_model
gross_fee_proxy_pct
fee_proxy_sol
```

Conclusion:

```text
Paper mode should no longer show instant 1%+ profit just because the pool already had rolling fees before entry.
```

---

### 11. Paper realism R2 — execution friction

Problem:

```text
Paper wins were still too optimistic because there was no entry/exit/slippage drag.
```

Implemented:

```text
paperEntryCostPct
paperExitCostPct
paperSlippagePct
```

Defaults:

```text
paper-entry-cost = 0.05%
paper-exit-cost  = 0.05%
paper-slippage   = 0.10%
total friction   = 0.20%
```

Harsher example:

```bash
npm run paper:stack -- --source=official --limit=10 --reset --force-best --paper-entry-cost=0.10 --paper-exit-cost=0.10 --paper-slippage=0.20
```

This sets total friction to `0.40%`.

Conclusion:

```text
Paper PnL now has to overcome execution friction before showing profit.
```

---

### 12. Raydium observe-only source

Implemented:

```text
tools/raydium-source.js
```

Purpose:

```text
- explore Raydium REST pool data
- normalize into candidate-like shape
- keep observe-only for now
```

Not yet wired into:

```text
screen:observe
paper-agent
live deploy
```

Conclusion:

```text
Raydium expansion is strategically useful, but protocol-specific LP math and source normalization must come before paper/live integration.
```

---

## Current Work / In Progress

### Paper realism R3 — range-aware inventory model

Problem:

```text
Current paper inventory loss is still too rough.
It uses a simplified inventory proxy instead of modeling downside coverage and range behavior.
```

Planned improvement:

```text
Replace fixed inventory proxy with a model based on:
- price_change_from_entry_pct
- bin_step
- bins_below
- downside_coverage_pct
- out-of-range proxy
```

Goal:

```text
If price moves within coverage:
  inventory drag increases gradually.

If price breaches downside coverage:
  inventory loss becomes much harsher, approximating out-of-range / weak-token exposure.
```

Status:

```text
Planned next patch. Not considered complete until committed and tested.
```

---

## Next Batches

### Batch R3 — range-aware inventory PnL

Add fields to `last_check`:

```text
inventory_model
downside_coverage_used_pct
out_of_range_proxy
estimated_inventory_pnl_pct
```

Expected effect:

```text
Paper losses become harsher when price approaches or breaches downside coverage.
```

---

### Batch R4 — explicit in-range / out-of-range paper status

Add a visible status for each paper position:

```text
IN_RANGE_PROXY
NEAR_EDGE_PROXY
OUT_OF_RANGE_PROXY
```

Use:

```text
price_change_from_entry_pct
bins_below
bin_step
downside_coverage_pct
```

Purpose:

```text
Make dashboard/paper exits easier to interpret.
```

---

### Batch R5 — paper outcome analyzer

Create a script that reads paper state/history and summarizes:

```text
total trades
wins/losses
average PnL
best/worst trade
exit reasons
forced vs non-forced outcome
entry score vs outcome
entry vol/aTVL vs outcome
entry fee/aTVL vs outcome
fee delta vs outcome
friction-adjusted PnL
range status at exit
```

Potential command:

```bash
node scripts/analyze-paper-outcomes.js
```

Purpose:

```text
Decide threshold changes with evidence instead of guessing.
```

---

### Batch WS-3b — live WebSocket refresh status

Write live WS status into:

```text
logs/paper-sim/runtime.json
```

Fields:

```text
ws_refresh_alive
last_ws_account_change_at
last_ws_refresh_at
last_ws_refresh_reason
ws_refresh_count
ws_account_change_count
ws_refresh_error_count
pending_timers
subscriptions
avg_refresh_latency_ms
```

Purpose:

```text
Make the dashboard/API show whether WebSocket refresh is alive without manually reading JSONL logs.
```

---

### Batch WS-3c — adaptive refresh debounce

Use measured event rates to adjust refresh behavior:

```text
low event rate  -> debounce 1–3s
high event rate -> debounce 5–10s
refresh errors  -> temporary backoff
```

Purpose:

```text
Avoid API spam while keeping fast exits.
```

---

### Batch Multi-Venue 1 — wire Raydium into observer only

Add source option:

```bash
npm run screen:observe -- --source=raydium --limit=10
```

Still not paper/live.

Purpose:

```text
Verify Raydium API shape and candidate normalization.
```

---

### Batch Multi-Venue 2 — Orca research source

Investigate Orca Whirlpool data access and build observe-only normalization.

Important caveat:

```text
Orca Whirlpools are tick/range based, not Meteora bin based.
Do not reuse Meteora bins_below logic directly.
```

---

### Batch Multi-Venue 3 — normalized VenueCandidate interface

Create a common shape:

```text
venue
pool_address
base_mint
quote_mint
fee_window
volume_window
tvl
active_tvl_or_liquidity
fee_tvl_ratio
volume_tvl_ratio
price_change
volatility_proxy
risk fields
venue_specific
```

Purpose:

```text
Compare Meteora/Raydium/Orca candidates without pretending they have identical LP mechanics.
```

---

## Commands We Commonly Use

### Observe official fast

```bash
npm run screen:observe -- --source=official --limit=10
```

### Observe official recon

```bash
npm run screen:observe -- --source=official-recon --limit=10
```

### Paper official, non-forced

```bash
npm run paper:stack -- --source=official --limit=10 --reset
```

### Paper official, forced research

```bash
npm run paper:stack -- --source=official --limit=10 --reset --force-best
```

### Paper forced with harsher friction

```bash
npm run paper:stack -- --source=official --limit=10 --reset --force-best --paper-entry-cost=0.10 --paper-exit-cost=0.10 --paper-slippage=0.20
```

### WebSocket event logger

```bash
node scripts/watch-paper-pools.js --no-logs
```

### WebSocket-triggered paper refresh

```bash
node scripts/watch-refresh-paper-pools.js --debounce-ms=3000 --weak-exit-min=5 --take-profit=1.5 --stop-loss=-4 --max-hold=15
```

### Analyze WebSocket refresh events

```bash
node scripts/analyze-ws-refresh-events.js
node scripts/analyze-ws-refresh-events.js --window-min=10
```

---

## Known Caveats

### Paper PnL is still approximate

Even with fee delta and friction, paper PnL is not true DLMM LP accounting.

Still missing:

```text
- exact active-bin liquidity share
- true fee growth inside our bins
- exact token composition changes
- true OOR state
- exact transaction costs and priority fees
- exact close/swap execution effects
```

### WebSocket is a trigger, not a metric source

WebSocket account changes tell us:

```text
something changed
```

They do not directly tell us:

```text
fee/aTVL
volume/aTVL
paper PnL
LP fee capture
```

So the current design remains:

```text
WebSocket account_change -> trigger REST refresh -> update paper state
```

### Multi-venue expansion is not plug-and-play

Meteora DLMM, Raydium CLMM/CPMM, and Orca Whirlpools use different mechanics.

Do not blindly reuse:

```text
bins_below
bin_step
downside coverage
paper PnL model
```

across venues without venue-specific math.

---

## Decision Policy For Now

```text
If best candidate is gray-zone / forced / AUTO_SKIP:
  paper only.

If official-recon shows no smart-wallet/smart-money support:
  do not upgrade confidence just because narrative exists.

If forced paper entries lose after realistic costs:
  keep rejection threshold.

If forced paper entries repeatedly win after realistic costs:
  investigate whether thresholds are too strict.

No live deployment until paper outcome data supports it.
```
