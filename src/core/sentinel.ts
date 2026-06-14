import { shQuote } from "./shquote.js";

// `gh cs ssh` collapses every nonzero remote exit code into 1 and only leaks the
// real code in an unstructured stderr line. plothole recovers the true code by
// printing an in-band sentinel after the command and parsing it back out. This
// is the single most important transport invariant: without it exec cannot
// report whether a remote build or test actually passed.

export const RC_PREFIX = "__PLOTHOLE_RC__=";
export const RC_SUFFIX = "__PLOTHOLE_END__";

// `timeout` reports this code when it kills a command that outran its budget.
// Surfaced by the transport so a runaway sync verb fails loudly instead of
// hanging the host.
export const TIMEOUT_EXIT_CODE = 124;

export interface SentinelResult {
  exitCode: number | null;
  stdout: string;
  sentinelFound: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RC_PATTERN = new RegExp(`${escapeRegExp(RC_PREFIX)}(-?\\d+)${escapeRegExp(RC_SUFFIX)}`);

export interface WrapOptions {
  cwd?: string;
  timeoutSeconds?: number;
  detachStdin?: boolean;
}

export function wrapRemote(remoteCommand: string, options: WrapOptions = {}): string {
  const { cwd, timeoutSeconds, detachStdin = true } = options;
  const inner = cwd === undefined ? remoteCommand : `cd ${shQuote(cwd)} && ${remoteCommand}`;
  // Run the line through one inner login shell so a wall-clock cap and an stdin
  // detach cover the whole thing, pipes and && included. gh cs ssh starts a
  // non-login shell, which never sources the Codespaces profile that exports
  // GITHUB_USER, CODESPACE_NAME, auth tokens, and the codespace PATH additions.
  // A login shell reproduces the user's integrated terminal exactly, so a remote
  // build, deploy, or git/gh/npm call sees the same environment the user does.
  // The timeout makes a pathological command fail loudly at the budget with rc
  // 124 instead of hanging the host forever. The stdin detach stops a remote
  // tool (ripgrep handed no path is the one that bit us) from draining the ssh
  // channel and silently producing nothing. The detach is skipped only when the
  // caller pipes real stdin to the command.
  let exec = `bash -lc ${shQuote(inner)}`;
  if (timeoutSeconds !== undefined) {
    const budget = Math.max(1, Math.floor(timeoutSeconds));
    exec = `timeout -k 5 ${budget} ${exec}`;
  }
  if (detachStdin) {
    exec = `${exec} < /dev/null`;
  }
  return [
    exec,
    "__plothole_rc=$?",
    `printf '\\n${RC_PREFIX}%s${RC_SUFFIX}\\n' "$__plothole_rc"`,
  ].join("\n");
}

export function parseSentinel(raw: string): SentinelResult {
  const match = RC_PATTERN.exec(raw);
  if (match === null || match.index === undefined) {
    return { exitCode: null, stdout: raw, sentinelFound: false };
  }
  const exitCode = Number(match[1]);
  // Drop the one newline we injected immediately before the sentinel so the
  // caller sees exactly the bytes the remote command produced.
  const stdout = raw.slice(0, match.index).replace(/\n$/, "");
  return { exitCode, stdout, sentinelFound: true };
}
