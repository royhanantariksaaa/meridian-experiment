import {
  loadPaperState,
  openPaperPosition,
  refreshPaperState,
  resetPaperState,
  scanPaperCandidates,
  selectPaperCandidate,
} from "../tools/paper-simulator.js";
import { formatDeterministicCandidateLine } from "../tools/deterministic-scoring.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSol(value) {
  const n = Number(value || 0);
  return `${n.toFixed(4)} SOL`;
}

function printStateCompact(state) {
  console.log(`Virtual balance: ${formatSol(state.balance_sol)} | open=${state.open_positions.length} | closed=${state.closed_positions.length}`);
  for (const position of state.open_positions) {
    console.log(`- ${position.id} | ${position.pool_name} | ${position.amount_sol} SOL | score=${position.entry_score} | ${position.entry_decision}`);
    if (position.last_check) {
      const check = position.last_check;
      console.log(`  held=${check.held_minutes}m | vol/activeTVL=${check.volume_active_tvl_ratio}x | fee/TVL=${check.fee_active_tvl_ratio}% | price_change=${check.price_change_from_entry_pct}%`);
      console.log(`  exit_signals=${check.exit_signals?.length ? check.exit_signals.join("; ") : "none"}`);
    }
  }
}

function selectNonDuplicateCandidate(observations, state, options) {
  const openPools = new Set(state.open_positions.map((position) => position.pool));
  const filtered = observations.filter((entry) => !openPools.has(entry.pool?.pool));
  return selectPaperCandidate(filtered, options);
}

async function paperCycle({
  balance,
  entry,
  limit,
  maxOpen,
  forceBest,
  reset,
  timeframe,
} = {}) {
  if (reset) {
    const state = resetPaperState(balance);
    console.log(`Reset virtual paper account to ${formatSol(state.balance_sol)}`);
  }

  let state = loadPaperState({ initialBalanceSol: balance });

  if (state.open_positions.length > 0) {
    console.log("Refreshing open paper positions...");
    state = await refreshPaperState({ timeframe });
  }

  console.log("Scanning candidates...");
  const { observations, summary } = await scanPaperCandidates({ limit });
  console.log(`Decision summary: ${JSON.stringify(summary)}`);

  const best = observations[0];
  if (best) console.log(`Best observed: ${formatDeterministicCandidateLine(best, 0)}`);

  state = loadPaperState({ initialBalanceSol: balance });
  if (state.open_positions.length >= maxOpen) {
    console.log(`Max paper positions reached (${state.open_positions.length}/${maxOpen}); no new entry.`);
    printStateCompact(state);
    return;
  }

  if (state.balance_sol < entry) {
    console.log(`Insufficient virtual SOL for new entry: ${formatSol(state.balance_sol)} < ${formatSol(entry)}.`);
    printStateCompact(state);
    return;
  }

  const selected = selectNonDuplicateCandidate(observations, state, { forceBest });
  if (!selected.entry) {
    console.log("No eligible candidate. Nothing opened. Add --force-best to intentionally paper-test the best rejected pool.");
    printStateCompact(state);
    return;
  }

  const { position, state: openedState } = openPaperPosition({
    pool: selected.entry.pool,
    deterministic: selected.entry.deterministic,
    amountSol: entry,
    initialBalanceSol: balance,
    forced: selected.forced,
    note: selected.forced ? "paper-agent force-best" : "paper-agent eligible entry",
  });

  console.log(`${selected.forced ? "FORCED PAPER ENTRY" : "PAPER ENTRY"}: ${position.pool_name} | ${formatSol(position.amount_sol)} | score=${position.entry_score} | decision=${position.entry_decision}`);
  console.log(`Position id: ${position.id}`);
  printStateCompact(openedState);
}

async function main() {
  const balance = Number(argValue("balance", "0.1"));
  const entry = Number(argValue("entry", "0.01"));
  const limit = Number(argValue("limit", "10"));
  const maxOpen = Number(argValue("max-open", "3"));
  const intervalSec = Number(argValue("interval", "300"));
  const timeframe = argValue("timeframe", "5m");
  const reset = hasFlag("reset");
  const loop = hasFlag("loop");
  const forceBest = hasFlag("force-best");

  console.log("=== Streamlined Paper Agent ===");
  console.log(`balance=${balance} SOL entry=${entry} SOL max_open=${maxOpen} limit=${limit} timeframe=${timeframe} force_best=${forceBest} loop=${loop}\n`);

  if (!loop) {
    await paperCycle({ balance, entry, limit, maxOpen, forceBest, reset, timeframe });
    return;
  }

  let first = true;
  while (true) {
    console.log(`\n--- Paper cycle ${new Date().toISOString()} ---`);
    await paperCycle({
      balance,
      entry,
      limit,
      maxOpen,
      forceBest,
      reset: first && reset,
      timeframe,
    });
    first = false;
    console.log(`Sleeping ${intervalSec}s. Press Ctrl+C to stop.`);
    await sleep(intervalSec * 1000);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
