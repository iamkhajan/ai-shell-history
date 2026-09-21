#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { readHistoryFile, recentCommands } from "./history.ts";
import {
  isDangerousCommand,
  searchableHistory,
  searchHistory,
  shouldQueueHistoryMatch,
  type HistoryMatch,
} from "./history-search.ts";

const HELP = `ah: find a command from recent shell history with Jev

Usage: ah <description> [options]

Options:
      --history <path>          History file (default: $HISTFILE or ~/.zsh_history)
      --limit <n>               Recent distinct commands to search (default: 500)
      --threshold <p>           Minimum probability that any command matches (default: 0.5)
      --queue-threshold <p>     Minimum top candidate probability to prefill (default: 0.5)
      --results <n>             Results shown when no command is queued (default: 5)
      --model <name>            TypeSafe model (default: SDK default, jev-latest)
  -h, --help

Matching commands are selected from history exactly as written. Commands are never
generated or executed. Probable secrets are excluded, and dangerous commands are
shown for review instead of being prefilled.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      history: { type: "string" },
      limit: { type: "string", default: "500" },
      threshold: { type: "string", default: "0.5" },
      "queue-threshold": { type: "string", default: "0.5" },
      results: { type: "string", default: "5" },
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
  if (query === "") return usageError("a description is required");
  if (!process.env.TYPESAFE_API_KEY) return usageError("TYPESAFE_API_KEY is not set");

  const limit = positiveInteger(values.limit, "--limit");
  const resultLimit = positiveInteger(values.results, "--results");
  const threshold = probability(values.threshold, "--threshold");
  const queueThreshold = probability(values["queue-threshold"], "--queue-threshold");
  const historyPath = values.history ?? process.env.HISTFILE ?? join(homedir(), ".zsh_history");
  const commands = searchableHistory(recentCommands(readHistoryFile(historyPath), limit));

  if (commands.length === 0) {
    process.stdout.write("No searchable history commands.\n");
    return 1;
  }

  const client = new TypeSafeClient({ logLevel: "error" });
  const result = await searchHistory(client, query, commands, values.model);
  const top = result.ranked[0];
  const strong = shouldQueueHistoryMatch(result, threshold, queueThreshold);

  if (strong && top) {
    if (values.queue && !isDangerousCommand(top.command)) {
      process.stdout.write(`QUEUE\t${top.command}`);
      return 0;
    }
    process.stdout.write(
      isDangerousCommand(top.command)
        ? "Match requires review; dangerous commands are not queued.\n"
        : `Best match (match ${result.hasMatch.toFixed(2)}).\n`,
    );
  } else {
    process.stdout.write(`No strong match (match ${result.hasMatch.toFixed(2)}).\n`);
  }
  printMatches(result.ranked, resultLimit);
  return strong ? 0 : 1;
}

function printMatches(matches: readonly HistoryMatch[], limit: number): void {
  for (const match of matches.slice(0, limit)) {
    const warning = isDangerousCommand(match.command) ? "  [review]" : "";
    process.stdout.write(`${match.score.toFixed(3)}${warning}  ${safeDisplay(match.command)}\n`);
  }
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
  process.stderr.write(`ah: ${message} (see --help)\n`);
  return 2;
}

function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "?");
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`ah: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
