---
name: plothole
description: |
  Use when the user wants to build, run, test, search, or edit INSIDE a GitHub Codespace from the host Copilot CLI (for example "build X in the codespace", "run the tests in my codespace", or any work targeting a named codespace). Routes that work to the plothole MCP tools instead of the host shell.
---

# plothole

Drive compile, run, test, and edit work INSIDE a GitHub Codespace from the host,
using the plothole MCP tools. The host agent keeps its own repos, knowledge, and
tooling; only the build, run, test, and edit work crosses into the codespace.

## When to use

- The user wants to build, run, test, search, or edit something in a Codespace
  and you are on the host.
- The user names a codespace, or says "in the codespace" or "against my
  codespace".

Do not use this for work on local host repositories. plothole only sees inside
the codespace.

## Interface: the plothole MCP tools

Prefer these over the host shell or a raw `gh cs ssh` call:

- `session` — list codespaces, set the active one, and set or clear its workspace
  root (`setRoot`/`clearRoot`). Set the root once so every verb is scoped to one
  repo.
- `env` — report the codespace toolchain and install state.
- `exec` — run a command inside the codespace. Pass `command` as a string to run
  a shell line (cd, &&, pipes, redirects, globs), or as an array of literal argv
  tokens. For a large or heavily quoted script, write it to a host file and pass
  `scriptFile` instead; it is read on the host and run verbatim (CRLF normalized),
  so nothing has to survive shell quoting. For a long-lived process (a dev server,
  a watch build) pass `readyWhen` (`tcp:PORT` or `log:REGEX`) to return a `ready`
  handle as soon as it is serving while it keeps running.
- `wait` — collect a backgrounded exec.
- `logs` — tail a backgrounded exec's stdout and stderr without collecting it, so
  you can watch progress and read its log markers, then decide to wait or kill.
- `runs` — list backgrounded execs the host is still tracking.
- `clean` — prune tracked runs that already finished; never touches a running exec.
- `kill` — stop a backgrounded exec and its subprocesses inside the codespace.
- `read` / `search` / `edit` — read a file, ripgrep, or exact-string edit, all
  inside the codespace. With a session root set, these are scoped to it: `search`
  is anchored at the repo and returns paths relative to it. `search` finds package
  source with no extra flag because source lives in real directories and rg
  descends a symlinked root on its own; pass `mode` (`files` or `count`) for
  paths-only or per-file counts. Do not pass `--follow` on a pnpm monorepo unless
  source is reachable only through a NESTED symlink; following the full link graph
  is very slow. Narrow `--cwd` to a smaller subdirectory to speed a search up; an
  absolute `--cwd` overrides the root, a relative one resolves under it. Each of
  these synchronous verbs runs under a fixed ~45s budget and fails loudly with an
  actionable hint instead of hanging; move legitimately long work to `exec`.
- `forward` — bridge a codespace TCP port to a host port so a HOST tool (a
  browser, kash, curl) can reach a codespace service. This is the one tool that
  acts on the host, not inside the codespace.
- `rush` — run rush from typed parts instead of a hand-built command, so a
  selector can never be dropped or the port mistyped. Pass `subcommand` (for
  example `start`, `build`, `test`) and the project closure as a `to` array of
  rush selectors (for example `["tag:X","@scope/Y"]`), plus an
  optional `port`. A watch subcommand (`start`, `build-watch`) is auto-gated on
  the watch ready marker and returns `{status:"ready", runId, port}` once it is
  serving; a run-to-completion subcommand returns `{status:"completed",
  exitCode}`. Either way the output is scanned for rushstack build `FAILURE`
  markers and any are surfaced as `failures`, so a watch that came up while a
  sub-build failed is never read as healthy. For a watch with a `port`, the ready
  result also asserts the served scenario actually deployed: it fetches the
  landing page and reads the `spfxDebugQueryString` slot, where a real `?debug=...`
  string means deployed and the literal `(Not Deployed)` means the closure failed
  to deploy. A `(Not Deployed)` watch comes back `{deploy:{deployed:false}}` and
  fails the verb's exit code, so an unusable dev server is never handed to a
  browser or curl. A watch can pass its `FAILURE` scan and still be
  `(Not Deployed)`, so this gate runs on every ready watch automatically, on both
  the inline-ready path and a later `wait` that resumes a backgrounded build.
  Prefer this over a raw `exec` of a rush command for any rush dev loop.

## Execution sequence

1. Set the target first. Call `session` to list codespaces, then `session` with
   `ensure: <name>` to make it active, or pass `codespace` on each call. Every
   other tool fails with an actionable hint when no codespace is selected. Set the
   workspace root in the same step with `setRoot: <dir>` (for example
   `/workspaces/web`) so every verb is scoped to the repo and stray walks of
   the login tree are impossible.
2. Run the work through the tools above. Keep codespace builds and tests off the
   host shell.
3. Handle async exec. `exec` returns `{status:"completed", exitCode, stdout,
   stderr}`, `{status:"running", runId, runDir}`, or, when `readyWhen` is set,
   `{status:"ready", runId, runDir, stdout}`. A command that outlives the fixed
   ~45s budget returns a running handle. On a running result, call `wait` with
   that `runId` and repeat until it completes, or `logs <runId>` to tail it
   without collecting. On a ready result the process is still running: tail it
   with `logs`, collect its eventual result with `wait`, or stop it with `kill`.
   Use `runs` to recover a lost `runId`, `clean` to prune runs that finished but
   were never waited on, and `kill <runId>` to stop a runaway exec.
4. Reach a codespace service from the host. For a rush dev loop prefer the `rush`
   tool: it builds the closure, auto-gates a watch subcommand on its ready marker,
   scans for build failures, and for a watch with a `port` asserts the scenario
   actually deployed in the same ready result. Otherwise gate the start with
   `exec readyWhen:"tcp:PORT"` (or `log:'Waiting for changes'`). A ready `rush
   start` carries its deploy state: a watch can be ready and still `(Not
   Deployed)`, in which case `deploy.deployed` is false and the verb exits
   nonzero, so check it before handing the port off. When it is deployed, `forward
   PORT` bridges it to the host. `forward --list` and `forward --stop PORT` manage
   active forwards.
5. Respect the boundary. The codespace tools operate INSIDE the codespace; host
   files and processes are not visible there. Do not mix host paths with codespace
   paths. `forward` is the exception: it runs on the host to bridge a port.

## Setup problems

Run `plothole doctor` (the CLI, on the host) to check the gh account and scope,
codespace reachability, and the toolchain. The CLI exposes the same verbs for
hand-debugging, for example `plothole exec -- rush build` or
`plothole wait <runId>`. The CLI `exec` and `rush` verbs are synchronous by
default: they block until the command finishes and exit with its real code, with
a `--ready-when` dev server returning once it is serving. Pass `--background`
(`-b`) for the fire-and-poll handle behavior the MCP tools always use.
