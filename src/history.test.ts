import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHistory, readCommandListFile, readHistoryFile, recentCommands, unmetafy } from "./history.ts";

test("parses extended history lines into commands with timestamps", () => {
  const entries = parseHistory(": 1700000000:0;git status\n: 1700000001:5;npm test\n");
  assert.deepEqual(entries, [
    { command: "git status", timestamp: 1700000000 },
    { command: "npm test", timestamp: 1700000001 },
  ]);
});

test("joins backslash-continued lines into one multi-line command", () => {
  // zsh writes an embedded newline as backslash+newline. A command that itself
  // ends a line with `\` (shell continuation) therefore appears as `\\` + newline.
  const text = ": 1:0;gcloud foo \\\\\n  --reason=x && \\\\\namp threads continue T-1\n: 2:0;ls\n";
  const entries = parseHistory(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.command, "gcloud foo \\\n  --reason=x && \\\namp threads continue T-1");
  assert.equal(entries[1]!.command, "ls");
});

test("falls back to plain (non-extended) history lines", () => {
  assert.deepEqual(parseHistory("ls -la\ncd ..\n"), [{ command: "ls -la" }, { command: "cd .." }]);
});

test("skips blank lines and trims trailing whitespace", () => {
  assert.deepEqual(parseHistory(": 1:0;echo hi   \n\n: 2:0;   \n"), [{ command: "echo hi", timestamp: 1 }]);
});

test("unmetafy restores bytes zsh escaped with 0x83", () => {
  // "ü" is 0xC3 0xBC in UTF-8; zsh stores each as 0x83 followed by byte ^ 0x20.
  const metafied = Uint8Array.from([0x65, 0x83, 0xc3 ^ 0x20, 0x83, 0xbc ^ 0x20]);
  assert.equal(new TextDecoder().decode(unmetafy(metafied)), "eü");
});

test("recentCommands returns newest first, deduped, keeping the latest position", () => {
  const entries = parseHistory(
    [": 1:0;git status", ": 2:0;npm test", ": 3:0;git status", ": 4:0;ls", ": 5:0;npm test"].join("\n"),
  );
  assert.deepEqual(recentCommands(entries, 10), ["npm test", "ls", "git status"]);
  assert.deepEqual(recentCommands(entries, 2), ["npm test", "ls"]);
});

test("readHistoryFile reads a metafied, multi-line file from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-hist-"));
  const path = join(dir, "history");
  const bytes = Buffer.concat([
    Buffer.from(": 10:0;echo ", "utf-8"),
    Buffer.from([0x83, 0xc3 ^ 0x20, 0x83, 0xbc ^ 0x20]),
    Buffer.from("\n: 11:0;for f in *; do\\\n  echo $f\\\ndone\n", "utf-8"),
  ]);
  writeFileSync(path, bytes);
  assert.deepEqual(readHistoryFile(path), [
    { command: "echo ü", timestamp: 10 },
    { command: "for f in *; do\n  echo $f\ndone", timestamp: 11 },
  ]);
});

test("readCommandListFile assigns # headings as command groups", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-priority-"));
  const path = join(dir, "commands.txt");
  writeFileSync(path, "# git\ngit status\n\ngit add .  \n# docker\ndocker compose up\n");
  assert.deepEqual(readCommandListFile(path), [
    { command: "git status", group: "git" },
    { command: "git add .", group: "git" },
    { command: "docker compose up", group: "docker" },
  ]);
});
