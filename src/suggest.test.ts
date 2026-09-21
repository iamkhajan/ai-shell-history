import { test } from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { buildRequest, hasPrefixMatch, pickSuggestion, selectCandidates, suggest, type SuggestResult } from "./suggest.ts";

const candidatesOf = (typed: string, commands: string[]) =>
  selectCandidates(typed, commands, { prefixFilter: false }).candidates;

/** A client whose HTTP layer is replaced; records the request body and replies with `answers`. */
function fakeClient(answers: (body: any) => unknown) {
  const calls: any[] = [];
  const client = new TypeSafeClient({
    apiKey: "test",
    logLevel: "off",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const payload = { model: body.model, answers: answers(body), usage: { input_tokens: 10, output_tokens: 2 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, calls };
}

test("selectCandidates narrows to literal prefix matches when any exist, renumbering from C00", () => {
  const { mode, candidates } = selectCandidates("cd w", ["cd amp-1", "cd work/amp-1", "cd", "cd work/blog"]);
  assert.equal(mode, "prefix");
  assert.deepEqual(candidates, [
    { id: "C00", command: "cd work/amp-1" },
    { id: "C01", command: "cd work/blog" },
  ]);
});

test("selectCandidates is case-sensitive and falls back to fuzzy mode over everything", () => {
  const { mode, candidates } = selectCandidates("Cd w", ["cd work/amp-1", "ls"]);
  assert.equal(mode, "fuzzy");
  assert.deepEqual(
    candidates.map((c) => c.command),
    ["cd work/amp-1", "ls"],
  );
});

test("selectCandidates drops the exact typed command in both modes", () => {
  assert.deepEqual(
    selectCandidates("ls", ["ls", "git status", "ls -la"]).candidates.map((c) => c.command),
    ["ls -la"],
    "prefix mode: `ls` itself is not a completion of `ls`",
  );
  assert.deepEqual(
    candidatesOf("ls", ["ls", "git status", "ls -la"]).map((c) => c.command),
    ["git status", "ls -la"],
    "prefixFilter=false: still drops `ls`, keeps everything else in history order",
  );
});

test("hasPrefixMatch is true only when some other command literally starts with typed", () => {
  assert.equal(hasPrefixMatch("git ch", ["git checkout -b x", "git status"]), true);
  assert.equal(hasPrefixMatch("git ch", ["npm test"]), false);
  assert.equal(hasPrefixMatch("git status", ["git status"]), false, "the exact typed command doesn't count");
});

test("buildRequest tags every candidate and asks a Choice over the ids plus a Noul gate", () => {
  const { state, questions } = buildRequest("gi", candidatesOf("gi", ["git status", "npm test"]));
  assert.equal(state.typed_so_far, "gi");
  assert.equal(state.candidate_commands, "C00| command=git status\nC01| command=npm test");
  assert.equal(questions.completion.type, "choice");
  assert.deepEqual(Object.keys(questions.completion.criteria), ["C00", "C01"]);
  assert.equal(questions.has_completion.type, "noul");
});

test("buildRequest includes priority groups as contextual metadata", () => {
  const candidates = selectCandidates(
    "release",
    [{ command: "npm run deploy", group: "backend release" }, { command: "git status" }],
    { prefixFilter: false },
  ).candidates;
  const { state } = buildRequest("release", candidates);
  assert.equal(
    state.candidate_commands,
    "C00| group=backend release | command=npm run deploy\nC01| command=git status",
  );
});

test("buildRequest flattens newlines and truncates very long commands in the state only", () => {
  const long = "x".repeat(500);
  const { state } = buildRequest("a", candidatesOf("a", ["for f in *; do\n echo $f\ndone", long]));
  const lines = state.candidate_commands.split("\n");
  assert.equal(lines.length, 2, "multi-line command must stay on one tagged line");
  assert.equal(lines[0], "C00| command=for f in *; do\\n echo $f\\ndone");
  assert.ok(lines[1]!.length < 260 && lines[1]!.endsWith("…"));
});

test("suggest ranks by Jev's probabilities, not by history order or prefix match", async () => {
  const { client, calls } = fakeClient(() => ({
    completion: {
      type: "choice",
      choice: "C02",
      confidence: 0.6,
      probabilities: { C00: 0.1, C01: 0.2, C02: 0.7 },
    },
    has_completion: { type: "noul", noul: 0.93 },
  }));

  // `gsutil ls` is a literal prefix match, so with the filter on it would be the
  // only candidate; disable it here to exercise the ranking path.
  const result = await suggest(client, "gs", ["ls", "gsutil ls", "git status"], { prefixFilter: false });

  assert.equal(calls.length, 1, "both questions go in one request");
  assert.deepEqual(Object.keys(calls[0].questions), ["completion", "has_completion"]);
  assert.deepEqual(Object.keys(calls[0].questions.completion.criteria), ["C00", "C01", "C02"]);
  assert.equal(calls[0].model, "jev-latest");

  assert.equal(result.mode, "fuzzy");
  assert.equal(result.hasCompletion, 0.93);
  assert.deepEqual(
    result.ranked.map((s) => [s.command, s.score, s.isPrefix]),
    [
      ["git status", 0.7, false],
      ["gsutil ls", 0.2, true],
      ["ls", 0.1, false],
    ],
  );
});

test("suggest in prefix mode sends only the prefix matches and ranks them by Jev", async () => {
  const { client, calls } = fakeClient((body) => {
    assert.equal(body.state.candidate_commands, "C00| command=amp --no-tui\nC01| command=amp --no-tui --dir blog");
    return {
      completion: { type: "choice", choice: "C01", confidence: 0.5, probabilities: { C00: 0.4, C01: 0.6 } },
      has_completion: { type: "noul", noul: 0.99 },
    };
  });
  const result = await suggest(client, "amp --", ["amp", "amp --no-tui", "ls", "amp --no-tui --dir blog"]);
  assert.equal(calls.length, 1);
  assert.equal(result.mode, "prefix");
  assert.deepEqual(
    result.ranked.map((s) => [s.command, s.score]),
    [
      ["amp --no-tui --dir blog", 0.6],
      ["amp --no-tui", 0.4],
    ],
  );
});

test("suggest carries the winning group as metadata", async () => {
  const { client } = fakeClient(() => ({
    completion: { type: "choice", choice: "C00", confidence: 1, probabilities: { C00: 1, C01: 0 } },
    has_completion: { type: "noul", noul: 0.95 },
  }));
  const result = await suggest(
    client,
    "release",
    [{ command: "npm run deploy", group: "backend" }, { command: "git status" }],
    { prefixFilter: false },
  );
  assert.deepEqual(result.ranked[0], {
    command: "npm run deploy",
    group: "backend",
    score: 1,
    isPrefix: false,
  });
});

test("suggest with a single prefix match answers instantly without a request", async () => {
  const { client, calls } = fakeClient(() => {
    throw new Error("should not be called");
  });
  const result = await suggest(client, "cd w", ["cd amp-1", "cd work/amp-1", "ls"]);
  assert.equal(calls.length, 0);
  assert.equal(result.mode, "prefix");
  assert.deepEqual(result.ranked, [{ command: "cd work/amp-1", score: 1, isPrefix: true }]);
  assert.equal(result.hasCompletion, 1);
});

test("suggest passes the model override through and tolerates missing probabilities", async () => {
  const { client, calls } = fakeClient(() => ({
    completion: { type: "choice", choice: "C00", confidence: 1, probabilities: { C00: 1 } },
    has_completion: { type: "noul", noul: 0.2 },
  }));
  const result = await suggest(client, "np", ["npm test", "ls"], { model: "jev-1.13", prefixFilter: false });
  assert.equal(calls[0].model, "jev-1.13");
  assert.deepEqual(
    result.ranked.map((s) => s.score),
    [1, 0],
  );
});

test("suggest makes no request when nothing can complete the typed text", async () => {
  const { client, calls } = fakeClient(() => {
    throw new Error("should not be called");
  });
  const result = await suggest(client, "ls", ["ls"]);
  assert.equal(calls.length, 0);
  assert.deepEqual(result.ranked, []);
  assert.equal(result.hasCompletion, 0);
});

function fuzzyResult(hasCompletion: number, scores: number[]): SuggestResult {
  return {
    mode: "fuzzy",
    hasCompletion,
    ranked: scores.map((score, i) => ({ command: `cmd${i}`, score, isPrefix: false })),
    usage: { input_tokens: 0, output_tokens: 0 },
    model: "test",
  };
}

test("pickSuggestion: prefix mode always suggests the top candidate, whatever the numbers say", () => {
  const result: SuggestResult = { ...fuzzyResult(0.01, [0.2, 0.1]), mode: "prefix" };
  assert.equal(pickSuggestion(result)?.command, "cmd0");
});

test("pickSuggestion: fuzzy mode needs the Noul gate and a minimally confident top score", () => {
  assert.equal(pickSuggestion(fuzzyResult(0.5, [0.3, 0.2]))?.command, "cmd0"); // both exactly at the gates
  assert.equal(pickSuggestion(fuzzyResult(0.49, [0.3])), undefined); // Noul just under
  assert.equal(pickSuggestion(fuzzyResult(0.8, [0.29, 0.28])), undefined); // Noul over-generous, Choice flat
});

test("pickSuggestion: a decisive Choice overrides a borderline Noul, but never a low top score", () => {
  assert.equal(pickSuggestion(fuzzyResult(0.48, [0.97, 0.01]))?.command, "cmd0"); // seen with a 5-entry history
  assert.equal(pickSuggestion(fuzzyResult(0.07, [0.9]))?.command, "cmd0"); // exactly at strongScore
  assert.equal(pickSuggestion(fuzzyResult(0.07, [0.89])), undefined);
  assert.equal(pickSuggestion(fuzzyResult(0.99, [0.1]), { threshold: 0.5, minScore: 0.3, strongScore: 0.05 }), undefined);
});

test("pickSuggestion: nothing ranked means nothing suggested", () => {
  assert.equal(pickSuggestion(fuzzyResult(1, [])), undefined);
});
