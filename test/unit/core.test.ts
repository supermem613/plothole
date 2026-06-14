import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shJoin, shQuote } from "../../src/core/shquote.js";
import { parseSentinel, wrapRemote, RC_PREFIX, RC_SUFFIX } from "../../src/core/sentinel.js";
import { resolveExecInput } from "../../src/core/verbs.js";
import {
  buildExecCommand,
  buildReadCommand,
  buildRunnerScript,
  buildSearchCommand,
  buildEditCommand,
} from "../../src/core/remote.js";

describe("shquote", () => {
  it("leaves safe tokens unquoted", () => {
    assert.equal(shQuote("rush"), "rush");
    assert.equal(shQuote("/workspaces/app"), "/workspaces/app");
  });

  it("single-quotes tokens with shell metacharacters", () => {
    assert.equal(shQuote("a b"), "'a b'");
    assert.equal(shQuote("a;b"), "'a;b'");
    assert.equal(shQuote(""), "''");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shQuote("it's"), "'it'\\''s'");
  });

  it("joins an argv array", () => {
    assert.equal(shJoin(["rg", "--glob", "src/**", "foo bar"]), "rg --glob 'src/**' 'foo bar'");
  });
});

describe("sentinel", () => {
  it("wraps the command in a login shell, scopes cwd, and appends the exit-code sentinel", () => {
    const wrapped = wrapRemote("rush build", { cwd: "/workspaces/app" });
    assert.ok(wrapped.startsWith(`bash -lc ${shQuote("cd /workspaces/app && rush build")}`));
    assert.ok(wrapped.includes(`printf '\\n${RC_PREFIX}%s${RC_SUFFIX}\\n'`));
  });

  it("runs a login shell so the Codespaces-injected environment matches the user's terminal", () => {
    // gh cs ssh starts a non-login shell, which never sources the codespaces
    // profile that exports GITHUB_USER, CODESPACE_NAME, tokens, and PATH adds.
    // A login shell reproduces the integrated terminal exactly, which is what a
    // remote build or deploy relies on.
    const wrapped = wrapRemote("env");
    assert.ok(wrapped.includes("bash -lc "), "remote commands must run under a login shell");
    assert.ok(!/\bbash -c /.test(wrapped), "must not fall back to a non-login shell");
  });

  it("omits the cd when no cwd is given", () => {
    const wrapped = wrapRemote("ls");
    assert.ok(wrapped.startsWith("bash -lc ls"));
    assert.ok(!wrapped.includes("cd "));
  });

  it("detaches stdin by default and skips it when asked", () => {
    assert.ok(wrapRemote("ls").includes("< /dev/null"));
    assert.ok(!wrapRemote("ls", { detachStdin: false }).includes("< /dev/null"));
  });

  it("prepends a wall-clock timeout only when a budget is given", () => {
    assert.ok(wrapRemote("ls", { timeoutSeconds: 45 }).startsWith("timeout -k 5 45 bash -lc ls"));
    assert.ok(!wrapRemote("ls").includes("timeout "));
  });

  it("parses the real exit code and strips the sentinel", () => {
    const raw = `build output\n${RC_PREFIX}5${RC_SUFFIX}\n`;
    const result = parseSentinel(raw);
    assert.equal(result.exitCode, 5);
    assert.equal(result.stdout, "build output");
    assert.equal(result.sentinelFound, true);
  });

  it("preserves a trailing newline that belonged to the command output", () => {
    const raw = `line\n\n${RC_PREFIX}0${RC_SUFFIX}\n`;
    const result = parseSentinel(raw);
    assert.equal(result.stdout, "line\n");
    assert.equal(result.exitCode, 0);
  });

  it("reports when no sentinel is present", () => {
    const result = parseSentinel("partial output with no marker");
    assert.equal(result.exitCode, null);
    assert.equal(result.sentinelFound, false);
    assert.equal(result.stdout, "partial output with no marker");
  });
});

