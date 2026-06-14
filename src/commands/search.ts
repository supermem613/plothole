import { searchVerb } from "../core/verbs.js";
import { presentSearch } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

export async function searchCommand(
  query: string,
  opts: {
    codespace?: string;
    cwd?: string;
    glob?: string;
    regex?: boolean;
    ignoreCase?: boolean;
    maxCount?: string;
    includeIgnored?: boolean;
    files?: boolean;
    count?: boolean;
    follow?: boolean;
  },
): Promise<void> {
  try {
    const mode = opts.files === true ? "files" : opts.count === true ? "count" : "content";
    const result = await searchVerb({
      codespace: opts.codespace,
      cwd: opts.cwd,
      query,
      search: {
        glob: opts.glob,
        regex: opts.regex,
        ignoreCase: opts.ignoreCase,
        maxCount: opts.maxCount === undefined ? undefined : Number.parseInt(opts.maxCount, 10),
        noIgnore: opts.includeIgnored,
        mode,
        follow: opts.follow,
      },
    });
    emitSuccess("search", presentSearch(result));
  } catch (err) {
    emitError("search", err);
  }
}
