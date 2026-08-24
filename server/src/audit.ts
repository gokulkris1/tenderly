import { accountId, actorEmail, type AuthenticatedRequest } from "./auth.js";
import { recordAudit } from "./db.js";

/**
 * The actions worth recording: the ones that change what eventually reaches a
 * buyer. Naming them here rather than passing free strings keeps the log
 * filterable, and makes it obvious when a new sensitive action has been added
 * without being recorded.
 */
export const AUDIT_ACTIONS = {
  evidenceVerified: "evidence.verified",
  evidenceUnverified: "evidence.unverified",
  answerMarkedReady: "answer.marked_ready",
  attestationRecorded: "attestation.recorded",
  packFinalDownloaded: "pack.final.downloaded",
  packDraftDownloaded: "pack.draft.downloaded",
  documentUploaded: "document.uploaded",
  noAiModeEnabled: "no_ai_mode.enabled",
  noAiModeDisabled: "no_ai_mode.disabled",
  aiPolicyAcknowledged: "ai_policy.acknowledged",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Records one sensitive action.
 *
 * Two rules hold at this boundary. The log never carries document contents or
 * secrets — callers pass a name and identifiers, never a body. And a logging
 * failure never fails the user's action: the action already happened, and
 * losing the record must not undo it. Failures are logged to the server.
 */
export async function audit(req: AuthenticatedRequest, entry: {
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  subjectLabel?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await recordAudit({
      accountId: accountId(req),
      actor: actorEmail(req),
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      subjectLabel: entry.subjectLabel ?? "",
      metadata: entry.metadata ?? {},
      requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined,
    });
  } catch (error) {
    console.error(`audit write failed for ${entry.action}:`, error instanceof Error ? error.message : error);
  }
}
