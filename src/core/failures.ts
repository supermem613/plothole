// Pure scan for build failures in a backgrounded run's captured output. The
// markers come from rushstack's OperationResultSummarizerPlugin, which is
// generic to every Rush and Heft monorepo, not specific to one repo: a failed
// run prints a summary banner "==[ FAILURE: N operations ]==" and one detail
// header "--[ FAILURE: <name> ]--" per failed operation. Surfacing these keeps a
// long run that reached ready or done while a sub-build failed from looking
// healthy, which is the difference between a real green build and a silent one.

export interface FailureScan {
  // Total failed operations, taken from the summary banner when present and
  // otherwise inferred from the number of detail headers found.
  operations: number;
  // The failed operation names, e.g. "@scope/foo (_phase_build)".
  failed: string[];
}

// Rush may color the banners when it detects a color-capable terminal, so strip
// SGR escape codes before matching. Output redirected to a file is usually
// already plain, but a forced-color or pseudo-tty run is not. The escape byte is
// built at runtime so the source carries no literal control character.
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// "==[ FAILURE: 2 operations ]====..." The padding after the bracket varies, so
// the match ends at the closing bracket.
const SUMMARY = /==\[\s*FAILURE:\s*(\d+)\s+operations?\s*\]/i;

// "--[ FAILURE: @scope/foo (_phase_build) ]----[ 1.23 seconds ]--" The operation
// name is everything between the status and the first closing bracket.
const DETAIL = /--\[\s*FAILURE:\s*(.+?)\s*\]-/gi;

// Either operation-results summary banner, success or failure. A watch keeps one
// growing log across every incremental build, so the last banner marks the start
// of the current build epoch. Scanning only that epoch is what stops a single
// failed incremental build from poisoning every later wait after a clean rebuild.
const ANY_SUMMARY = /==\[\s*(?:SUCCESS|FAILURE):\s*\d+\s+operations?\s*\]/gi;

export function scanFailures(text: string): FailureScan | undefined {
  const clean = text.replace(ANSI_SGR, "");
  // Restrict the scan to the latest build epoch: the slice from the last summary
  // banner onward. With no banner at all, e.g. a truncated tail that kept only
  // detail headers, fall back to the whole text so a stray failure still counts.
  let epoch = clean;
  let lastSummary: RegExpExecArray | null = null;
  let banner: RegExpExecArray | null;
  ANY_SUMMARY.lastIndex = 0;
  while ((banner = ANY_SUMMARY.exec(clean)) !== null) {
    lastSummary = banner;
  }
  if (lastSummary !== null) {
    epoch = clean.slice(lastSummary.index);
  }
  const failed: string[] = [];
  let match: RegExpExecArray | null;
  DETAIL.lastIndex = 0;
  while ((match = DETAIL.exec(epoch)) !== null) {
    failed.push(match[1].trim());
  }
  const summary = SUMMARY.exec(epoch);
  if (summary === null && failed.length === 0) {
    return undefined;
  }
  const operations = summary !== null ? Number(summary[1]) : failed.length;
  return { operations, failed };
}
