import { runsVerb } from "../core/verbs.js";
import { presentRuns } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// runs lists the backgrounded execs the host is still tracking so a caller can
// recover a runId to wait on after losing the original exec response.
export function runsCommand(): void {
  try {
    emitSuccess("runs", presentRuns(runsVerb()));
  } catch (err) {
    emitError("runs", err);
  }
}
