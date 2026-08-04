import { getDb } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { consumeAnalyticsDomainEvents } from "@/src/modules/analytics/server/analytics-domain-event-consumer";
import { dispatchScheduledCandidates } from "../domain/job-dispatcher.mjs";
import type { ScheduledJobRecord } from "../domain/types";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";

const DISPATCH_LIMIT = 10;
const LEASE_SECONDS = 300;

type DispatcherClock = () => Date;
type ScheduledJobLease = { owner: string; version: string };

export async function runDueScheduledJobs(input: {
  execute(job: ScheduledJobRecord): Promise<void>;
  now?: Date;
  clock?: DispatcherClock;
}): Promise<{ claimed: number; completed: number; failures: number; superseded: number }> {
  const clock = dispatcherClock(input.now, input.clock);
  const now = input.now ?? clock();
  const nowIso = now.toISOString();
  await consumeAnalyticsDomainEvents({ now });
  const candidates = await getDb().select().from(scheduledJobs).where(and(
    eq(scheduledJobs.status, "active"),
    lte(scheduledJobs.dueAt, nowIso),
    or(isNull(scheduledJobs.leaseExpiresAt), lte(scheduledJobs.leaseExpiresAt, nowIso)),
  )).orderBy(asc(scheduledJobs.dueAt), asc(scheduledJobs.id)).limit(DISPATCH_LIMIT);

  return dispatchScheduledCandidates(candidates, {
    claim: async (candidate) => {
      const claimedAt = clock();
      const claimedAtIso = claimedAt.toISOString();
      const leaseOwner = crypto.randomUUID();
      const leaseExpiresAt = new Date(claimedAt.getTime() + LEASE_SECONDS * 1000).toISOString();
      const result = await getDb().$client.prepare(`
        UPDATE scheduled_jobs
        SET lease_owner = ?, lease_expires_at = ?, last_started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND due_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND updated_at = ?
      `).bind(
        leaseOwner, leaseExpiresAt, claimedAtIso, claimedAtIso,
        candidate.id, claimedAtIso, claimedAtIso, candidate.updatedAt,
      ).run();
      if ((result.meta.changes ?? 0) !== 1) return null;
      return {
        candidate: {
          ...candidate,
          leaseOwner,
          leaseExpiresAt,
          lastStartedAt: claimedAtIso,
          updatedAt: claimedAtIso,
        },
        claim: { owner: leaseOwner, version: claimedAtIso },
      };
    },
    execute: (candidate) => input.execute(toScheduledJob(candidate)),
    succeed: async (candidate, lease) => {
      const completedAt = clock();
      const completedAtIso = completedAt.toISOString();
      const outcome = await finishJob(candidate.id, lease, {
        dueAt: new Date(completedAt.getTime() + candidate.intervalSeconds * 1000).toISOString(),
        attemptCount: 0,
        lastCompletedAt: completedAtIso,
        lastErrorType: null,
        updatedAt: completedAtIso,
      });
      return outcome === "finished" ? "completed" : "superseded";
    },
    fail: async (candidate, lease, cause) => {
      const failedAt = clock();
      const failedAtIso = failedAt.toISOString();
      const attemptCount = candidate.attemptCount + 1;
      const retrySeconds = Math.min(3600, 60 * (2 ** Math.min(attemptCount - 1, 6)));
      const outcome = await finishJob(candidate.id, lease, {
        dueAt: new Date(failedAt.getTime() + retrySeconds * 1000).toISOString(),
        attemptCount,
        lastCompletedAt: null,
        lastErrorType: safeErrorType(cause),
        updatedAt: failedAtIso,
      });
      return outcome === "finished" ? "failed" : "superseded";
    },
  });
}

function dispatcherClock(now: Date | undefined, clock: DispatcherClock | undefined): DispatcherClock {
  if (clock) return clock;
  if (now) {
    const fixedTime = now.getTime();
    return () => new Date(fixedTime);
  }
  return () => new Date();
}

function toScheduledJob(candidate: typeof scheduledJobs.$inferSelect): ScheduledJobRecord {
  return {
    id: candidate.id,
    organizationId: candidate.organizationId,
    fieldId: candidate.fieldId,
    type: candidate.type,
    payload: candidate.payload,
    status: candidate.status,
    dueAt: candidate.dueAt,
    intervalSeconds: candidate.intervalSeconds,
    attemptCount: candidate.attemptCount,
  };
}

async function finishJob(id: string, lease: ScheduledJobLease, update: {
  dueAt: string;
  attemptCount: number;
  lastCompletedAt: string | null;
  lastErrorType: string | null;
  updatedAt: string;
}): Promise<"finished" | "superseded"> {
  const result = await getDb().$client.prepare(`
    UPDATE scheduled_jobs
    SET due_at = ?, attempt_count = ?, last_completed_at = ?, last_error_type = ?,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND lease_owner = ? AND updated_at = ?
  `).bind(
    update.dueAt, update.attemptCount, update.lastCompletedAt, update.lastErrorType,
    update.updatedAt, id, lease.owner, lease.version,
  ).run();
  return (result.meta.changes ?? 0) === 1 ? "finished" : "superseded";
}

function safeErrorType(cause: unknown): string {
  const value = cause instanceof Error ? cause.name : typeof cause;
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "unknown";
}
