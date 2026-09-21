import assert from "node:assert/strict";
import { test } from "node:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  buildHistorySearchRequest,
  containsSensitiveData,
  isDangerousCommand,
  searchableHistory,
  searchHistory,
  shouldQueueHistoryMatch,
  type HistorySearchResult,
} from "./history-search.ts";

function fakeClient(answers: (body: any) => unknown) {
  const calls: any[] = [];
  const client = new TypeSafeClient({
    apiKey: "test",
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(
        JSON.stringify({ model: body.model, answers: answers(body), usage: { input_tokens: 12, output_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, calls };
}

test("searchableHistory removes helper calls and commands containing probable credentials", () => {
  const commands = [
    "git status",
    "ah find git status",
    "ag open payments repo",
    "hcgrep payments",
    "export GITHUB_TOKEN=secret-value",
    "curl --password hunter2 https://example.com",
    "curl -H 'Authorization: Bearer secret' https://example.com",
    "./deploy.sh QWxhZGRpbjpPcGVuU2VzYW1lVGhpc0lzT3BhcXVl",
    "kubectl get secret app-config",
  ];
  assert.deepEqual(searchableHistory(commands), ["git status", "kubectl get secret app-config"]);
  assert.equal(containsSensitiveData("https://alice:hunter2@example.com/path"), true);
  assert.equal(containsSensitiveData("echo $GITHUB_TOKEN"), false);
});

test("dangerous command detection identifies destructive commands without hiding them", () => {
  assert.equal(isDangerousCommand("rm -rf build"), true);
  assert.equal(isDangerousCommand("git reset --hard HEAD~1"), true);
  assert.equal(isDangerousCommand("git push origin main --force-with-lease"), true);
  assert.equal(isDangerousCommand("kubectl delete pod api"), true);
  assert.equal(isDangerousCommand("rm build.log"), false);
  assert.equal(isDangerousCommand("git status"), false);
});

test("history search request describes semantic recall and preserves recent-first ids", () => {
  const { state, questions } = buildHistorySearchRequest("restart local database", [
    "docker compose restart postgres",
    "npm test",
  ]);
  assert.equal(
    state.candidate_commands,
    "H00| command=docker compose restart postgres\nH01| command=npm test",
  );
  assert.deepEqual(Object.keys(questions), ["command", "has_match"]);
  assert.deepEqual(Object.keys(questions.command.criteria), ["H00", "H01"]);
});

test("searchHistory ranks exact history commands from Jev probabilities", async () => {
  const { client, calls } = fakeClient(() => ({
    command: {
      type: "choice",
      choice: "H01",
      confidence: 0.7,
      probabilities: { H00: 0.15, H01: 0.85 },
    },
    has_match: { type: "noul", noul: 0.92 },
  }));
  const result = await searchHistory(client, "show cluster workloads", ["git status", "kubectl get pods"]);

  assert.equal(calls.length, 1);
  assert.equal(result.hasMatch, 0.92);
  assert.equal(result.choiceConfidence, 0.7);
  assert.deepEqual(result.ranked.map(({ command, score }) => [command, score]), [
    ["kubectl get pods", 0.85],
    ["git status", 0.15],
  ]);
});

test("searchHistory batches large histories and reranks batch winners", async () => {
  const { client, calls } = fakeClient((body) => {
    const ids = Object.keys(body.questions.command.criteria);
    const winner = ids.length === 15 ? "H10" : "H00";
    return {
      command: {
        type: "choice",
        choice: winner,
        confidence: 0.8,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === winner ? 1 : 0])),
      },
      has_match: { type: "noul", noul: 0.9 },
    };
  });
  const commands = Array.from({ length: 500 }, (_, index) => `command-${index}`);
  const result = await searchHistory(client, "remember a command", commands);

  assert.equal(calls.length, 4, "three parallel batches plus one finalist request");
  assert.equal(result.ranked[0]?.command, "command-400");
  assert.deepEqual(result.usage, { input_tokens: 48, output_tokens: 8 });
});

test("queue gate requires both a genuine match and a strong top candidate", () => {
  const result = (hasMatch: number, score: number): HistorySearchResult => ({
    hasMatch,
    choiceConfidence: 0.8,
    ranked: [{ command: "git status", score }],
    model: "test",
    usage: { input_tokens: 0, output_tokens: 0 },
  });

  assert.equal(shouldQueueHistoryMatch(result(0.5, 0.5)), true);
  assert.equal(shouldQueueHistoryMatch(result(0.49, 0.9)), false);
  assert.equal(shouldQueueHistoryMatch(result(0.9, 0.49)), false);
});
