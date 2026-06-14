import chalk from "chalk";
import { activeGhUser, listCodespaces, resolveGh, runGh, type CodespaceInfo } from "../core/gh.js";
import { getActiveCodespace } from "../core/state.js";
import { execVerb } from "../core/verbs.js";
import { PlotholeError } from "../core/errors.js";

// CheckResult shape is a common health-check convention.
// Keep it stable: tooling and `--json` consumers depend on it.
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

function checkNode(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) {
    return {
      name: "node",
      ok: false,
      detail: `Node ${process.versions.node} (need >=22)`,
      hint: "Install Node 22 or later from https://nodejs.org",
    };
  }
  return { name: "node", ok: true, detail: `Node ${process.versions.node}` };
}

async function checkGh(): Promise<CheckResult> {
  try {
    const gh = await resolveGh();
    const result = await runGh(["--version"]);
    if (result.code !== 0) {
      return {
        name: "gh",
        ok: false,
        detail: "gh --version failed",
        hint: "Install the GitHub CLI from https://cli.github.com",
      };
    }
    const version = result.stdout.split(/\r?\n/)[0] ?? "gh";
    return { name: "gh", ok: true, detail: `${version} (${gh})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: "gh", ok: false, detail: message, hint: "Install the GitHub CLI from https://cli.github.com" };
  }
}

// Listing codespaces is the canonical auth/scope check: the codespace scope
// lives on a specific gh account, so a wrong active account surfaces here as a
// 403 with the switch-account hint rather than as a cryptic failure mid-verb.
async function checkCodespaces(): Promise<{ result: CheckResult; codespaces: CodespaceInfo[] }> {
  try {
    const codespaces = await listCodespaces();
    const user = await activeGhUser();
    return {
      result: {
        name: "codespaces",
        ok: true,
        detail: `${codespaces.length} codespace(s) visible to ${user ?? "the active gh account"}`,
      },
      codespaces,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof PlotholeError ? err.hint : undefined;
    return { result: { name: "codespaces", ok: false, detail: message, hint }, codespaces: [] };
  }
}

async function checkActive(codespaces: CodespaceInfo[]): Promise<CheckResult[]> {
  const active = getActiveCodespace();
  if (active === undefined || active === "") {
    return [
      {
        name: "active-codespace",
        ok: false,
        detail: "no active codespace selected",
        hint: "Run `plothole session --ensure <name>` to pick one.",
      },
    ];
  }
  const known = codespaces.find((codespace) => codespace.name === active);
  const results: CheckResult[] = [
    {
      name: "active-codespace",
      ok: known !== undefined,
      detail: known === undefined ? `${active} (not in the visible list)` : `${active} (${known.state})`,
      hint:
        known === undefined
          ? "The active codespace is not visible to this account. Re-run `plothole session --ensure <name>`."
          : undefined,
    },
  ];
  // Only attempt the SSH round-trip when the codespace is visible, to avoid a
  // slow connection timeout when the selection is already known to be stale.
  if (known !== undefined) {
    try {
      const probe = await execVerb({ command: ["echo", "plothole-ok"] });
      const ok = probe.status === "completed" && probe.exitCode === 0 && probe.stdout.includes("plothole-ok");
      results.push({
        name: "reachability",
        ok,
        detail: probe.status === "completed" ? (ok ? "ssh round-trip succeeded" : `exit ${probe.exitCode}`) : "ssh round-trip still running",
        hint: ok ? undefined : "The codespace may be stopped. Start it, then re-run doctor.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: "reachability", ok: false, detail: message, hint: "Confirm the codespace is running." });
    }
  }
  return results;
}

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode(), await checkGh()];
  const codespaceCheck = await checkCodespaces();
  results.push(codespaceCheck.result);
  if (codespaceCheck.result.ok) {
    results.push(...(await checkActive(codespaceCheck.codespaces)));
  }
  return results;
}

export async function doctorCommand(opts: { json?: boolean }): Promise<void> {
  const results = await runChecks();
  const allOk = results.every((r) => r.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: allOk, checks: results }, null, 2) + "\n");
    process.exit(allOk ? 0 : 1);
  }

  console.log(chalk.bold(`plothole doctor\n`));
  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${r.name.padEnd(20, ".")} ${r.detail}`);
    if (!r.ok && r.hint) {
      console.log(`      ${chalk.dim(r.hint)}`);
    }
  }
  console.log();
  console.log(allOk ? chalk.green("All checks passed.") : chalk.red("One or more checks failed."));
  process.exit(allOk ? 0 : 1);
}
