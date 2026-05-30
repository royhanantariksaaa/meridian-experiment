import fs from "fs";
import path from "path";
import { discoverPools } from "../tools/screening.js";
import {
  formatDeterministicCandidateLine,
  rankDeterministicCandidates,
} from "../tools/deterministic-scoring.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveSnapshot(payload) {
  const dir = path.join(process.cwd(), "logs", "screening-snapshots");
  ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(payload) + "\n");
  return file;
}

async function main() {
  const pageSize = Number(argValue("page-size", 25));
  const limit = Number(argValue("limit", 10));
  const snapshot = hasFlag("snapshot");

  console.log("=== Deterministic DLMM Screening Experiment ===\n");
  console.log(`Fetching ${pageSize} screened pools using current config...`);

  const discovery = await discoverPools({ page_size: pageSize });
  const ranked = rankDeterministicCandidates(discovery.pools).slice(0, limit);

  console.log(`Total API pools: ${discovery.total ?? "?"}`);
  console.log(`Pools after existing hard filters: ${discovery.pools.length}`);
  console.log(`Showing top ${ranked.length}\n`);

  if (discovery.filtered_examples?.length) {
    console.log("Filtered examples from existing screener:");
    for (const entry of discovery.filtered_examples.slice(0, 5)) {
      console.log(`- ${entry.name}: ${entry.reason}`);
    }
    console.log("");
  }

  for (const [index, entry] of ranked.entries()) {
    console.log(formatDeterministicCandidateLine(entry, index));
    const d = entry.deterministic;
    const penaltyText = d.penalties.length
      ? d.penalties.map((p) => `${p.name}=-${p.value}`).join(", ")
      : "none";
    const hardFlagText = d.hard_flags.length ? d.hard_flags.join("; ") : "none";
    console.log(`    components=${JSON.stringify(d.components)}`);
    console.log(`    penalties=${penaltyText}`);
    console.log(`    hard_flags=${hardFlagText}`);
  }

  if (snapshot) {
    const payload = {
      ts: new Date().toISOString(),
      mode: "deterministic-screening-test",
      total_api_pools: discovery.total ?? null,
      hard_filtered_count: discovery.pools.length,
      filtered_examples: discovery.filtered_examples ?? [],
      ranked: ranked.map(({ pool, deterministic }) => ({
        pool: pool.pool,
        name: pool.name,
        base: pool.base,
        quote: pool.quote,
        deterministic,
      })),
    };
    const file = saveSnapshot(payload);
    console.log(`\nSnapshot saved: ${file}`);
  }

  console.log("\n=== Done ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
