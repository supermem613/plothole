import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Live end-to-end harness, in the shape of a local-smoke harness: the real
// flow lives here as exported probe functions so it can be hand-run verbosely
// (`npm run e2e`) and also driven from a thin node:test wrapper. Every step goes
// through the BUILT CLI (dist/cli.js) so the test exercises the exact binary an
// agent uses, including commander parsing, the JSON envelope, and exit codes. A
// real codespace is required, so the suite is gated by probePrerequisites and
// skipped when none is reachable.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "dist", "cli.js");

export interface Logger {
  log: (message: string) => void;
}

interface Envelope {
  ok: boolean;
  command?: string;
  data?: Record<string, unknown>;
  error?: string;
  hint?: string;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  envelope: Envelope;
}

function parseEnvelope(stdout: string, stderr: string): Envelope {
  const source = stdout.trim().length > 0 ? stdout : stderr;
  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last) as Envelope;
  } catch {
    return { ok: false, error: `unparseable output: ${source.slice(0, 200)}` };
  }
}

export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr, envelope: parseEnvelope(stdout, stderr) });
    });
  });
}

function fieldText(field: unknown): string {
  if (typeof field === "string") {
    return field;
  }
  if (field !== null && typeof field === "object" && "file" in field) {
    return `[file-backed: ${(field as { file?: string }).file ?? ""}]`;
  }
  return "";
}

