import { envVerb } from "../core/verbs.js";
import { presentEnv } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

export async function envCommand(opts: { codespace?: string; cwd?: string }): Promise<void> {
  try {
    const result = await envVerb({ codespace: opts.codespace, cwd: opts.cwd });
    emitSuccess("env", presentEnv(result));
  } catch (err) {
    emitError("env", err);
  }
}
