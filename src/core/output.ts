import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { outputDir } from "./state.js";

// Build and test output is routinely megabytes. To keep agent context cheap,
// output over the inline limit is written to a temp file and only the path is
// returned, mirroring atrium's file-backed result contract.

export const INLINE_LIMIT = 16384;

// A deliberate file read is worth more inline budget than incidental build
// noise. A source file the agent asked for by path comes back inline up to this
// larger limit so a routine read does not force a second view round trip.
export const READ_INLINE_LIMIT = 65536;

export interface BackedOutput {
  inline?: string;
  file?: string;
  bytes: number;
  fileBacked?: boolean;
}

export function backIfLarge(text: string, label: string, limit: number = INLINE_LIMIT): BackedOutput {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) {
    return { inline: text, bytes };
  }
  const dir = outputDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);
  writeFileSync(file, text, "utf8");
  return { file, bytes, fileBacked: true };
}
