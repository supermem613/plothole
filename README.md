# plothole

> Drive compile, run, test, and edit inside a GitHub Codespace from the host Copilot CLI

plothole is a stdio MCP server with a small companion CLI for configuration,
schema discovery, local debugging, and updates.

## Quick start

```bash
git clone https://github.com/<you>/plothole.git ~/repos/plothole
cd ~/repos/plothole
npm install
npm run build
npm link
```

## Register with Copilot CLI

Emit the server block and merge it into `~/.copilot/mcp-config.json`, then
restart the CLI:

```bash
plothole mcp-config
```

`mcp-config` assumes `plothole` is on your PATH from `npm link`. To register
without linking, point `command` at the built server directly:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/plothole/dist/server.js"],
  "tools": ["*"]
}
```

## Commands

```bash
plothole --help
plothole doctor --json
plothole schema
plothole mcp-config
plothole mcp-server
plothole mcp-schema
plothole mcp-call session
plothole update --json
```

Codespace verbs, hand-runnable for debugging (each is also an MCP tool):

```bash
plothole session --ensure <codespace-name>   # set the active codespace first
plothole session --set-root /workspaces/app   # scope every verb to one repo root
plothole env
plothole exec -- rush build                   # returns a runId if it runs long
plothole exec -- 'cd src && rush build | tee log'   # a quoted single arg runs as a shell line
plothole exec --script-file ./build.sh        # run a host script file (best for gnarly scripts)
plothole exec --ready-when log:'Waiting for changes' -- rush start   # return once a dev server is serving
plothole wait <runId>                         # collect a backgrounded exec
plothole logs <runId> --lines 80              # tail a backgrounded exec without collecting it
plothole runs                                 # list backgrounded execs still tracked
plothole clean                                # prune finished runs the host still tracks
plothole kill <runId>                         # stop a runaway backgrounded exec
plothole read package.json --start 1 --end 40
plothole search "function main" --regex --glob 'src/**'
plothole search FabIcon --files               # list only matching paths (or --count for per-file counts)
plothole edit src/app.ts --old 'foo' --new 'bar'
plothole search FabIcon --files --cwd packages/app   # scope this verb under the root (or an absolute path to override it)
plothole forward 35565                        # bridge a codespace port to the host for a browser or curl
plothole rush start --to tag:web-app --to @scope/app --port 46435   # drive rush from typed parts; a ready watch also asserts it actually deployed
```

Pass `--codespace <name>` (alias `--cs`) to any verb to target a codespace other
than the active one.

## Scoping work to a workspace root

A codespace clones several repos under `/workspaces`, and a bare login shell
lands in `/home/vscode`, so an unscoped verb can wander the whole container. Set
a root once with `session --set-root <dir>` (it verifies the directory exists
before persisting) and `exec`, `read`, `search`, `edit`, and `env` default their
working directory to it: a bare `search` is anchored at the repo, returns paths
relative to it, and avoids the symlinked login tree. The root is persisted per
codespace in the host state file, never hardcoded, so the tool stays generic. An
absolute `--cwd` on a verb overrides the root; a relative `--cwd` resolves under
it. Clear the scope with `session --clear-root` to fall back to the bare login
directory.

Every synchronous verb (`read`, `search`, `edit`, `env`) runs under a fixed
45-second wall-clock budget and detaches its stdin, so a pathological command
fails loudly with an actionable error instead of hanging the host or silently
returning nothing. The budget sits under the MCP client deadline so plothole's
own error surfaces rather than an opaque client timeout. For work that is
legitimately long, use `exec`, which backgrounds past the budget and returns a
`runId`.

`exec` takes a terminal line, not an argv vector. A single quoted argument runs
as a shell line, so `cd`, `&&`, pipes, redirects, and globs work as typed;
multiple bare arguments are treated as literal argv and shell-quoted token by
token. The MCP `exec` tool mirrors this: pass `command` as a string for a shell
line, or as an array for literal argv.

For a large or heavily quoted script, write it to a host file and pass
`--script-file <path>` (CLI) or `scriptFile` (MCP) instead of `command`. plothole
reads the file on the host and runs its contents verbatim, so nothing has to
survive the host shell that launched plothole. Line endings are normalized to LF,
so a Windows CRLF script file runs cleanly. `command` and the script file are
mutually exclusive.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `exec` | Run a command inside the codespace; returns its real exit code, stdout, and stderr, a `runId` if it runs long, or a `ready` handle when `readyWhen` is set |
| `wait` | Collect a backgrounded exec by its `runId` |
| `logs` | Tail a backgrounded exec's stdout and stderr without collecting it |
| `runs` | List backgrounded execs the host is still tracking |
| `clean` | Prune tracked runs that already finished; never touches a still-running exec |
| `kill` | Stop a backgrounded exec and its subprocesses inside the codespace |
| `read` | Read a file inside the codespace, optionally a line range |
| `search` | Search file contents inside the codespace with ripgrep (`mode` for files/count; `--follow` to chase nested symlinks, off by default) |
| `edit` | Replace an exact string in a file inside the codespace |
| `session` | Ensure or inspect the warm codespace session, the active codespace, and its workspace root (`setRoot`/`clearRoot`) |
| `env` | Describe the codespace toolchain and install state |
| `forward` | Bridge a codespace TCP port to the host so host tools can reach a codespace service |
| `rush` | Run rush from typed parts (`subcommand` + a `to` selector array, optional `port`); auto-gates watch subcommands on the ready marker, scans the output for rushstack build `FAILURE` markers, and for a watch with a `port` asserts the served scenario actually deployed by reading the landing page's `spfxDebugQueryString` slot, failing a `(Not Deployed)` scenario so an unusable dev server is never handed to a browser or curl |

Every tool operates inside the active codespace, except `forward`, which runs on
the host to bridge a codespace port to a host port. The CLI and MCP faces share
the verbs in `src/core/verbs.ts`, so the two surfaces cannot drift.

## Backgrounding long commands

The MCP client abandons a tool call after roughly 60 seconds, so `exec` never
blocks on a long build. Every command is launched detached inside the codespace
and polled for up to a fixed 45-second budget, which sits under that timeout
with headroom for the ssh round trip and base64 transfer. A command that
finishes in time returns `{ "status": "completed", "exitCode", "stdout",
"stderr", "runId" }`. One that is still running returns `{ "status": "running",
"runId" }`; call `wait` with that `runId` to collect it once it finishes (call
`wait` again if it is still going), and `runs` to recover a `runId` you lost. Run
`logs <runId>` to tail a running exec's stdout and stderr without collecting it,
so you can watch a long build's progress and read its log markers, then decide to
wait or kill. The real exit code is recovered even though `gh cs ssh` collapses
nonzero codes. Run `clean` to prune tracked runs that already finished but were
never waited on; it leaves a still-running exec untouched. Run `kill <runId>` to
stop a runaway exec and its subprocesses.

A transient `gh cs ssh` channel drop (for example "error reading server preface"
or "use of closed network connection") is retried automatically a few times, so a
single connection blip does not abort a build. The retry only fires when the
remote produced no output, so a command that ran and failed is never re-executed.

## Readiness gating for long-lived processes

A dev server or watch build never exits, so neither `completed` nor a blind
timeout describes it well. Pass `--ready-when` (CLI) or `readyWhen` (MCP) to make
`exec` return as soon as the process is actually serving while it keeps running:

- `tcp:PORT` returns once something is listening on that port in the codespace.
- `log:REGEX` returns once the pattern appears in the process's stdout, for
  example `log:'Waiting for changes'` for a rush watch build.

A ready exec returns `{ "status": "ready", "runId", "runDir", "stdout" }` with a
snapshot of stdout so far. The process stays alive; tail it with `logs`, collect
its eventual result with `wait`, or stop it with `kill`. If the process exits
before the condition holds (a build that errored out), `exec` returns `completed`
with the real exit code instead.

## Port forwarding to the host

`forward <port>` bridges a codespace TCP port to a host port so a host tool, a
browser or curl, can reach a service running in the codespace. It spawns a
detached `gh codespace ports forward` and reports whether the host port came up:

```bash
plothole exec --ready-when tcp:35565 -- 'cd /workspaces/app && rush start'
plothole forward 35565            # host:35565 now reaches the codespace dev server
plothole forward --list           # show active forwards and whether each is alive
plothole forward --stop 35565     # tear the forward down
```

`forward` is the one verb that acts on the host rather than inside the codespace.
Pair it with `exec --ready-when` so you forward only once the codespace service is
serving.

## Conventions

- **Stdio discipline.** Do not write logs or banners to stdout from server code.
  The MCP protocol owns stdout.
- **Compact JSON text results.** Tool handlers return `content[0].text` as a
  JSON string with only the fields the next agent needs.
- **Registry first.** `src/registry.ts` drives `plothole schema`, docs, and
  parity tests.
- **SDK dependency is intentional.** `@modelcontextprotocol/sdk` is the only
  extra runtime dependency over the standard `create-repo` baseline.

## Development

```bash
npm run build
npm run lint
npm test
npm run clean
```

## End-to-end testing

`npm test` is hermetic and never contacts a codespace. The end-to-end suite
drives the built CLI against a real codespace to prove the transport,
exit-code recovery, output file-backing, and the MCP round-trip actually work.

```bash
npm run e2e        # verbose live run, the primary validation
npm run test:e2e   # the same flow under the node:test wrapper
```

Both paths probe for a built CLI and a reachable codespace first and skip
cleanly when none is available, so CI stays green. A live run needs a gh
account with the `codespace` scope:

```bash
gh auth status            # confirm the active account has 'codespace'
gh auth switch -u <user>  # switch accounts if needed
```

## Project structure

```
src/
  cli.ts          # CLI face: argv -> core verbs
  server.ts       # MCP face: tool JSON -> core verbs
  registry.ts     # command catalog (schema, docs, parity tests)
  present.ts      # shared result shaping for both faces
  core/           # pure builders + impure gh/transport/state
  mcp/
    format.ts
  commands/
test/
  unit/
  e2e/            # gated live harness + node:test wrapper
```

## License

MIT
