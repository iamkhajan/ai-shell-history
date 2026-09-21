import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk";

export type Action = "cd" | "code" | "open" | "web" | "no_action";

export interface Repository {
  name: string;
  description: string | null;
  url?: string;
  path?: string;
}

export interface RankedRepository extends Repository {
  score: number;
}

export interface RepositoryRanking {
  action: Action;
  actionConfidence: number;
  hasMatch: number;
  ranked: RankedRepository[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface FileHit {
  path: string;
  matches: { line: number; text: string }[];
}

export interface RankedFile extends FileHit {
  score: number;
}

const ACTION_WORDS = new Set([
  "a",
  "an",
  "change",
  "code",
  "find",
  "finder",
  "for",
  "go",
  "in",
  "me",
  "open",
  "path",
  "pr",
  "project",
  "repo",
  "repository",
  "show",
  "the",
  "this",
  "to",
  "web",
  "vscode",
  "edit",
  "launch",
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  backend: ["service", "api"],
  frontend: ["webapp", "ui"],
  management: ["mgmt"],
  secret: ["secrets"],
  secrets: ["secret"],
};

const ACTION_CRITERIA: Record<Action, string> = {
  cd: "Work in the local repository through the terminal, including running commands, changing branches, building, or testing.",
  code: "Open or edit the local repository in Visual Studio Code.",
  open: "Open the local repository in the system file browser.",
  web: "View the repository on GitHub or in a web browser.",
  no_action: "Find, identify, or inspect repository results without requesting that an application or location be opened.",
};

export function parseRepositoryMetadata(text: string): Repository[] {
  const repositories: Repository[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`invalid repository metadata on line ${index + 1}`);
    }
    if (!isRepositoryMetadata(value)) throw new Error(`invalid repository metadata on line ${index + 1}`);
    repositories.push({ name: value.name, description: value.description, url: value.url });
  }
  return repositories;
}

function isRepositoryMetadata(value: unknown): value is { name: string; description: string | null; url: string } {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.name === "string" &&
    (typeof row.description === "string" || row.description === null) &&
    typeof row.url === "string"
  );
}

export function normalizeRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const scp = /^git@github\.com:([^/]+\/.+)$/.exec(trimmed);
  if (scp) return scp[1]!.toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    return url.pathname.replace(/^\//, "").toLowerCase();
  } catch {
    return undefined;
  }
}

export function discoverRepositories(workspaceRoot: string, metadataFile: string): Repository[] {
  const metadata = parseRepositoryMetadata(readFileSync(metadataFile, "utf8"));
  const byRemote = new Map(metadata.map((repo) => [normalizeRemote(repo.url!), repo]));
  const unmatchedLocals: Repository[] = [];

  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoPath = join(workspaceRoot, entry.name);
    if (!existsSync(join(repoPath, ".git"))) continue;

    try {
      const valid = execFileSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (valid !== "true") continue;
    } catch {
      continue;
    }

    let remote: string | undefined;
    try {
      remote = execFileSync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      remote = undefined;
    }

    const key = remote ? normalizeRemote(remote) : undefined;
    const known = key ? byRemote.get(key) : undefined;
    if (known) {
      known.path = repoPath;
    } else {
      unmatchedLocals.push({
        name: basename(repoPath),
        description: null,
        ...(remote ? { url: remote } : {}),
        path: repoPath,
      });
    }
  }

  return [...metadata, ...unmatchedLocals];
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function queryTokens(query: string): string[] {
  return [...new Set(tokens(query).filter((token) => !ACTION_WORDS.has(token)))];
}

function fieldScore(queryToken: string, fieldTokens: readonly string[], exactWeight: number): number {
  if (fieldTokens.includes(queryToken)) return exactWeight;
  return fieldTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token)) ? 1 : 0;
}

