import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

/**
 * Zsh history file parsing.
 *
 * Zsh writes one entry per line. With EXTENDED_HISTORY the line is
 * `: <epoch>:<duration>;<command>`. A command containing newlines is written
 * with a backslash before each embedded newline, and zsh strips exactly one
 * trailing backslash per line when reading it back (hist.c), so we do the same.
 *
 * Bytes >= 0x80 are "metafied": the byte 0x83 (Meta) precedes a byte whose
 * value has been XORed with 0x20. We reverse that before decoding as UTF-8.
 */

const META = 0x83;

/** Bytes to read from the end of the file; enough for a few hundred entries. */
const TAIL_BYTES = 512 * 1024;

export interface HistoryEntry {
  command: string;
  /** Epoch seconds; undefined when EXTENDED_HISTORY is off. */
  timestamp?: number;
}

export interface CommandEntry {
  command: string;
  group?: string;
}

export function unmetafy(bytes: Uint8Array): Uint8Array {
  if (!bytes.includes(META)) return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === META && i + 1 < bytes.length) {
      out[n++] = bytes[++i]! ^ 0x20;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

const EXTENDED_LINE = /^: (\d+):(\d+);([\s\S]*)$/;

export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    let raw = lines[i++]!;
    // Continuation: a trailing backslash means the entry continues on the next line.
    while (raw.endsWith("\\") && i < lines.length) {
      raw = raw.slice(0, -1) + "\n" + lines[i++]!;
    }
    if (raw.trim() === "") continue;
    const m = EXTENDED_LINE.exec(raw);
    const command = (m ? m[3]! : raw).replace(/\s+$/, "");
    if (command === "") continue;
    entries.push(m ? { command, timestamp: Number(m[1]) } : { command });
  }
  return entries;
}

/** Read the tail of a history file and return its parsed entries, oldest first. */
export function readHistoryFile(path: string): HistoryEntry[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let bytes: Uint8Array = buf;
    if (start > 0) {
      // Drop the partial first line; if extended format, also drop continuation
      // lines until we hit a line that starts a new entry.
      let cut = bytes.indexOf(0x0a) + 1;
      while (cut > 0 && cut < bytes.length && !startsEntry(bytes, cut)) {
        const next = bytes.indexOf(0x0a, cut);
        if (next < 0) break;
        cut = next + 1;
      }
      bytes = bytes.subarray(cut);
    }
    return parseHistory(new TextDecoder("utf-8", { fatal: false }).decode(unmetafy(bytes)));
  } finally {
    closeSync(fd);
  }
}

function startsEntry(bytes: Uint8Array, at: number): boolean {
  // ": <digit>" is how every extended-history entry begins. For plain
  // history files there is no marker, so accept any line boundary.
  const looksExtended = bytes[0] === 0x3a && bytes[1] === 0x20;
  if (!looksExtended) return true;
  return bytes[at] === 0x3a && bytes[at + 1] === 0x20 && isDigit(bytes[at + 2]);
}

function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x39;
}

/**
 * A curated command list: one command per line, top to bottom is priority
 * order. A `# heading` assigns a group to the commands below it. Unlike the
 * zsh history file, there is no timestamp prefix to parse.
 */
export function readCommandListFile(path: string): CommandEntry[] {
  const entries: CommandEntry[] = [];
  let group: string | undefined;
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("#")) {
      group = line.slice(1).trim() || undefined;
    } else if (line !== "") {
      entries.push(group ? { command: line, group } : { command: line });
    }
  }
  return entries;
}

/**
 * The most recent `limit` distinct commands, newest first. Duplicates keep
 * their most recent position, matching what HIST_IGNORE_ALL_DUPS would show.
 */
export function recentCommands(entries: readonly HistoryEntry[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const command = entries[i]!.command;
    if (seen.has(command)) continue;
    seen.add(command);
    out.push(command);
  }
  return out;
}
