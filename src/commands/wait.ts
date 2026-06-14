import { waitVerb, execExitCode } from "../core/verbs.js";
import { presentExec } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// wait collects a backgrounded exec. It exits with the command's real exit code
// once completed so scripts and agents can branch on success exactly as they
// would for a synchronous run; a still-running result exits 0 with a runId. A
// resumed run that came up ready or exited 0 while a sub-build failed exits
// nonzero so the failure is not lost on the resume path.
export async function waitCommand(runId: string, opts: { codespace?: string }): Promise<void> {
  try {
    const result = await waitVerb({ codespace: opts.codespace, runId });
    emitSuccess("wait", presentExec(result));
    process.exit(execExitCode(result));
  } catch (err) {
    emitError("wait", err);
  }
}
