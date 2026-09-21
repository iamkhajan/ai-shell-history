import { choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk";

const MAX_COMMAND_CHARS = 240;
const MAX_BATCH_SIZE = 200;
const BATCH_WINNERS = 5;

export interface HistoryMatch {
  command: string;
  score: number;
}

export interface HistorySearchResult {
  hasMatch: number;
  choiceConfidence: number;
  ranked: HistoryMatch[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

const SENSITIVE_PATTERNS = [
  /(?:^|\s)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/i,
  /(?:^|\s)--(?:password|passwd|token|secret|api-key|private-key)(?:=|\s+)(?:"[^"]+"|'[^']+'|[^\s;&|]+)/i,
  /(?:authorization|x-api-key)\s*:\s*\S+/i,
  /https?:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /(?:^|\s)["']?[A-Za-z0-9+/_=-]{40,}["']?(?:\s|$)/,
];

const DANGEROUS_PATTERNS = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+[^\n]*(?:-[^\s]*[rR][^\s]*|--recursive)(?:\s|$)/,
  /(?:^|[;&|]\s*)git\s+reset\s+[^\n]*--hard(?:\s|$)/,
  /(?:^|[;&|]\s*)git\s+clean\s+[^\n]*-[^\s]*f/,
  /(?:^|[;&|]\s*)git\s+push\s+[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)/,
  /(?:^|[;&|]\s*)terraform\s+destroy(?:\s|$)/,
  /(?:^|[;&|]\s*)kubectl\s+delete(?:\s|$)/,
];

export function containsSensitiveData(command: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function searchableHistory(commands: readonly string[]): string[] {
  return commands.filter(
    (command) => !/^\s*(?:ah|ag|hcgrep)(?:\s|$)/.test(command) && !containsSensitiveData(command),
  );
}

function candidateId(index: number): string {
  return `H${String(index).padStart(2, "0")}`;
}

function displayCommand(command: string): string {
  const oneLine = command.replaceAll("\n", "\\n");
  return oneLine.length > MAX_COMMAND_CHARS ? oneLine.slice(0, MAX_COMMAND_CHARS - 1) + "…" : oneLine;
}

export function buildHistorySearchRequest(query: string, commands: readonly string[]) {
  const candidateCommands = commands
    .map((command, index) => `${candidateId(index)}| command=${displayCommand(command)}`)
    .join("\n");
  const criteria = Object.fromEntries(commands.map((_, index) => [candidateId(index), null])) as Record<string, null>;

  return {
    state: { user_query: query, candidate_commands: candidateCommands },
    questions: {
      command: choice(
        {
          question: "Which command in `candidate_commands` best matches the command or task described by `user_query`?",
          guidance:
            "Select only from the listed command ids. Match the user's intended tool, operation, target, and qualifiers. Prefer the lower id when candidates fit equally well because lower ids are more recent.",
        },
        criteria,
      ),
      has_match: noul("Does at least one command in `candidate_commands` genuinely match `user_query`?", {
        true: "A listed command performs the requested task or is clearly the command the user is trying to recall.",
        false: "Candidates only share incidental words, perform a different operation, or none plausibly satisfy the request.",
      }),
    },
  };
}

export async function searchHistory(
  client: TypeSafeClient,
  query: string,
  commands: readonly string[],
  model?: string,
): Promise<HistorySearchResult> {
  if (commands.length === 0) {
    return {
      hasMatch: 0,
      choiceConfidence: 0,
      ranked: [],
      model: model ?? "",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  if (commands.length <= MAX_BATCH_SIZE) return searchHistoryBatch(client, query, commands, model);

  const batches: string[][] = [];
  for (let index = 0; index < commands.length; index += MAX_BATCH_SIZE) {
    batches.push(commands.slice(index, index + MAX_BATCH_SIZE));
  }
  const batchResults = await Promise.all(batches.map((batch) => searchHistoryBatch(client, query, batch, model)));
  const finalists = batchResults.flatMap((result) => result.ranked.slice(0, BATCH_WINNERS).map(({ command }) => command));
  const final = await searchHistoryBatch(client, query, finalists, model);

  return {
    ...final,
    usage: batchResults.reduce(
      (usage, result) => ({
        input_tokens: usage.input_tokens + result.usage.input_tokens,
        output_tokens: usage.output_tokens + result.usage.output_tokens,
      }),
      final.usage,
    ),
  };
}

async function searchHistoryBatch(
  client: TypeSafeClient,
  query: string,
  commands: readonly string[],
  model?: string,
): Promise<HistorySearchResult> {
  const { state, questions } = buildHistorySearchRequest(query, commands);
  const response = await client.systemOne(model ? { state, questions, model } : { state, questions });
  const answer = response.answers.command;

  return {
    hasMatch: response.answers.has_match.noul,
    choiceConfidence: answer.confidence,
    ranked: commands
      .map((command, index) => ({ command, score: answer.probabilities[candidateId(index)] ?? 0 }))
      .sort((a, b) => b.score - a.score),
    model: response.model,
    usage: response.usage,
  };
}

export function shouldQueueHistoryMatch(
  result: HistorySearchResult,
  matchThreshold = 0.5,
  scoreThreshold = 0.5,
): boolean {
  const top = result.ranked[0];
  return top !== undefined && result.hasMatch >= matchThreshold && top.score >= scoreThreshold;
}
