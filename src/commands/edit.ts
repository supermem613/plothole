import { readFileSync } from "node:fs";
import { editVerb } from "../core/verbs.js";
import { PlotholeError } from "../core/errors.js";
import { presentEdit } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// The old and new strings may be passed inline or read from a host file. File
// input exists for content that is awkward to quote on a command line, such as
// multi-line blocks. Inline and file forms are mutually exclusive per side so
// the source of the string is never ambiguous.
function resolveString(inline: string | undefined, file: string | undefined, label: string): string {
  if (inline !== undefined && file !== undefined) {
    throw new PlotholeError(
      `provide only one of --${label} or --${label}-file`,
      `Pass the ${label} string inline or from a file, not both.`,
    );
  }
  if (file !== undefined) {
    return readFileSync(file, "utf8");
  }
  return inline ?? "";
}

export async function editCommand(
  filePath: string,
  opts: { codespace?: string; cwd?: string; old?: string; new?: string; oldFile?: string; newFile?: string },
): Promise<void> {
  try {
    const oldString = resolveString(opts.old, opts.oldFile, "old");
    const newString = resolveString(opts.new, opts.newFile, "new");
    const result = await editVerb({ codespace: opts.codespace, cwd: opts.cwd, path: filePath, oldString, newString });
    emitSuccess("edit", presentEdit(result));
  } catch (err) {
    emitError("edit", err);
  }
}
