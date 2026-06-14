import { sessionVerb } from "../core/verbs.js";
import { emitError, emitSuccess } from "./emit.js";

// --ensure verifies the codespace exists before persisting it as active, so a
// typo fails here instead of surfacing as a confusing connection error on the
// next verb. --set-root scopes every verb in the codespace to a directory after
// checking it exists there. With no flag, session reports the current selection,
// its root, and the full list of visible codespaces for discovery.
export async function sessionCommand(opts: {
  ensure?: string;
  codespace?: string;
  setRoot?: string;
  clearRoot?: boolean;
}): Promise<void> {
  try {
    const result = await sessionVerb({
      ensure: opts.ensure,
      codespace: opts.codespace,
      setRoot: opts.setRoot,
      clearRoot: opts.clearRoot,
    });
    emitSuccess("session", result);
  } catch (err) {
    emitError("session", err);
  }
}
