import { execVerb, execToCompletionVerb, execExitCode } from "../core/verbs.js";
import { presentExec } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// exec mirrors running the command yourself: it emits the result envelope and
// then exits with the command's real remote exit code, so scripts and agents
// can branch on success the same way they would for a local command. By default
// it is synchronous, blocking until the command finishes the same as a local
// run; a --ready-when dev server is terminal once it is serving, so it returns
// while the process keeps running. Pass --background to get the old fire-and-poll
// behavior: a long command returns status "running" with a runId to wait on and
// the process exits 0. A run that came up ready or exited 0 while a sub-build
// failed exits nonzero so a partial failure is never read as success.
export async function execCommand(
  tokens: string[],
  opts: { codespace?: string; cwd?: string; scriptFile?: string; readyWhen?: string; background?: boolean },
): Promise<void> {
  try {
    // A single token is a shell line the caller already quoted as one unit, so it
    // runs verbatim (cd, &&, pipes, redirects). Multiple tokens are literal argv.
    // With no tokens the command must come from --script-file, resolved in the verb.
    const command = tokens.length === 0 ? undefined : tokens.length === 1 ? tokens[0] : tokens;
    const verbOptions = {
      codespace: opts.codespace,
      cwd: opts.cwd,
      command,
      scriptFile: opts.scriptFile,
      readyWhen: opts.readyWhen,
    };
    const result = opts.background ? await execVerb(verbOptions) : await execToCompletionVerb(verbOptions);
    emitSuccess("exec", presentExec(result));
    process.exit(execExitCode(result));
  } catch (err) {
    emitError("exec", err);
  }
}
