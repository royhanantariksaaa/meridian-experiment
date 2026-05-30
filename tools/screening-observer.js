import fs from "fs";
import path from "path";
import { formatDeterministicCandidateLine, scoreDeterministicCandidate } from "./deterministic-scoring.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function buildDeterministicObservations(candidates, options = {}) {
  return (candidates || []).map((pool, index) => ({
    index,
    pool,
    deterministic: scoreDeterministicCandidate(pool, options),
  }));
}

export function summarizeDeterministicDecisions(observations = []) {
  const summary = {
    total: observations.length,
    AUTO_SKIP: 0,
    ASK_LLM: 0,
    AUTO_DEPLOY_CANDIDATE: 0,
  };

  for (const entry of observations) {
    const decision = entry?.deterministic?.decision;
    if (decision && summary[decision] != null) summary[decision] += 1;
  }

  return summary;
}

export function formatDeterministicPromptBlock(pool, deterministic, index = 0) {
  if (!deterministic) return null;
  const penalties = deterministic.penalties?.length
    ? deterministic.penalties.map((p) => `${p.name}=-${p.value}`).join(", ")
    : "none";
  const hardFlags = deterministic.hard_flags?.length
    ? deterministic.hard_flags.join("; ")
    : "none";

  return [
    `  deterministic: ${formatDeterministicCandidateLine({ pool, deterministic }, index).trim()}`,
    `  deterministic_components: ${JSON.stringify(deterministic.components)}`,
    `  deterministic_penalties: ${penalties}`,
    `  deterministic_hard_flags: ${hardFlags}`,
  ].join("\n");
}

export function appendDeterministicScreeningSnapshot({
  source = "screening-cycle",
  observations = [],
  extra = {},
} = {}) {
  const dir = path.join(process.cwd(), "logs", "screening-observer");
  ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  const payload = {
    ts: new Date().toISOString(),
    source,
    summary: summarizeDeterministicDecisions(observations),
    observations: observations.map(({ pool, deterministic }) => ({
      pool: pool?.pool,
      name: pool?.name,
      base: pool?.base,
      quote: pool?.quote,
      source_timeframe: pool?.source_timeframe ?? null,
      source_category: pool?.source_category ?? null,
      deterministic,
    })),
    ...extra,
  };

  fs.appendFileSync(file, JSON.stringify(payload) + "\n");
  return file;
}
