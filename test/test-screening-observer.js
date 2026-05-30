import { config, computeDeployAmount } from "../config.js";
import { getTopCandidates } from "../tools/screening.js";
import { getWalletBalances } from "../tools/wallet.js";
import { getMyPositions } from "../tools/dlmm.js";
import { checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenNarrative } from "../tools/token.js";
import { recallForPool } from "../pool-memory.js";
import {
  appendDeterministicScreeningSnapshot,
  buildDeterministicObservations,
  formatDeterministicPromptBlock,
  summarizeDeterministicDecisions,
} from "../tools/screening-observer.js";

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

async function main() {
  const limit = Number(argValue("limit", 10));
  const noRecon = hasFlag("no-recon");

  console.log("=== Observe-Only Deterministic Screening Runner ===\n");
  console.log("This does not deploy. It scores candidates and saves an observer snapshot.\n");

  const [positions, balance] = await Promise.all([
    getMyPositions({ force: true }).catch((error) => ({ error: error.message, positions: [], total_positions: 0 })),
    getWalletBalances().catch((error) => ({ error: error.message, sol: 0 })),
  ]);

  const deployAmount = computeDeployAmount(balance.sol || 0);
  console.log(`Positions: ${positions.total_positions ?? positions.positions?.length ?? 0}/${config.risk.maxPositions}`);
  console.log(`SOL: ${Number(balance.sol || 0).toFixed(3)} | computed deploy amount: ${deployAmount} SOL\n`);

  const topCandidates = await getTopCandidates({ limit });
  const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, limit);
  const observations = buildDeterministicObservations(candidates);
  const summary = summarizeDeterministicDecisions(observations);

  console.log(`Candidates: ${candidates.length}`);
  console.log(`Decision summary: ${JSON.stringify(summary)}\n`);

  const recon = [];
  if (!noRecon) {
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      recon.push({
        pool: pool.pool,
        smart_wallets: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        narrative: narrative.status === "fulfilled" ? narrative.value : null,
        token_info: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        memory: recallForPool(pool.pool),
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  for (const entry of observations) {
    const block = formatDeterministicPromptBlock(entry.pool, entry.deterministic, entry.index);
    console.log(block);
    const r = recon.find((item) => item.pool === entry.pool.pool);
    if (r) {
      const smartWalletCount = r.smart_wallets?.in_pool?.length ?? 0;
      const narrative = r.narrative?.narrative ? sanitizeUntrustedPromptText(r.narrative.narrative, 220) : "none";
      console.log(`  recon: smart_wallets=${smartWalletCount}, narrative=${narrative}`);
    }
    console.log("");
  }

  const file = appendDeterministicScreeningSnapshot({
    source: "test-screening-observer",
    observations,
    extra: {
      deploy_amount_sol: deployAmount,
      balance_sol: balance.sol ?? null,
      position_count: positions.total_positions ?? positions.positions?.length ?? null,
      filtered_examples: topCandidates?.filtered_examples ?? [],
      recon,
    },
  });

  console.log(`Snapshot saved: ${file}`);
  console.log("\n=== Done ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
