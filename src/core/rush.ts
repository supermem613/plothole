import { PlotholeError } from "./errors.js";

// A rush invocation described in typed parts instead of a hand-typed string, so
// the host agent cannot drop a selector, forget the port, or mistype the
// ready-marker. rush is generic and OSS, so this stays free of any application
// specifics: the caller supplies the project closure as --to selectors.
export interface RushSpec {
  subcommand: string;
  to: string[];
  port?: number;
  extra?: string[];
}

// Pure: assemble the full rush argv from a spec. The closure is deduplicated
// while preserving first-seen order so a repeated --to never changes the build
// set or the command's meaning. An empty closure is rejected because a bare
// `rush start` builds the entire monorepo, which is never what the dev loop
// wants and is the slow accidental path this verb exists to prevent.
export function buildRushArgs(spec: RushSpec): string[] {
  const subcommand = spec.subcommand.trim();
  if (subcommand.length === 0) {
    throw new PlotholeError(
      "rush requires a subcommand",
      "Pass a rush subcommand such as start, build, or test.",
    );
  }
  const selectors = [...new Set(spec.to.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (selectors.length === 0) {
    throw new PlotholeError(
      "rush requires at least one --to selector",
      "Pass the project closure with --to, e.g. --to tag:web-app. A bare rush builds the whole monorepo.",
    );
  }
  const argv = ["rush", subcommand];
  for (const selector of selectors) {
    argv.push("--to", selector);
  }
  if (spec.port !== undefined) {
    if (rushReadyWhen(subcommand) === undefined) {
      throw new PlotholeError(
        `rush ${subcommand} takes no --port`,
        "Pass --port only with a watch subcommand such as start or build-watch; a run-to-completion subcommand serves no port.",
      );
    }
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      throw new PlotholeError(
        `invalid rush --port: ${spec.port}`,
        "Pass a port in the range 1 to 65535.",
      );
    }
    argv.push("--port", String(spec.port));
  }
  if (spec.extra !== undefined) {
    argv.push(...spec.extra);
  }
  return argv;
}

// Pure: the readiness marker for a rush subcommand, or undefined for a
// run-to-completion subcommand. Watch subcommands keep serving after the first
// build, so they need a --ready-when log marker to report ready instead of
// blocking; once subcommands exit on their own and need no gate.
export function rushReadyWhen(subcommand: string): string | undefined {
  const watch = new Set(["start", "build-watch"]);
  return watch.has(subcommand.trim()) ? "log:Waiting for changes" : undefined;
}
