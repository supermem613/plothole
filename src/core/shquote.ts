// POSIX shell quoting so host-built argv survives the remote bash that
// `gh cs ssh` hands the command to. The host side never invokes a shell
// (commands are spawned with an argv array), so the only quoting that matters
// is for the remote shell. This is the argv-safety guarantee plothole is built
// around: arbitrary code-bearing arguments must reach the codespace intact.

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shQuote(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (SAFE.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function shJoin(argv: string[]): string {
  return argv.map(shQuote).join(" ");
}
