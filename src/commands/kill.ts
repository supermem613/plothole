import { killVerb } from "../core/verbs.js";
import { presentKill } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// kill stops a backgrounded exec and its subprocesses inside the codespace, then
// drops the host run record. Use it to cancel a runaway build; clean only prunes
// records for runs that already finished and never signals a live process.
export async function killCommand(runId: string, opts: { codespace?: string }): Promise<void> {
  try {
    emitSuccess("kill", presentKill(await killVerb({ codespace: opts.codespace, runId })));
  } catch (err) {
    emitError("kill", err);
  }
}
