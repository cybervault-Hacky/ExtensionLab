import type { JobRow, JobStatus, JobType } from "@/lib/db/repositories/jobs";
import type { ErrorCode } from "@/lib/observability/errors";

export type { JobRow, JobStatus, JobType };

/** Safe priority classes; resolved through configuration, never raw client input. */
export type JobPriorityClass = "interactive" | "enterprise" | "ci" | "normal";

/** Public job projection (never includes payload secrets, worker ids or hosts). */
export interface JobView {
  id: string;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: ErrorCode | null;
  queuePosition: number | null;
  resourceType: string | null;
  resourceId: string | null;
}

export interface AutomatedTestPayload {
  runId: string;
  packageId: string;
  extensionId: string | null;
  testUrl?: string;
  /** Only the ids of the discovered tests; the registry is deterministic. */
  testIds: string[];
  reservationId: string | null;
  /** Phase 9: browser runtime for this execution (absent = Chromium, legacy jobs). */
  browserId?: string;
  /** Phase 9: parent matrix linkage, when this run belongs to a browser matrix. */
  matrixRunId?: string;
}

export interface EmailPayload {
  /** Template identifier; the worker renders the message server-side. */
  template: "password-reset";
  to: string;
  /** Template variables. Never contains raw secrets: reset links carry a one-time token by design. */
  variables: Record<string, string>;
}

export interface ArtifactCleanupPayload {
  scope?: "all" | "artifacts" | "packages" | "auth" | "jobs" | "billing" | "ai" | "organizations";
}

export interface ReportGenerationPayload {
  reportId: string;
}

export interface AnalysisPayload {
  packageId: string;
  extensionId: string | null;
}

export interface WebhookDeliveryPayload {
  deliveryId: string;
}

export interface OrgExportPayload {
  exportId: string;
  organizationId: string;
}

export type JobPayloadMap = {
  AUTOMATED_TEST: AutomatedTestPayload;
  EMAIL: EmailPayload;
  ARTIFACT_CLEANUP: ArtifactCleanupPayload;
  REPORT_GENERATION: ReportGenerationPayload;
  ANALYSIS: AnalysisPayload;
  WEBHOOK_DELIVERY: WebhookDeliveryPayload;
  ORG_EXPORT: OrgExportPayload;
};

export interface JobContext<T extends JobType = JobType> {
  job: JobRow;
  payload: JobPayloadMap[T];
  /**
   * True once cancellation was requested or shutdown started. Negative answers
   * are cached briefly; pass `force` before irreversible steps (e.g. creating
   * a sandbox) to consult the database directly.
   */
  isCancelled(force?: boolean): boolean;
  /** Renews the lease; call from long-running handlers. */
  heartbeat(): void;
  /** Appends a stage/progress event visible to the owner. */
  emit(kind: string, payload: Record<string, unknown>, stage?: string): void;
  signal: AbortSignal;
}

export interface JobHandler<T extends JobType = JobType> {
  type: T;
  handle(context: JobContext<T>): Promise<Record<string, unknown> | void>;
  /** Invoked when a running job must be cancelled (idempotent). */
  cancel?(context: JobContext<T>): Promise<void>;
  /** Redact the stored payload once the job reaches a terminal state. */
  redactPayloadOnFinish?: boolean;
}

export interface WorkerHealth {
  workerId: string;
  startedAt: number;
  activeJobs: number;
  concurrency: number;
  sandboxAvailable: boolean | null;
  stopping: boolean;
}