function repositoryTokenScore(queryToken: string, identity: readonly string[], description: readonly string[]): number {
  const direct = Math.max(fieldScore(queryToken, identity, 6), fieldScore(queryToken, description, 3));
  const alias = Math.max(
    0,
    ...(TOKEN_ALIASES[queryToken] ?? []).map((token) =>
      Math.max(fieldScore(token, identity, 2), fieldScore(token, description, 1)),
    ),
  );
  return Math.max(direct, alias);
}

export function shortlistRepositories(query: string, repositories: readonly Repository[], limit = 30): Repository[] {
  const wanted = queryTokens(query);
  if (wanted.length === 0) return [];

  return repositories
    .map((repo, index) => {
      const identity = tokens(`${repo.name} ${repo.path ?? ""}`);
      const description = tokens(repo.description ?? "");
      const tokenScores = wanted.map((token) => repositoryTokenScore(token, identity, description));
      const matchedTerms = tokenScores.filter((score) => score > 0).length;
      const score = matchedTerms * 10 + tokenScores.reduce((total, tokenScore) => total + tokenScore, 0);
      return { repo, score, index };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ repo }) => repo);
}

function candidateId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

export function buildRepositoryRequest(query: string, repositories: readonly Repository[]) {
  const candidateRepositories = repositories
    .map(
      (repo, index) =>
        `${candidateId("R", index)}| name=${repo.name} | checkout=${repo.path ? basename(repo.path) : "not checked out"} | description=${repo.description ?? "none"}`,
    )
    .join("\n");
  const criteria = Object.fromEntries(repositories.map((_, index) => [candidateId("R", index), null])) as Record<
    string,
    null
  >;

  return {
    state: { user_query: query, candidate_repositories: candidateRepositories },
    questions: {
      repository: choice(
        {
          question: "Which candidate repository best matches what the user wants to work on?",
          guidance: "Use repository name, local path, and description. Select by domain purpose, not only word overlap.",
        },
        criteria,
      ),
      has_match: noul("Does at least one candidate repository genuinely fit the user's request?", {
        true: "A candidate clearly owns or implements the requested domain, product, service, or tooling.",
        false: "The candidates only share incidental words or the request is unrelated to them.",
      }),
      action: choice("What action, if any, does the user explicitly want to perform with the matching repository?", ACTION_CRITERIA),
    },
  };
}