// The MCP face wraps the verb envelope inside a CallToolResult text part, so the
// real verb result is one JSON layer deeper than the CLI envelope.
function readToolEnvelope(data: Record<string, unknown> | undefined): Envelope {
  const content = (data?.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((part) => part.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return { ok: false, error: `unparseable tool result: ${text.slice(0, 200)}` };
  }
}

export interface Prerequisites {
  ready: boolean;
  reason?: string;
  codespace?: string;
}

export async function probePrerequisites(): Promise<Prerequisites> {
  if (!existsSync(CLI)) {
    return { ready: false, reason: `built CLI not found at ${CLI}; run \`npm run build\` first` };
  }
  const session = await runCli(["session"]);
  if (session.envelope.ok !== true) {
    return { ready: false, reason: session.envelope.hint ?? session.envelope.error ?? "gh could not list codespaces" };
  }
  const data = session.envelope.data ?? {};
  const codespaces = Array.isArray(data.codespaces)
    ? (data.codespaces as Array<{ name: string; state: string }>)
    : [];
  if (codespaces.length === 0) {
    return {
      ready: false,
      reason: "no codespaces visible to the active gh account; run `gh auth switch -u <account-with-codespace-scope>`",
    };
  }
  const active = typeof data.active === "string" ? data.active : undefined;
  const preferred =
    codespaces.find((codespace) => codespace.name === active) ??
    codespaces.find((codespace) => /available|running/i.test(codespace.state)) ??
    codespaces[0];
  return { ready: true, codespace: preferred.name };
}

export async function runLiveSmoke(target: { codespace: string }, logger: Logger): Promise<void> {
  const { codespace } = target;
  const scratch = `/tmp/plothole-e2e-${randomBytes(4).toString("hex")}`;
  const sample = `${scratch}/sample.txt`;
  const step = (message: string): void => logger.log(message);

  try {
    step(`session --ensure ${codespace}`);
    const ensure = await runCli(["session", "--ensure", codespace]);
    assert.equal(ensure.envelope.ok, true, `session --ensure failed: ${ensure.stderr}`);
    assert.equal(ensure.envelope.data?.active, codespace);

    step("session reports the active codespace");
    const status = await runCli(["session"]);
    assert.equal(status.envelope.data?.active, codespace);

    step("env reports the toolchain");
    const env = await runCli(["env"]);
    assert.equal(env.envelope.ok, true, `env failed: ${env.stderr}`);
    const info = (env.envelope.data?.info ?? {}) as Record<string, string>;
    assert.ok((info.node ?? "").length > 0, `expected a node version, got ${JSON.stringify(info)}`);

    step("exec returns stdout and exit code 0");
    const echo = await runCli(["exec", "--", "echo", "hello-plothole"]);
    assert.equal(echo.envelope.ok, true, `exec echo failed: ${echo.stderr}`);
    assert.equal(echo.envelope.data?.status, "completed", "a fast command should complete inline");
    assert.equal(echo.envelope.data?.exitCode, 0);
    assert.match(fieldText(echo.envelope.data?.stdout), /hello-plothole/);

    step("exec runs a single-argument string as a shell line (&&, pipe)");
    const shellLine = await runCli(["exec", "--", "echo one && echo two | tr a-z A-Z"]);
    assert.equal(shellLine.envelope.ok, true, `shell-line exec failed: ${shellLine.stderr}`);
    assert.equal(shellLine.envelope.data?.exitCode, 0);
    assert.match(fieldText(shellLine.envelope.data?.stdout), /one[\s\S]*TWO/);

    step("exec propagates a non-zero remote exit code (sentinel)");
    const fail = await runCli(["exec", "--", "bash", "-c", "exit 7"]);
    assert.equal(fail.envelope.data?.exitCode, 7, "remote exit code 7 was not recovered");
    assert.equal(fail.code, 7, "CLI did not exit with the remote exit code");

    step("exec file-backs large output");
    const big = await runCli(["exec", "--", "bash", "-c", "head -c 20000 /dev/zero | tr '\\0' x"]);
    const stdoutField = big.envelope.data?.stdout as { file?: string; bytes?: number } | string;
    assert.ok(
      typeof stdoutField === "object" && stdoutField.file !== undefined,
      "large stdout was not file-backed",
    );
    assert.ok((stdoutField.bytes ?? 0) > 16384, `expected >16384 bytes, got ${JSON.stringify(stdoutField)}`);
    assert.ok(existsSync(stdoutField.file as string), "file-backed output path does not exist on the host");

    step("exec backgrounds a command that outlives the 45s budget; wait collects it");
    // The budget is hardcoded, so the only way to force a running handle is a
    // command that genuinely outlives it. A sentinel-file gate makes that
    // deterministic instead of racing the budget against a fixed sleep: the
    // command blocks until the harness drops the gate file, so it is certainly
    // still running when exec's 45s budget elapses.
    const gate = `${scratch}/gate`;
    await runCli(["exec", "--", "bash", "-c", `mkdir -p ${scratch}`]);
    const bg = await runCli(["exec", "--", "bash", "-c", `until [ -f ${gate} ]; do sleep 1; done; echo woke-up`]);
    assert.equal(bg.envelope.ok, true, `backgrounded exec failed: ${bg.stderr}`);
    assert.equal(bg.envelope.data?.status, "running", `expected a running handle, got ${JSON.stringify(bg.envelope.data)}`);
    assert.equal(bg.code, 0, "a backgrounded exec should exit 0");
    const runId = bg.envelope.data?.runId;
    assert.ok(typeof runId === "string" && runId.length > 0, "running exec did not return a runId");

    step("runs lists the backgrounded run");
    const runs = await runCli(["runs"]);
    assert.equal(runs.envelope.ok, true, `runs failed: ${runs.stderr}`);
    const tracked = (runs.envelope.data?.runs ?? []) as Array<{ runId: string }>;
    assert.ok(tracked.some((entry) => entry.runId === runId), "runs did not list the backgrounded run");

    step("clean keeps a still-running backgrounded run");
    const cleanRunning = await runCli(["clean"]);
    assert.equal(cleanRunning.envelope.ok, true, `clean failed: ${cleanRunning.stderr}`);
    const cleaned = (cleanRunning.envelope.data?.cleaned ?? []) as Array<{ runId: string; disposition: string }>;
    assert.ok(
      cleaned.some((entry) => entry.runId === runId && entry.disposition === "running"),
      "clean should keep a still-running run, not remove it",
    );
    const afterClean = await runCli(["runs"]);
    assert.ok(
      ((afterClean.envelope.data?.runs ?? []) as Array<{ runId: string }>).some((entry) => entry.runId === runId),
      "clean must not drop a still-running run from the registry",
    );

    step("release the gate so the backgrounded command can finish");
    const release = await runCli(["exec", "--", "bash", "-c", `touch ${gate}`]);
    assert.equal(release.envelope.data?.exitCode, 0, `gate release failed: ${release.stderr}`);

    step("wait collects the completed backgrounded run with its real output and exit code");
    const waited = await runCli(["wait", runId as string]);
    assert.equal(waited.envelope.ok, true, `wait failed: ${waited.stderr}`);
    assert.equal(waited.envelope.data?.status, "completed", `expected completed, got ${JSON.stringify(waited.envelope.data)}`);
    assert.equal(waited.envelope.data?.exitCode, 0);
    assert.match(fieldText(waited.envelope.data?.stdout), /woke-up/);

    step("wait on an unknown run reports no active run");
    const ghost = await runCli(["wait", "00000000-0000-0000-0000-000000000000"]);
    assert.equal(ghost.envelope.ok, false, "wait on an unknown run should fail");

    step("exec backgrounds a long sleep so kill has a live process to stop");
    const killable = await runCli(["exec", "--", "bash", "-c", "sleep 600"]);
    assert.equal(killable.envelope.ok, true, `backgrounded sleep failed: ${killable.stderr}`);
    assert.equal(
      killable.envelope.data?.status,
      "running",
      `expected a running handle, got ${JSON.stringify(killable.envelope.data)}`,
    );
    const killId = killable.envelope.data?.runId;
    assert.ok(typeof killId === "string" && killId.length > 0, "backgrounded sleep did not return a runId");

    step("kill stops the backgrounded run");
    const killed = await runCli(["kill", killId as string]);
    assert.equal(killed.envelope.ok, true, `kill failed: ${killed.stderr}`);
    assert.equal(killed.envelope.data?.status, "killed", `expected killed, got ${JSON.stringify(killed.envelope.data)}`);

    step("a killed run is gone from runs and wait reports it missing");
    const afterKillRuns = await runCli(["runs"]);
    assert.ok(
      !((afterKillRuns.envelope.data?.runs ?? []) as Array<{ runId: string }>).some((entry) => entry.runId === killId),
      "kill must drop the run from the host registry",
    );
    const afterKillWait = await runCli(["wait", killId as string]);
    assert.equal(afterKillWait.envelope.ok, false, "wait on a killed run should report no active run");

    step(`create scratch files under ${scratch}`);
    const make = await runCli([
      "exec",
      "--",
      "bash",
      "-c",
      `mkdir -p ${scratch} && printf 'alpha\\nbeta\\ngamma\\n' > ${sample}`,
    ]);
    assert.equal(make.envelope.data?.exitCode, 0, `scratch setup failed: ${make.stderr}`);

    step("read returns file content");
    const read = await runCli(["read", sample]);
    assert.equal(read.envelope.ok, true, `read failed: ${read.stderr}`);
    assert.match(fieldText(read.envelope.data?.content), /alpha[\s\S]*beta[\s\S]*gamma/);

    step("read honors a line range");
    const ranged = await runCli(["read", sample, "--start", "2", "--end", "2"]);
    assert.equal(fieldText(ranged.envelope.data?.content).trim(), "beta");

    step("search finds a match with ripgrep");
    const search = await runCli(["search", "beta", "--cwd", scratch]);
    assert.equal(search.envelope.ok, true, `search failed: ${search.stderr}`);
    assert.equal(search.envelope.data?.matched, true);
    assert.match(fieldText(search.envelope.data?.output), /beta/);

    step("edit replaces an exact string once");
    const edit = await runCli(["edit", sample, "--old", "beta", "--new", "BETA"]);
    assert.equal(edit.envelope.ok, true, `edit failed: ${edit.stderr}`);
    assert.equal(edit.envelope.data?.replaced, 1);
    const reread = await runCli(["read", sample, "--start", "2", "--end", "2"]);
    assert.equal(fieldText(reread.envelope.data?.content).trim(), "BETA");

    step("edit refuses a non-unique old string");
    const mismatch = await runCli(["edit", sample, "--old", "no-such-text", "--new", "x"]);
    assert.equal(mismatch.envelope.ok, false, "edit should fail when the old string is absent");
    assert.equal(mismatch.code, 1);

    step("mcp-call exec round-trips through the MCP face");
    const mcp = await runCli(["mcp-call", "exec", JSON.stringify({ command: ["echo", "mcp-ok"] })]);
    assert.equal(mcp.envelope.ok, true, `mcp-call failed: ${mcp.stderr}`);
    const inner = readToolEnvelope(mcp.envelope.data);
    assert.equal(inner.ok, true, `mcp tool returned an error: ${JSON.stringify(inner)}`);
    assert.match(fieldText((inner.data ?? {}).stdout), /mcp-ok/);

    step("e2e passed");
  } finally {
    step(`cleanup ${scratch}`);
    await runCli(["exec", "--", "bash", "-c", `rm -rf ${scratch}`]);
  }
}

async function main(): Promise<void> {
  const logger: Logger = { log: (message) => process.stderr.write(`${message}\n`) };
  const probe = await probePrerequisites();
  if (!probe.ready || probe.codespace === undefined) {
    process.stderr.write(`SKIP: ${probe.reason ?? "prerequisites not met"}\n`);
    return;
  }
  process.stderr.write(`Running e2e against ${probe.codespace}\n`);
  await runLiveSmoke({ codespace: probe.codespace }, logger);
  process.stderr.write("OK\n");
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
