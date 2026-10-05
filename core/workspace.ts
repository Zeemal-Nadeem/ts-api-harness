// Every run happens in its own git worktree on branch harness/<runId>, created
// by the harness from the base commit. The model never sees git; the user's
// checkout and the base branch are never written to.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./util.ts";
import type { Task } from "./types.ts";

export interface Workspace {
  worktree: string;
  branch: string;
  baseRef: string;
  apiRoot: string;
  /** Pristine copy of the API at run start (git-ignored), for contract comparison. */
  beforeRoot?: string;
}

export function git(cwd: string, ...args: string[]): string {
  const r = exec("git", args, { cwd, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export function worktreePath(harnessRoot: string, runId: string): string {
  return join(harnessRoot, ".harness", "worktrees", runId);
}

function scaffold(harnessRoot: string, apiRoot: string, task: Task): void {
  const resource = task.resource?.name;
  if (!resource) throw new Error("greenfield task without resource");
  const camel = resource.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  cpSync(join(harnessRoot, "templates", "api-scaffold"), apiRoot, { recursive: true });
  const fill = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) fill(abs);
      else writeFileSync(abs, readFileSync(abs, "utf8").replace(/__RESOURCE__Router/g, `${camel}Router`).replace(/__RESOURCE__/g, resource));
    }
  };
  fill(apiRoot);
}

export function prepareWorkspace(harnessRoot: string, runId: string, task: Task): Workspace {
  const baseRef = git(harnessRoot, "rev-parse", "HEAD");
  const branch = `harness/${runId}`;
  const worktree = worktreePath(harnessRoot, runId);
  mkdirSync(join(harnessRoot, ".harness", "worktrees"), { recursive: true });
  git(harnessRoot, "worktree", "add", "-q", "-b", branch, worktree, baseRef);

  const apiRoot = join(worktree, task.target);
  if (task.mode === "greenfield") {
    // Greenfield regenerates from the scaffold even if a previous run's output was merged.
    if (existsSync(apiRoot)) rmSync(apiRoot, { recursive: true, force: true });
    scaffold(harnessRoot, apiRoot, task);
    return { worktree, branch, baseRef, apiRoot };
  }
  if (!existsSync(join(apiRoot, "src"))) throw new Error(`brownfield target has no src/: ${task.target}`);
  const beforeRoot = join(worktree, ".harness", "before");
  cpSync(apiRoot, beforeRoot, { recursive: true });
  return { worktree, branch, baseRef, apiRoot, beforeRoot };
}
