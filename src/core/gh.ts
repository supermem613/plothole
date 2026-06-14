import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PlotholeError } from "./errors.js";

const execFileAsync = promisify(execFile);

// gh is always spawned with an argv array and no shell. The remote command is a
// single argv element, so no host shell ever parses code-bearing arguments.
// This is what keeps edit/search/exec arguments intact across the boundary.

let cachedGhPath: string | undefined;

export async function resolveGh(): Promise<string> {
  if (cachedGhPath !== undefined) {
    return cachedGhPath;
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    const { stdout } = await execFileAsync(finder, ["gh"], { windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0];
    cachedGhPath = first ?? "gh";
  } catch {
    cachedGhPath = "gh";
  }
  return cachedGhPath;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runProcess(
  file: string,
  args: string[],
  options: { stdin?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
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
      resolve({ stdout, stderr, code });
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function runGh(args: string[], options: { stdin?: string } = {}): Promise<ProcessResult> {
  const gh = await resolveGh();
  try {
    return await runProcess(gh, args, options);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PlotholeError(`failed to run gh: ${reason}`, "Install the GitHub CLI and ensure `gh` is on PATH.");
  }
}

export interface CodespaceInfo {
  name: string;
  state: string;
  repository: string;
}

function ghFailureHint(stderr: string): string {
  if (/scope|403|forbidden/i.test(stderr)) {
    return "The active gh account is missing the codespace scope. Switch to the account that owns the codespaces, for example `gh auth switch -u <github-username>`.";
  }
  if (/not logged in|authentication/i.test(stderr)) {
    return "Run `gh auth login` and select the account that owns the codespaces.";
  }
  return "Check `gh auth status` and confirm the active account can access codespaces.";
}

export async function listCodespaces(): Promise<CodespaceInfo[]> {
  const result = await runGh(["codespace", "list", "--json", "name,state,repository"]);
  if (result.code !== 0) {
    throw new PlotholeError("gh codespace list failed", ghFailureHint(result.stderr));
  }
  const parsed = JSON.parse(result.stdout) as Array<{ name: string; state: string; repository: string }>;
  return parsed.map((item) => ({ name: item.name, state: item.state, repository: item.repository }));
}

export async function activeGhUser(): Promise<string | null> {
  const result = await runGh(["api", "user", "-q", ".login"]);
  if (result.code !== 0) {
    return null;
  }
  const login = result.stdout.trim();
  return login.length > 0 ? login : null;
}
