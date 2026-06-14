import { rushVerb, rushExitCode } from "../core/verbs.js";
import { presentRush } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// rush drives the codespace dev loop from typed parts so a selector can't be
// dropped or the port mistyped on the way to a hand-built rush command. It exits
// with the run's real exit code, and also fails when the run surfaced build
// failures even though rush exited 0 or the watch only came up ready, so a
// failed sub-build is never read as success by a script.
export async function rushCommand(
  subcommand: string,
  opts: { to?: string[]; port?: string; extra?: string[]; cwd?: string; codespace?: string },
): Promise<void> {
  try {
    const result = await rushVerb({
      codespace: opts.codespace,
      cwd: opts.cwd,
      subcommand,
      to: opts.to ?? [],
      port: opts.port === undefined ? undefined : Number(opts.port),
      extra: opts.extra,
    });
    emitSuccess("rush", presentRush(result));
    process.exit(rushExitCode(result));
  } catch (err) {
    emitError("rush", err);
  }
}