describe("remote command builders", () => {
  it("sends a string command to the shell verbatim and shell-quotes argv arrays", () => {
    assert.equal(buildExecCommand("cd src && rush build | tee log"), "cd src && rush build | tee log");
    assert.equal(buildExecCommand(["rush", "build", "-t", "tag:foo"]), "rush build -t tag:foo");
    assert.equal(buildExecCommand(["echo", "a;b"]), "echo 'a;b'");
  });

  it("builds a full-file read", () => {
    assert.equal(buildReadCommand("/workspaces/app/package.json"), "cat /workspaces/app/package.json");
  });

  it("builds a ranged read", () => {
    assert.equal(buildReadCommand("a.ts", { start: 10, end: 20 }), "sed -n 10,20p a.ts");
    assert.equal(buildReadCommand("a.ts", { start: 7 }), "sed -n 7,7p a.ts");
  });

  it("builds a literal search by default and regex on request", () => {
    assert.ok(buildSearchCommand("foo(bar)").includes("--fixed-strings"));
    assert.ok(!buildSearchCommand("foo.*bar", { regex: true }).includes("--fixed-strings"));
    assert.ok(buildSearchCommand("x", { glob: "src/**" }).includes("--glob 'src/**'"));
    assert.ok(buildSearchCommand("x").endsWith("-- x ."), "search must target an explicit root so rg never reads stdin");
  });

  it("does not follow nested symlinks by default but does on request", () => {
    assert.ok(!buildSearchCommand("x").includes("--follow"), "follow must be off by default; rg already descends a symlinked root and following the pnpm link graph is slow");
    assert.ok(buildSearchCommand("x", { follow: true }).includes("--follow"));
  });

  it("selects a content, files, or count output mode", () => {
    assert.ok(buildSearchCommand("x").includes("--line-number"));
    const files = buildSearchCommand("x", { mode: "files" });
    assert.ok(files.includes("--files-with-matches"));
    assert.ok(!files.includes("--line-number"));
    const count = buildSearchCommand("x", { mode: "count" });
    assert.ok(count.includes("--count"));
    assert.ok(!count.includes("--line-number"));
  });

  it("searches gitignored files only when asked", () => {
    assert.ok(!buildSearchCommand("x").includes("--no-ignore"));
    assert.ok(buildSearchCommand("x", { noIgnore: true }).includes("--no-ignore"));
  });

  it("encodes edit payloads as base64 argv so the shell never sees the content", () => {
    const command = buildEditCommand("a.ts", "old\nvalue", "new'value");
    assert.ok(command.startsWith("node -e "));
    assert.ok(command.includes(Buffer.from("old\nvalue", "utf8").toString("base64")));
    assert.ok(command.includes(Buffer.from("new'value", "utf8").toString("base64")));
    assert.ok(!command.includes("old\nvalue"));
  });
  it("normalizes CRLF in the runner body so a Windows script file does not inject carriage returns", () => {
    const runner = buildRunnerScript("set -e\r\necho hi\r\n", "/workspaces/app");
    assert.ok(!runner.includes("\r"), "the runner must contain no carriage returns");
    assert.ok(runner.startsWith("cd /workspaces/app && set -e\necho hi"));
    assert.ok(runner.endsWith('echo $? > "$1/rc"'));
  });
});

describe("resolveExecInput", () => {
  it("passes an inline command through untouched", () => {
    assert.equal(resolveExecInput("cd src && rush build", undefined), "cd src && rush build");
    assert.deepEqual(resolveExecInput(["rush", "build"], undefined), ["rush", "build"]);
  });

  it("reads a host script file as a verbatim shell line", () => {
    const dir = mkdtempSync(join(tmpdir(), "plothole-exec-"));
    try {
      const script = join(dir, "build.sh");
      const body = "set -e\ncd /workspaces/app\nrush build | tee log\n";
      writeFileSync(script, body, "utf8");
      assert.equal(resolveExecInput(undefined, script), body);
      assert.equal(resolveExecInput([], script), body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects supplying both a command and a script file", () => {
    assert.throws(() => resolveExecInput("echo hi", "C:\\nope.sh"), /not both/);
  });

  it("rejects a missing or empty script file", () => {
    assert.throws(() => resolveExecInput(undefined, join(tmpdir(), "plothole-does-not-exist.sh")), /cannot read script file/);
    const dir = mkdtempSync(join(tmpdir(), "plothole-exec-"));
    try {
      const empty = join(dir, "empty.sh");
      writeFileSync(empty, "   \n", "utf8");
      assert.throws(() => resolveExecInput(undefined, empty), /empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires some command when neither input is given", () => {
    assert.throws(() => resolveExecInput(undefined, undefined), /requires a command/);
    assert.throws(() => resolveExecInput("   ", undefined), /requires a command/);
  });
});
