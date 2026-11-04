import { z } from "zod";
import type { TenderWorkflow, TenderWorkflowPatch } from "@tenderly/shared";

const stage = z.enum(["NEW", "REVIEW", "IGNORE", "CONSIDER", "APPLICATION", "DONE"]);
const outcome = z.enum(["PENDING", "WON", "NOT_WON"]);
const priority = z.enum(["LOW", "MEDIUM", "HIGH"]);

export const workflowPatchSchema = z.object({
  stage: stage.optional(),
  outcome: outcome.optional(),
  assignee: z.string().trim().max(254).optional(),
  priority: priority.optional(),
  comment: z.string().trim().min(1).max(4000).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "Provide a workflow change or comment");

const workflowSchema = z.object({
  stage, outcome, priority,
  assignee: z.string(),
  history: z.array(z.object({ at: z.string(), actor: z.string(), message: z.string() })),
});

export function tenderWorkflow(value: unknown): TenderWorkflow {
  if (value === undefined) return { stage: "NEW", outcome: "PENDING", assignee: "", priority: "MEDIUM", history: [] };
  return workflowSchema.parse(value);
}

export function changeWorkflow(current: TenderWorkflow, patch: TenderWorkflowPatch, actor: string): TenderWorkflow {
  const { comment, ...fields } = patch;
  const next = { ...current, ...fields };
  // A result closes the application; reopening explicitly clears that result.
  if (patch.outcome && patch.outcome !== "PENDING") next.stage = "DONE";
  else if (patch.stage && patch.stage !== "DONE") next.outcome = "PENDING";
  const changes: string[] = [];
  if (next.stage !== current.stage) changes.push(`Stage: ${current.stage} -> ${next.stage}`);
  if (next.outcome !== current.outcome) changes.push(`Result: ${next.outcome}`);
  if (next.assignee !== current.assignee) changes.push(`Assignee: ${next.assignee || "Unassigned"}`);
  if (next.priority !== current.priority) changes.push(`Priority: ${next.priority}`);
  if (comment) changes.push(comment);
  return {
    ...next,
    history: changes.length
      ? [...current.history, { at: new Date().toISOString(), actor, message: changes.join("\n") }]
      : current.history,
  };
}
