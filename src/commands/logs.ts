import { logsVerb } from "../core/verbs.js";
import { presentLogs } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// logs tails a backgrounded exec without collecting it, so a caller can watch a
// long build's progress and read its log markers, then decide to wait or kill.
export async function logsCommand(runId: string, opts: { codespace?: string; lines?: string }): Promise<void> {
  try {
    const lines = opts.lines === undefined ? undefined : Number.parseInt(opts.lines, 10);
    emitSuccess("logs", presentLogs(await logsVerb({ codespace: opts.codespace, runId, lines })));
  } catch (err) {
    emitError("logs", err);
  }
}
