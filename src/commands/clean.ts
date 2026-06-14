import { cleanVerb } from "../core/verbs.js";
import { presentClean } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// clean prunes tracked runs that already finished or vanished so `runs` does not
// accumulate stale entries that were started but never waited on. A still-running
// exec is never touched, so cleanup cannot kill a live build.
export async function cleanCommand(): Promise<void> {
  try {
    emitSuccess("clean", presentClean(await cleanVerb()));
  } catch (err) {
    emitError("clean", err);
  }
}