export async function rankRepositories(
  client: TypeSafeClient,
  query: string,
  repositories: readonly Repository[],
  model?: string,
): Promise<RepositoryRanking> {
  if (repositories.length === 0) {
    return {
      action: "no_action",
      actionConfidence: 0,
      hasMatch: 0,
      ranked: [],
      model: model ?? "",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const { state, questions } = buildRepositoryRequest(query, repositories);
  const response = await client.systemOne(model ? { state, questions, model } : { state, questions });
  const probabilities = response.answers.repository.probabilities;

  return {
    action: response.answers.action.choice,
    actionConfidence: response.answers.action.confidence,
    hasMatch: response.answers.has_match.noul,
    ranked: repositories
      .map((repo, index) => ({ ...repo, score: probabilities[candidateId("R", index)] ?? 0 }))
      .sort((a, b) => b.score - a.score),
    model: response.model,
    usage: response.usage,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function githubSlug(url: string): string | undefined {
  return normalizeRemote(url);
}

export function commandFor(
  repo: Repository,
  requestedAction: Action,
  currentDirectory = process.cwd(),
): { action: Action; command: string } | undefined {
  if (requestedAction === "no_action") return undefined;
  if (requestedAction === "web" || repo.path === undefined) {
    const slug = repo.url ? githubSlug(repo.url) : undefined;
    return slug && isSafeTerminalText(slug)
      ? { action: "web", command: `gh repo view ${shellQuote(slug)} --web` }
      : undefined;
  }
  if (!isSafeTerminalText(repo.path)) return undefined;
  const localPath = relative(currentDirectory, repo.path) || ".";
  if (requestedAction === "code") return { action: "code", command: `code -- ${shellQuote(localPath)}` };
  if (requestedAction === "open") return { action: "open", command: `open ${shellQuote(localPath)}` };
  return { action: "cd", command: `cd ${shellQuote(localPath)}` };
}

export function commandToQueue(
  ranking: RepositoryRanking,
  matchThreshold = 0.5,
  scoreThreshold = 0.8,
  actionThreshold = 0.5,
  currentDirectory = process.cwd(),
): string | undefined {
  const top = ranking.ranked[0];
  if (
    ranking.action === "no_action" ||
    ranking.actionConfidence < actionThreshold ||
    ranking.hasMatch < matchThreshold ||
    top === undefined ||
    top.score < scoreThreshold
  ) {
    return undefined;
  }
  return commandFor(top, ranking.action, currentDirectory)?.command;
}

export function searchRepository(repoPath: string, searchText: string): FileHit[] {
  const pathsResult = spawnSync(
    "rg",
    ["--files-with-matches", "--null", "--fixed-strings", "--max-filesize=1M", "--glob=!**/.git/**", "--", searchText, repoPath],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (pathsResult.error) throw new Error(`rg failed: ${pathsResult.error.message}`);
  if (pathsResult.status !== 0 && pathsResult.status !== 1) {
    throw new Error(pathsResult.stderr.trim() || `rg exited with ${pathsResult.status}`);
  }
  const paths = pathsResult.stdout.split("\0").filter(Boolean).slice(0, 100);
  if (paths.length === 0) return [];

  const result = spawnSync(
    "rg",
    ["--json", "--fixed-strings", "--max-count=3", "--max-columns=240", "--max-columns-preview", "--", searchText, ...paths],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`rg failed: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim() || `rg exited with ${result.status}`);
  return parseRgJson(result.stdout, repoPath);
}

function isSafeTerminalText(value: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(value);
}

export function parseRgJson(output: string, repoPath: string): FileHit[] {
  const files = new Map<string, FileHit>();
  for (const raw of output.split("\n")) {
    if (raw === "") continue;
    const event = JSON.parse(raw) as {
      type?: string;
      data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
    };
    if (event.type !== "match") continue;
    const rawPath = event.data?.path?.text;
    const text = event.data?.lines?.text;
    const line = event.data?.line_number;
    if (rawPath === undefined || text === undefined || line === undefined) continue;
    const path = relative(repoPath, isAbsolute(rawPath) ? rawPath : join(repoPath, rawPath));
    const hit = files.get(path) ?? { path, matches: [] };
    hit.matches.push({ line, text: text.trimEnd().slice(0, 240) });
    files.set(path, hit);
    if (files.size >= 100) break;
  }
  return [...files.values()];
}

export function buildFileRequest(searchText: string, files: readonly FileHit[]) {
  const candidateFiles = files
    .map((file, index) => {
      const snippets = file.matches
        .slice(0, 3)
        .map((match) => `${match.line}: ${match.text.replace(/\s+/g, " ").slice(0, 180)}`)
        .join(" | ");
      return `${candidateId("F", index)}| path=${file.path} | matches=${snippets}`;
    })
    .join("\n");
  const criteria = Object.fromEntries(files.map((_, index) => [candidateId("F", index), null])) as Record<string, null>;
  return {
    state: { search_text: searchText, candidate_files: candidateFiles },
    questions: {
      file: choice(
        "Which file is most useful for understanding or changing the searched concept? Use both its path and matching snippets.",
        criteria,
      ),
    },
  };
}

export async function rankFiles(
  client: TypeSafeClient,
  searchText: string,
  files: readonly FileHit[],
  model?: string,
): Promise<RankedFile[]> {
  if (files.length <= 1) return files.map((file) => ({ ...file, score: 1 }));
  const { state, questions } = buildFileRequest(searchText, files);
  const response = await client.systemOne(model ? { state, questions, model } : { state, questions });
  const probabilities = response.answers.file.probabilities;
  return files
    .map((file, index) => ({ ...file, score: probabilities[candidateId("F", index)] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}
