import { choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk";

/**
 * Asks Jev which recent command the user is typing.
 *
 * One request carries two questions over the same state:
 *  - `completion`: a Choice whose options are the candidate ids. Its probability
 *    distribution ranks every candidate; the top probability is the score.
 *  - `has_completion`: a Noul that says whether any candidate plausibly completes
 *    the typed text at all. Choice probabilities always sum to 1, so without this
 *    gate the closest irrelevant command would always "win".
 *
 * Code owns everything that is exact: dedupe, dropping the already-typed
 * command, literal prefix detection, thresholds, and ordering.
 */

/** Longest command text sent to the model; longer commands are cut with an ellipsis. */
const MAX_COMMAND_CHARS = 240;

export interface Candidate {
  id: string;
  command: string;
  /** Optional curated-list group used as ranking context and display metadata. */
  group?: string;
}

export type CommandInput = string | Omit<Candidate, "id">;

export interface Suggestion {
  command: string;
  group?: string;
  /** Probability Jev assigned to this candidate (0..1). */
  score: number;
  /** True when `command` literally starts with the typed text. */
  isPrefix: boolean;
}

/**
 * `prefix`: some history entries literally start with the typed text; only those
 * were ranked. `fuzzy`: none did, so every recent command was ranked and the
 * caller should gate on `hasCompletion` and the top score.
 */
export type Mode = "prefix" | "fuzzy";

export interface SuggestResult {
  mode: Mode;
  /** Probability that at least one candidate completes the typed text. */
  hasCompletion: number;
  /** All candidates, highest score first. */
  ranked: Suggestion[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface Gates {
  /** Fuzzy mode: minimum `hasCompletion` (Noul) to suggest. */
  threshold: number;
  /** Fuzzy mode: minimum score of the top candidate to suggest. */
  minScore: number;
  /**
   * Fuzzy mode: a top score at or above this overrides a borderline
   * `hasCompletion`. The Choice and the Noul are jagged in different places:
   * on small histories the Noul under-fires for real matches while the Choice
   * is decisive; on nonsense the Choice spreads out while the Noul is near 0.
   */
  strongScore: number;
}

export const DEFAULT_GATES: Gates = { threshold: 0.5, minScore: 0.3, strongScore: 0.9 };

/** The top candidate to show, or undefined when nothing clears the gates. */
export function pickSuggestion(result: SuggestResult, gates: Gates = DEFAULT_GATES): Suggestion | undefined {
  const top = result.ranked[0];
  if (top === undefined) return undefined;
  if (result.mode === "prefix") return top;
  if (top.score < gates.minScore) return undefined;
  if (result.hasCompletion >= gates.threshold || top.score >= gates.strongScore) return top;
  return undefined;
}

/** True when some command (other than `typed` itself) literally starts with it. */
export function hasPrefixMatch(typed: string, commands: readonly CommandInput[]): boolean {
  return commands.some((entry) => {
    const command = typeof entry === "string" ? entry : entry.command;
    return command !== typed && command.startsWith(typed);
  });
}

export function candidateId(index: number): string {
  return `C${String(index).padStart(2, "0")}`;
}

export interface CandidateOptions {
  /** When false, never narrow to literal prefix matches; Jev ranks everything. */
  prefixFilter?: boolean;
}

/**
 * Choose which recent commands (newest first) Jev should rank. Literal prefix
 * matching is an exact rule, so code applies it: if any command starts with
 * `typed`, only those are candidates. The command equal to `typed` is never a
 * candidate since there is nothing left to complete.
 */
export function selectCandidates(
  typed: string,
  commands: readonly CommandInput[],
  options: CandidateOptions = {},
): { mode: Mode; candidates: Candidate[] } {
  const normalized = commands.map((entry) => (typeof entry === "string" ? { command: entry } : entry));
  const rest = normalized.filter(({ command }) => command !== typed);
  const prefixed = options.prefixFilter === false ? [] : rest.filter(({ command }) => command.startsWith(typed));
  const chosen = prefixed.length > 0 ? prefixed : rest;
  return {
    mode: prefixed.length > 0 ? "prefix" : "fuzzy",
    candidates: chosen.map((entry, index) => ({ id: candidateId(index), ...entry })),
  };
}

function displayCommand(command: string): string {
  const oneLine = command.replaceAll("\n", "\\n");
  return oneLine.length > MAX_COMMAND_CHARS ? oneLine.slice(0, MAX_COMMAND_CHARS - 1) + "…" : oneLine;
}

export function buildRequest(typed: string, candidates: readonly Candidate[]) {
  const commands = candidates
    .map((c) => `${c.id}| ${c.group ? `group=${c.group} | ` : ""}command=${displayCommand(c.command)}`)
    .join("\n");

  const state = {
    typed_so_far: typed,
    candidate_commands: commands,
  };

  const criteria = Object.fromEntries(candidates.map((c) => [c.id, null])) as Record<string, null>;

  const questions = {
    completion: choice(
      {
        question:
          "The user is typing a command at a zsh prompt and has typed `typed_so_far` so far. Which command in `candidate_commands` are they most likely in the middle of typing?",
        context:
          "`candidate_commands` lists shell commands as `<id>| group=<group> | command=<command>`. Group is optional contextual metadata from the curated priority file. Use both the group and command to infer intent. The chosen command will be shown as an inline autosuggestion the user can accept with one keystroke.",
        how_to_rank: [
          "Best: the command starts with exactly the characters in `typed_so_far`, in the same order.",
          "Next: `typed_so_far` is an abbreviation of the command (the first letters of its words, e.g. `gst` for `git status`, or `dc` for `docker compose`), or it appears as a contiguous substring of the command.",
          "Next: the command uses the tool or performs the action that `typed_so_far` names, even if spelled differently.",
          "A typed group name or concept may indicate a grouped command even when those characters are not in the command itself.",
          "When several commands fit equally well, prefer the lower id number.",
        ],
      },
      criteria,
    ),
    has_completion: noul(
      "Does at least one command in `candidate_commands` plausibly complete what the user has typed in `typed_so_far`?",
      {
        true: "Some listed command starts with `typed_so_far`, `typed_so_far` is clearly an abbreviation or fragment of one, or it clearly refers to a command's group.",
        false: "`typed_so_far` does not match a listed command or its group; the user is typing something not in the list.",
      },
    ),
  };

  return { state, questions };
}

export interface SuggestOptions extends CandidateOptions {
  model?: string;
  timeoutMs?: number;
}

const NO_USAGE = { input_tokens: 0, output_tokens: 0 };

export async function suggest(
  client: TypeSafeClient,
  typed: string,
  commands: readonly CommandInput[],
  options: SuggestOptions = {},
): Promise<SuggestResult> {
  const { mode, candidates } = selectCandidates(typed, commands, options);
  const model = options.model ?? "";

  if (candidates.length === 0) {
    return { mode, hasCompletion: 0, ranked: [], usage: NO_USAGE, model };
  }
  // A single literal prefix match needs no judgment; suggest it immediately.
  if (mode === "prefix" && candidates.length === 1) {
    const only = candidates[0]!;
    return {
      mode,
      hasCompletion: 1,
      ranked: [{ command: only.command, ...(only.group ? { group: only.group } : {}), score: 1, isPrefix: true }],
      usage: NO_USAGE,
      model,
    };
  }

  const { state, questions } = buildRequest(typed, candidates);
  const response = await client.systemOne(
    options.model ? { state, questions, model: options.model } : { state, questions },
    options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
  );

  const probabilities = response.answers.completion.probabilities;
  const ranked = candidates
    .map((c) => ({
      command: c.command,
      ...(c.group ? { group: c.group } : {}),
      score: probabilities[c.id] ?? 0,
      isPrefix: c.command.startsWith(typed),
    }))
    .sort((a, b) => b.score - a.score);

  return {
    mode,
    hasCompletion: response.answers.has_completion.noul,
    ranked,
    usage: response.usage,
    model: response.model,
  };
}
