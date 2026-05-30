import fs from "fs";
import path from "path";

const DEFAULT_FILE = path.join(process.cwd(), "logs", "paper-sim", "ws-refresh-events.jsonl");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseTs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pct(n, d) {
  if (!d) return 0;
  return Number(((n / d) * 100).toFixed(2));
}

function summarizeIntervals(events, type, pool = null) {
  const xs = events
    .filter((event) => event.type === type && (!pool || event.pool === pool))
    .map((event) => parseTs(event.ts))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < xs.length; i += 1) intervals.push(xs[i] - xs[i - 1]);
  if (!intervals.length) return null;
  const min = Math.min(...intervals);
  const max = Math.max(...intervals);
  const avg = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  return {
    count: intervals.length,
    min_ms: Math.round(min),
    avg_ms: Math.round(avg),
    max_ms: Math.round(max),
  };
}

function summarizeRefreshLatency(events, pool = null) {
  const starts = [];
  const latencies = [];
  for (const event of events) {
    if (pool && event.pool !== pool) continue;
    if (event.type === "refresh_start") {
      starts.push(event);
      continue;
    }
    if (event.type === "refresh_done" || event.type === "refresh_error") {
      const start = starts.shift();
      if (!start) continue;
      const s = parseTs(start.ts);
      const e = parseTs(event.ts);
      if (s != null && e != null && e >= s) latencies.push(e - s);
    }
  }
  if (!latencies.length) return null;
  return {
    count: latencies.length,
    min_ms: Math.round(Math.min(...latencies)),
    avg_ms: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    max_ms: Math.round(Math.max(...latencies)),
  };
}

