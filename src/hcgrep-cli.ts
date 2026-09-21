#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  commandFor,
  commandToQueue,
  discoverRepositories,
  rankFiles,
  rankRepositories,
  searchRepository,
  shortlistRepositories,
} from "./hcgrep.ts";

const HELP = `ag (hcgrep): find repositories and files with Jev

Usage: ag <query> [options]

Options:
      --for <text>      Search this exact text inside the best local repository
      --limit <n>       Results to display (default: 5)
      --shortlist <n>   Repositories sent to Jev (default: 30)
      --threshold <p>   Minimum repository match probability (default: 0.5)
      --queue-threshold <p>  Minimum top score to prefill a command (default: 0.8)
      --action-threshold <p> Minimum action confidence to produce a command (default: 0.5)
      --model <name>    TypeSafe model (default: SDK default, jev-latest)
  -h, --help

Uses WORKSPACE_ROOT when set, otherwise the current directory.
Requires TYPESAFE_API_KEY in the environment.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      for: { type: "string" },
      limit: { type: "string", default: "5" },
      shortlist: { type: "string", default: "30" },
      threshold: { type: "string", default: "0.5" },
      "queue-threshold": { type: "string", default: "0.8" },
      "action-threshold": { type: "string", default: "0.5" },
      queue: { type: "boolean", default: false },
      model: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  const query = positionals.join(" ").trim();
  if (query === "") return usageError("a query is required");
  const root = process.env.WORKSPACE_ROOT || process.cwd();
  if (!existsSync(root)) return usageError(`WORKSPACE_ROOT does not exist: ${root}`);
  if (!process.env.TYPESAFE_API_KEY) return usageError("TYPESAFE_API_KEY is not set");

  const limit = positiveInteger(values.limit, "--limit");
  const shortlistSize = positiveInteger(values.shortlist, "--shortlist");
  const threshold = probability(values.threshold, "--threshold");
  const queueThreshold = probability(values["queue-threshold"], "--queue-threshold");
  const actionThreshold = probability(values["action-threshold"], "--action-threshold");
  const metadataFile = fileURLToPath(new URL("../repos.json", import.meta.url));
  const repositories = discoverRepositories(root, metadataFile);
  const candidates = shortlistRepositories(query, repositories, shortlistSize);

  if (candidates.length === 0) {
    process.stdout.write("No matching repository.\n");
    return 1;
  }

  const client = new TypeSafeClient({ logLevel: "error" });
  const ranking = await rankRepositories(client, query, candidates, values.model);
  if (ranking.hasMatch < threshold || ranking.ranked.length === 0) {
    process.stdout.write(`No matching repository (match ${ranking.hasMatch.toFixed(2)}).\n`);
    return 1;
  }

  if (values.for !== undefined) {
    const repo = ranking.ranked[0]!;
    if (!repo.path) {
      const remote = commandFor(repo, "web");
      process.stdout.write(`Best match ${safeDisplay(repo.name)} is not checked out locally.\n`);
      if (remote) process.stdout.write(`  ${remote.command}\n`);
      return 1;
    }
    const hits = searchRepository(repo.path, values.for);
    if (hits.length === 0) {
      process.stdout.write(`No files in ${safeDisplay(repo.name)} contain ${JSON.stringify(values.for)}.\n`);
      return 1;
    }
    const rankedFiles = await rankFiles(client, values.for, hits, values.model);
    process.stdout.write(`Repository: ${safeDisplay(repo.name)} (${ranking.hasMatch.toFixed(2)})\n`);
    for (const file of rankedFiles.slice(0, limit)) {
      process.stdout.write(`${file.score.toFixed(3)}  ${safeDisplay(file.path)}\n`);
      for (const match of file.matches.slice(0, 3)) {
        process.stdout.write(`       ${match.line}: ${safeDisplay(match.text)}\n`);
      }
    }
    return 0;
  }

  if (values.queue) {
    const command = commandToQueue(ranking, threshold, queueThreshold, actionThreshold);
    if (command) {
      process.stdout.write(`QUEUE\t${command}\n`);
      return 0;
    }
  }

  const hasAction = ranking.action !== "no_action" && ranking.actionConfidence >= actionThreshold;
  const actionStatus =
    ranking.action === "no_action"
      ? `none (${ranking.actionConfidence.toFixed(2)})`
      : `${ranking.action} (${ranking.actionConfidence.toFixed(2)}${hasAction ? "" : `, below threshold ${actionThreshold.toFixed(2)}`})`;
  process.stdout.write(
    `Match ${ranking.hasMatch.toFixed(2)}  action ${actionStatus}\n`,
  );
  if (!hasAction) {
    for (const repo of ranking.ranked.slice(0, limit)) {
      process.stdout.write(`${repo.score.toFixed(3)}  ${safeDisplay(repo.name)}\n`);
    }
    return 0;
  }
  const renderable = ranking.ranked.flatMap((repo) => {
    const rendered = commandFor(repo, ranking.action);
    return rendered ? [{ repo, rendered }] : [];
  });
  if (renderable.length === 0) {
    process.stdout.write("No actionable repository result.\n");
    return 1;
  }
  for (const { repo, rendered } of renderable.slice(0, limit)) {
    const fallback = rendered.action !== ranking.action ? ` (${rendered.action}: not checked out)` : "";
    process.stdout.write(`${repo.score.toFixed(3)}  ${safeDisplay(repo.name)}${fallback}\n       ${rendered.command}\n`);
  }
  return 0;
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function probability(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${flag} must be between 0 and 1`);
  return value;
}

function usageError(message: string): number {
  process.stderr.write(`hcgrep: ${message} (see --help)\n`);
  return 2;
}

function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "?");
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`hcgrep: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
