import { PlotholeError } from "../core/errors.js";

// The CLI's machine-readable contract: success data on stdout, errors on stderr
// with an actionable hint, matching the schema's documented envelope. Both are
// single-line JSON so a caller can parse a command's result without buffering
// multi-line output.

export function emitSuccess(command: string, data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, command, data })}\n`);
}

export function emitError(command: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof PlotholeError ? err.hint : undefined;
  process.stderr.write(`${JSON.stringify({ ok: false, command, error: message, hint })}\n`);
  process.exit(1);
}
