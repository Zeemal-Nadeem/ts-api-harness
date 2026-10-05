// Task files are YAML, validated here. The schema is strict: a task cannot
// carry a model name, provider, prompt format or tool schema — unknown keys fail.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Task } from "./types.ts";

const TaskSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    mode: z.enum(["greenfield", "brownfield"]),
    target: z.string().min(1),
    brief: z.string().min(1),
    resource: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]*s$/, "resource name must be a plural lower-kebab noun"),
        fields: z.record(z.string(), z.string()),
      })
      .strict()
      .optional(),
    behaviours: z.array(z.string()).default([]),
    testMap: z.record(z.string(), z.string()).optional(),
    allowBreaking: z.boolean().default(false),
    maxTurns: z.number().int().positive().default(40),
  })
  .strict()
  .refine((t) => t.mode === "brownfield" || t.resource !== undefined, "greenfield tasks need a resource");

export function loadTask(file: string): { task: Task; text: string } {
  const text = readFileSync(file, "utf8");
  const task: Task = TaskSchema.parse(parse(text));
  return { task, text };
}
