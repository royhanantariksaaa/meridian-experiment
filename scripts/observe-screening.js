import "../envcrypt.js";
import { getTopCandidates } from "../tools/screening.js";
import { scanCandidatePools } from "../tools/paper-candidate-sources.js";
import {
  appendDeterministicScreeningSnapshot,
  buildDeterministicObservations,
  summarizeDeterministicDecisions,
} from "../tools/screening-observer.js";
import { formatDeterministicCandidateLine } from "../tools/deterministic-scoring.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function boolFlag(name, fallback = false) {
  if (hasFlag(name)) return true;
  if (hasFlag(`no-${name}`)) return false;
  return fallback;
}

function printUsage() {
  console.log(`Usage: npm run screen:observe -- [--source=normal|official|multiscan|auto] [--limit=10] [--snapshot] [--json]\n\nNo deploys are performed. This fetches candidates from the selected source, applies the deterministic observer score, and optionally writes logs/screening-observer/YYYY-MM-DD.jsonl.`);
}

async function loadCandidates({ source, limit }) {
  if (source === "upstream" || source === "normal") {
    const result = await getTopCandidates({ limit });
    return {
      source: "upstream-getTopCandidates",
      result,
      candidates: result?.candidates || result?.pools || [],
    };
  }

  const result = await scanCandidatePools({ source, limit });
  return {
    source: result?.source || source,
    result,
    candidates: result?.candidates || result?.pools || [],
  };
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    printUsage();
    return;
  }

  const limit = Number(argValue("limit", 10));
  const source = argValue("source", "upstream");
  const snapshot = boolFlag("snapshot", true);
  const json = hasFlag("json");

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }

  const loaded = await loadCandidates({ source, limit });
  const result = loaded.result;
  const candidates = loaded.candidates;
  const observations = buildDeterministicObservations(candidates);
  const ranked = [...observations].sort((a, b) => b.deterministic.score - a.deterministic.score);
  const summary = summarizeDeterministicDecisions(observations);

  let snapshotFile = null;
  if (snapshot) {
    snapshotFile = appendDeterministicScreeningSnapshot({
      source: loaded.source,
      observations,
      extra: {
        total_screened: result?.total_screened ?? result?.scan_summary?.[0]?.raw_count ?? null,
        filtered_examples: result?.filtered_examples ?? [],
        scan_summary: result?.scan_summary ?? [],
        scan_errors: result?.scan_errors ?? [],
      },
    });
  }

  if (json) {
    console.log(JSON.stringify({
      source: loaded.source,
      total_screened: result?.total_screened ?? result?.scan_summary?.[0]?.raw_count ?? null,
      candidate_count: candidates.length,
      summary,
      snapshot_file: snapshotFile,
      scan_summary: result?.scan_summary ?? [],
      scan_errors: result?.scan_errors ?? [],
      filtered_examples: result?.filtered_examples ?? [],
      ranked: ranked.map(({ pool, deterministic }) => ({
        pool: pool?.pool,
        name: pool?.name,
        base: pool?.base,
        quote: pool?.quote,
        deterministic,
      })),
    }, null, 2));
    return;
  }

  console.log("=== Meridian Deterministic Screening Observer ===\n");
  console.log(`Source: ${loaded.source}`);
  console.log(`Total screened/source raw: ${result?.total_screened ?? result?.scan_summary?.[0]?.raw_count ?? "?"}`);
  console.log(`Candidates returned: ${candidates.length}`);
  console.log(`Decision summary: ${JSON.stringify(summary)}`);
  if (snapshotFile) console.log(`Snapshot: ${snapshotFile}`);

  if (result?.scan_summary?.length) {
    console.log("\nScan summary:");
    for (const entry of result.scan_summary) {
      console.log(`- ${JSON.stringify(entry)}`);
    }
  }

  if (result?.scan_errors?.length) {
    console.log("\nScan errors:");
    for (const entry of result.scan_errors.slice(0, 5)) {
      console.log(`- ${entry.name || entry.pool || entry.source || "unknown"}: ${entry.error || entry.reason}`);
    }
  }

  console.log("\nRanked deterministic view:");

  if (ranked.length === 0) {
    console.log("No candidates returned by selected source.");
  } else {
    for (const [index, entry] of ranked.entries()) {
      console.log(formatDeterministicCandidateLine(entry, index));
      const d = entry.deterministic;
      const penalties = d.penalties?.length
        ? d.penalties.map((p) => `${p.name}=-${p.value}`).join(", ")
        : "none";
      const hardFlags = d.hard_flags?.length ? d.hard_flags.join("; ") : "none";
      console.log(`    components=${JSON.stringify(d.components)}`);
      console.log(`    penalties=${penalties}`);
      console.log(`    hard_flags=${hardFlags}`);
    }
  }

  if (result?.filtered_examples?.length) {
    console.log("\nFiltered examples:");
    for (const entry of result.filtered_examples) {
      console.log(`- ${entry.name}: ${entry.reason}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
