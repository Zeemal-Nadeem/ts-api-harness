// JIT context fetchers + file edits. One file exporting several tools.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { walk } from "../../core/api-model.ts";
import { resolveInApi } from "../../core/paths.ts";
import type { ToolPlugin } from "../../core/types.ts";

const MAX_LINES = 250;

const number = (lines: string[], from: number): string => lines.map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join("\n");

const readFile: ToolPlugin<{ path: string; from?: number | undefined; to?: number | undefined }> = {
  kind: "tool",
  name: "read_file",
  description: `Read a file in the API directory (numbered lines, max ${MAX_LINES} per call; use from/to for ranges).`,
  input: z.object({ path: z.string(), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }),
  async run({ path, from, to }, ctx) {
    const { abs, rel } = resolveInApi(ctx.apiRoot, path);
    if (!existsSync(abs)) return { content: `ERROR: ${rel} does not exist` };
    const all = readFileSync(abs, "utf8").split("\n");
    const start = from ?? 1;
    const end = Math.min(to ?? start + MAX_LINES - 1, all.length, start + MAX_LINES - 1);
    const body = number(all.slice(start - 1, end), start);
    const more = end < all.length ? `\n… ${all.length - end} more lines (read_file from=${end + 1})` : "";
    return {
      content: `${rel} (${all.length} lines)\n${body}${more}`,
      raw: `${rel}\n${number(all, 1)}`,
      summary: `read_file ${rel} lines ${start}-${end}`,
    };
  },
};

const listFiles: ToolPlugin<{ dir?: string | undefined }> = {
  kind: "tool",
  name: "list_files",
  description: "List files under a directory of the API (default: whole API).",
  input: z.object({ dir: z.string().optional() }),
  async run({ dir }, ctx) {
    const { abs, rel } = resolveInApi(ctx.apiRoot, dir ?? ".");
    const files = walk(abs, () => true).map((f) => (rel ? join(rel, f) : f));
    return { content: files.join("\n") || "(empty)", summary: `list_files ${rel || "."}: ${files.length} files` };
  },
};

const search: ToolPlugin<{ pattern: string; dir?: string | undefined }> = {
  kind: "tool",
  name: "search",
  description: "Regex search across API files; returns up to 40 file:line matches.",
  input: z.object({ pattern: z.string().min(1), dir: z.string().optional() }),
  async run({ pattern, dir }, ctx) {
    const re = new RegExp(pattern);
    const { abs, rel } = resolveInApi(ctx.apiRoot, dir ?? ".");
    const hits: string[] = [];
    for (const f of walk(abs, (r) => /\.(ts|json|md)$/.test(r))) {
      readFileSync(join(abs, f), "utf8").split("\n").forEach((l, i) => {
        if (re.test(l)) hits.push(`${rel ? join(rel, f) : f}:${i + 1}: ${l.trim().slice(0, 160)}`);
      });
    }
    const shown = hits.slice(0, 40);
    return {
      content: (shown.join("\n") || "no matches") + (hits.length > 40 ? `\n… ${hits.length - 40} more` : ""),
      raw: hits.join("\n") || "no matches",
      summary: `search /${pattern}/: ${hits.length} hits`,
    };
  },
};

const writeFile: ToolPlugin<{ path: string; content: string }> = {
  kind: "tool",
  name: "write_file",
  description: "Create or overwrite a file in the API directory.",
  input: z.object({ path: z.string(), content: z.string() }),
  async run({ path, content }, ctx) {
    const { abs, rel } = resolveInApi(ctx.apiRoot, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    ctx.state.writes.push(rel);
    const n = content.split("\n").length;
    return { content: `wrote ${rel} (${n} lines)`, summary: `write_file ${rel} (${n} lines)` };
  },
};

const editFile: ToolPlugin<{ path: string; find: string; replace: string }> = {
  kind: "tool",
  name: "edit_file",
  description: "Replace one exact, unique occurrence of `find` with `replace` in a file.",
  input: z.object({ path: z.string(), find: z.string().min(1), replace: z.string() }),
  async run({ path, find, replace }, ctx) {
    const { abs, rel } = resolveInApi(ctx.apiRoot, path);
    if (!existsSync(abs)) return { content: `ERROR: ${rel} does not exist` };
    const text = readFileSync(abs, "utf8");
    const count = text.split(find).length - 1;
    if (count !== 1) return { content: `ERROR: \`find\` occurs ${count} times in ${rel}; it must occur exactly once` };
    writeFileSync(abs, text.replace(find, () => replace));
    ctx.state.writes.push(rel);
    return { content: `edited ${rel}`, summary: `edit_file ${rel}` };
  },
};

export default [readFile, listFiles, search, writeFile, editFile];
