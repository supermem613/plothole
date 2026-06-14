import { readVerb } from "../core/verbs.js";
import { presentRead } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

export async function readCommand(
  filePath: string,
  opts: { codespace?: string; cwd?: string; start?: string; end?: string },
): Promise<void> {
  try {
    let range: { start: number; end?: number } | undefined;
    if (opts.start !== undefined) {
      range = { start: Number.parseInt(opts.start, 10) };
      if (opts.end !== undefined) {
        range.end = Number.parseInt(opts.end, 10);
      }
    }
    const result = await readVerb({ codespace: opts.codespace, cwd: opts.cwd, path: filePath, range });
    emitSuccess("read", presentRead(result));
  } catch (err) {
    emitError("read", err);
  }
}