function countBy(events, keyFn) {
  const map = new Map();
  for (const event of events) {
    const key = keyFn(event);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function loadEvents(file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const events = [];
  const errors = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  }
  return { events, parse_errors: errors };
}

function filterWindow(events, minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return events;
  const cutoff = Date.now() - n * 60_000;
  return events.filter((event) => {
    const ts = parseTs(event.ts);
    return ts != null && ts >= cutoff;
  });
}

function buildSummary(events, parseErrors = []) {
  const sorted = [...events].sort((a, b) => (parseTs(a.ts) || 0) - (parseTs(b.ts) || 0));
  const firstTs = sorted[0]?.ts ?? null;
  const lastTs = sorted[sorted.length - 1]?.ts ?? null;
  const durationMs = firstTs && lastTs ? Math.max(0, parseTs(lastTs) - parseTs(firstTs)) : 0;
  const typeCounts = countBy(sorted, (event) => event.type || "unknown");
  const pools = [...new Set(sorted.map((event) => event.pool).filter(Boolean))];

  const globalAccountChanges = typeCounts.account_change || 0;
  const globalRefreshStarts = typeCounts.refresh_start || 0;
  const globalRefreshDone = typeCounts.refresh_done || 0;
  const globalRefreshErrors = typeCounts.refresh_error || 0;

  const perPool = pools.map((pool) => {
    const poolEvents = sorted.filter((event) => event.pool === pool);
    const poolTypeCounts = countBy(poolEvents, (event) => event.type || "unknown");
    const name = poolEvents.find((event) => event.pool_name)?.pool_name || pool.slice(0, 8);
    const accountChanges = poolTypeCounts.account_change || 0;
    const refreshDone = poolTypeCounts.refresh_done || 0;
    return {
      pool,
      pool_name: name,
      total_events: poolEvents.length,
      account_change: accountChanges,
      refresh_start: poolTypeCounts.refresh_start || 0,
      refresh_done: refreshDone,
      refresh_error: poolTypeCounts.refresh_error || 0,
      refresh_skipped: poolTypeCounts.refresh_skipped || 0,
      pending_timer_cleared: poolTypeCounts.pending_timer_cleared || 0,
      debounce_ratio_account_changes_per_refresh: refreshDone ? Number((accountChanges / refreshDone).toFixed(2)) : null,
      account_change_interval: summarizeIntervals(sorted, "account_change", pool),
      refresh_done_interval: summarizeIntervals(sorted, "refresh_done", pool),
      refresh_latency: summarizeRefreshLatency(sorted, pool),
    };
  }).sort((a, b) => b.total_events - a.total_events);

  return {
    total_events: sorted.length,
    parse_errors: parseErrors.length,
    first_ts: firstTs,
    last_ts: lastTs,
    duration_sec: Number((durationMs / 1000).toFixed(2)),
    type_counts: typeCounts,
    global: {
      account_changes: globalAccountChanges,
      refresh_starts: globalRefreshStarts,
      refresh_done: globalRefreshDone,
      refresh_errors: globalRefreshErrors,
      refresh_success_rate_pct: pct(globalRefreshDone, globalRefreshDone + globalRefreshErrors),
      account_changes_per_refresh_done: globalRefreshDone ? Number((globalAccountChanges / globalRefreshDone).toFixed(2)) : null,
      account_change_interval: summarizeIntervals(sorted, "account_change"),
      refresh_done_interval: summarizeIntervals(sorted, "refresh_done"),
      refresh_latency: summarizeRefreshLatency(sorted),
    },
    per_pool: perPool,
  };
}

function printSummary(summary) {
  console.log("=== WebSocket Refresh Event Analyzer ===\n");
  console.log(`Events: ${summary.total_events} | parse_errors=${summary.parse_errors}`);
  console.log(`Window: ${summary.first_ts || "n/a"} → ${summary.last_ts || "n/a"} (${summary.duration_sec}s)`);
  console.log(`Types: ${JSON.stringify(summary.type_counts)}`);
  console.log("\nGlobal:");
  console.log(`- account changes: ${summary.global.account_changes}`);
  console.log(`- refresh done: ${summary.global.refresh_done}`);
  console.log(`- refresh errors: ${summary.global.refresh_errors}`);
  console.log(`- account changes / refresh: ${summary.global.account_changes_per_refresh_done ?? "n/a"}`);
  console.log(`- refresh success: ${summary.global.refresh_success_rate_pct}%`);
  if (summary.global.account_change_interval) console.log(`- account-change interval ms: ${JSON.stringify(summary.global.account_change_interval)}`);
  if (summary.global.refresh_done_interval) console.log(`- refresh interval ms: ${JSON.stringify(summary.global.refresh_done_interval)}`);
  if (summary.global.refresh_latency) console.log(`- refresh latency ms: ${JSON.stringify(summary.global.refresh_latency)}`);

  console.log("\nPer pool:");
  if (!summary.per_pool.length) {
    console.log("- no pool events found");
    return;
  }
  for (const pool of summary.per_pool.slice(0, 10)) {
    console.log(`- ${pool.pool_name} ${pool.pool.slice(0, 8)} events=${pool.total_events} account=${pool.account_change} refresh=${pool.refresh_done} skipped=${pool.refresh_skipped} cleared=${pool.pending_timer_cleared} account/refresh=${pool.debounce_ratio_account_changes_per_refresh ?? "n/a"}`);
    if (pool.account_change_interval) console.log(`  account interval: ${JSON.stringify(pool.account_change_interval)}`);
    if (pool.refresh_done_interval) console.log(`  refresh interval: ${JSON.stringify(pool.refresh_done_interval)}`);
    if (pool.refresh_latency) console.log(`  refresh latency: ${JSON.stringify(pool.refresh_latency)}`);
  }
}

function main() {
  const file = argValue("file", DEFAULT_FILE);
  const windowMin = argValue("window-min", null);
  const json = hasFlag("json");
  const { events, parse_errors } = loadEvents(file);
  const filtered = filterWindow(events, windowMin);
  const summary = buildSummary(filtered, parse_errors);
  if (json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
