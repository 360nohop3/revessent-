"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DECLINE_CATEGORY_LABEL, computeFreshness, formatAge } from "@revessent/domain";
import {
  Button, ErrorState, EvidenceList, FreshnessBanner, ModeBadge, Skeleton, Timeline, useToast
} from "@revessent/ui";
import { amountLabel, formatDateTime } from "@/lib/format";
import { api, ApiError } from "@/lib/api";
import { useCase, useStripeConnection } from "@/lib/queries";
import { roleFor, useSession } from "@/components/session";
import { can } from "@/lib/permissions";
import { CaseChip } from "./status-chips";
import { DraftMessageCard } from "./draft-message-card";
import { DemoProviderControls } from "./demo-provider-controls";
import type { RecoveryExecution } from "@revessent/contracts";

export function RecoveryDetailView() {
  const params = useParams<{ orgSlug: string; caseId: string }>();
  const slug = params.orgSlug;
  const caseId = params.caseId;
  const session = useSession();
  const role = roleFor(session, slug);

  const conn = useStripeConnection(slug);
  const query = useCase(slug, caseId);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [executing, setExecuting] = useState(false);
  const [execution, setExecution] = useState<RecoveryExecution | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);

  if (query.isLoading) {
    return (
      <div className="mx-auto flex w-[min(900px,100%)] flex-col gap-4" role="status" aria-label="Loading case">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="mx-auto w-[min(640px,100%)] pt-6">
        <ErrorState
          title="Case unavailable"
          message="This recovery case couldn't be loaded. It may not exist in the fixtures, or the request failed."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
        <div className="mt-4 text-center">
          <Link href={`/app/${slug}/recovery`} className="btn btn-glass btn-sm">Back to recovery</Link>
        </div>
      </div>
    );
  }

  const { case: rec, timeline } = query.data;
  const connection = conn.data;
  const qk = ["org", slug, "case", caseId] as const;
  const canOperate = can(role, "request_retry"); // server enforces the same gate (RBAC operate)

  async function executeRetry() {
    if (executing) return; // prevent accidental repeated submission
    setExecuting(true);
    setExecutionError(null);
    try {
      const res = await api.recovery.executeRetry(slug, caseId);
      setExecution(res);
      if (res.status === "succeeded") {
        toast({ title: "Payment succeeded", description: "The provider accepted the payment. Webhooks confirm final state.", tone: "ok" as const });
      } else if (res.status === "unknown") {
        toast({ title: "Outcome unknown", description: "The provider response was lost. Nothing is assumed — reconcile to establish the outcome.", tone: "warn" as const });
      } else if (res.outcomeCategory === "card_declined" || res.outcomeCategory === "insufficient_funds" || res.outcomeCategory === "expired_card" || res.outcomeCategory === "authentication_required") {
        toast({ title: "Payment declined", description: "The payment method was declined or needs authentication. Nothing was charged and nothing retries automatically.", tone: "warn" as const });
      } else {
        toast({ title: "Payment not executed", description: "The operation failed before any charge — see the failure reason below.", tone: "warn" as const });
      }
      await qc.invalidateQueries({ queryKey: qk });
    } catch (err) {
      setExecutionError(err instanceof ApiError ? err.problem.detail ?? err.problem.title : "Execution failed — nothing was charged.");
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div className="mx-auto flex w-[min(900px,100%)] flex-col gap-5">
      <nav aria-label="Breadcrumb" className="text-[12.5px] text-ink-3">
        <Link href={`/app/${slug}/recovery`} className="underline underline-offset-2 hover:text-ink">Recovery</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{rec.customerName}</span>
      </nav>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">{rec.customerName}</h1>
        <CaseChip status={rec.status} />
        <ModeBadge mode={connection?.mode ?? "demo"} />
        <span className="num ml-auto font-mono text-[15px] font-semibold text-ink">{amountLabel(rec.amount, rec.interval)}{rec.interval === "unsupported" ? <span className="text-[11.5px] text-ink-3"> · cadence unsupported</span> : null}</span>
      </header>

      {connection ? (
        <FreshnessBanner
          freshness={computeFreshness(connection.lastSyncAt)}
          syncing={connection.backfill === "running"}
          lastSyncLabel={connection.lastSyncAt ? formatAge(connection.lastSyncAt) : undefined}
        />
      ) : null}

      {!rec.outreachSafe ? (
        <p role="note" className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px] font-medium text-warn-ink">
          Hard decline ({rec.declineCode}) — outreach is suppressed for this category. No note or checkout will be offered.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section aria-label="Evidence" className="glass p-5">
          <h2 className="text-[15px] font-bold text-ink">Evidence</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Fields reported by the provider. No scores, no guesses.</p>
          <div className="mt-3">
            <EvidenceList
              items={[
                { label: "Decline code", value: rec.declineCode, source: "Stripe" },
                { label: "Category", value: DECLINE_CATEGORY_LABEL[rec.category], source: "policy" },
                { label: "Amount", value: amountLabel(rec.amount, rec.interval) + (rec.interval === "unsupported" ? " (cadence unsupported)" : ""), source: "Stripe" },
                { label: "First failed", value: formatDateTime(rec.createdAt), source: "Stripe" },
                { label: "Attempts so far", value: String(rec.evidence.attempts.length), source: "Stripe" },
                {
                  label: "Next action",
                  value: rec.nextActionAt ? formatDateTime(rec.nextActionAt) : "depends on draft outcome",
                  source: "policy"
                }
              ]}
            />
          </div>
        </section>

        <section aria-label="Attempt history" className="glass p-5">
          <h2 className="text-[15px] font-bold text-ink">Attempt history</h2>
          <ol className="mt-3 flex flex-col gap-2.5">
            {rec.evidence.attempts.map((a, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line-soft pb-2.5 last:border-0">
                <span className="text-[13.5px] text-ink-2">
                  <span className="font-mono text-[12px] text-ink-3">{a.source}</span>
                  {" — "}
                  {a.outcome === "succeeded" ? "succeeded" : `failed (${a.declineCode ?? "unknown"})`}
                </span>
                <span className="num font-mono text-[11.5px] text-ink-4">{formatDateTime(a.at)}</span>
              </li>
            ))}
            {rec.evidence.attempts.length === 0 ? <li className="text-[13.5px] text-ink-3">No attempts recorded.</li> : null}
          </ol>
        </section>
      </div>

      <section aria-label="Case timeline" className="glass p-5">
        <h2 className="text-[15px] font-bold text-ink">Timeline</h2>
        <div className="mt-4">
          {timeline.length === 0 ? (
            <p className="text-[13.5px] text-ink-3">No narrative events recorded for this fixture.</p>
          ) : (
            <Timeline
              label="Case timeline"
              entries={timeline.map((t) => ({
                id: t.id,
                at: t.at,
                title: t.title,
                detail: t.detail,
                tone: t.tone,
                timeLabel: formatDateTime(t.at)
              }))}
            />
          )}
        </div>
      </section>

      <DraftMessageCard
        slug={slug}
        kind="case"
        parentId={rec.id}
        queryKey={qk}
        draft={rec.draft}
        role={role}
        title="Recovery note"
      />

      {rec.draft ? <DemoProviderControls slug={slug} kind="case" parentId={rec.id} queryKey={qk} status={rec.draft.approvalStatus} /> : null}

      {rec.status !== "recovered" && rec.status !== "lost" && rec.status !== "canceled" ? (
        <section aria-label="Payment execution" className="glass p-5" data-testid="payment-execution">
          <h2 className="text-[15px] font-bold text-ink">Retry payment</h2>
          <p className="mt-1 text-[12.5px] text-ink-3" data-testid="retry-state">
            {rec.retry.state === "waiting"
              ? `Automated retry: waiting — ${rec.retry.autoAttempts} of ${rec.retry.maxAutoRetries} used${rec.retry.nextEligibleAt ? `, eligible ${formatDateTime(rec.retry.nextEligibleAt)}` : ""}.`
              : rec.retry.state === "eligible"
              ? `Automated retry: eligible${rec.retry.autoAttempts ? ` (${rec.retry.autoAttempts} of ${rec.retry.maxAutoRetries} used)` : ""} — a run may execute it with the same safety checks as a manual retry.`
              : rec.retry.state === "exhausted"
              ? `Automated retry: exhausted (${rec.retry.reason}). No further automatic attempts.`
              : rec.retry.state === "disabled"
              ? `Automated retry: unavailable (${rec.retry.reason}).`
              : rec.retry.reason === "unresolved_execution_reconcile_first"
              ? "Automated retry: blocked — an outcome could not be confirmed. Reconcile before anything retries."
              : `Automated retry: blocked (${rec.retry.reason}).`}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            One explicit, idempotent charge attempt for this failed payment via Stripe. Nothing runs
            automatically — declines never retry by themselves.
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[160px_1fr]">
            <dt className="text-ink-3">Customer</dt>
            <dd className="text-ink-2">{rec.customerName} · {rec.customerEmail}</dd>
            <dt className="text-ink-3">Amount</dt>
            <dd className="num font-mono text-ink-2">{amountLabel(rec.amount, rec.interval)}</dd>
            <dt className="text-ink-3">Currency</dt>
            <dd className="num font-mono text-ink-2">{rec.amount.currency}</dd>
          </dl>
          {canOperate && connection?.status === "read_only" ? (
            <Button size="sm" className="mt-3" loading={executing} onClick={() => void executeRetry()}>
              {executing ? "Executing…" : `Retry ${amountLabel(rec.amount, rec.interval)} payment`}
            </Button>
          ) : null}
          {!canOperate ? (
            <p className="mt-3 text-[12.5px] text-ink-3">Executing a payment requires an operator, admin or owner role.</p>
          ) : null}
          {execution ? (
            <div className="mt-3 rounded-lg border border-line p-3 text-[13px]" data-testid="execution-status">
              <span className="num font-mono text-ink-2">
                {execution.status === "unknown" || execution.status === "executing"
                  ? "Outcome unknown — the provider response was lost. Nothing is assumed; reconcile to establish it. No second attempt will be made automatically."
                  : execution.status === "succeeded"
                  ? "Payment succeeded."
                  : execution.outcomeCategory === "card_declined" || execution.outcomeCategory === "insufficient_funds" || execution.outcomeCategory === "expired_card"
                  ? `Declined by the card (${execution.declineCode ?? execution.outcomeCategory}). Nothing was charged; no automatic retry.`
                  : execution.outcomeCategory === "authentication_required"
                  ? "The customer must complete bank authentication. Nothing was charged; no automatic retry."
                  : `Not executed: ${execution.errorCode ?? execution.outcomeCategory ?? "failed"}. Nothing was charged.`}
              </span>
            </div>
          ) : null}
          {executionError ? (
            <p role="alert" className="mt-3 text-[12.5px] text-warn-ink">{executionError}</p>
          ) : null}
        </section>
      ) : null}

      <p className="px-1 text-[12px] text-ink-4">
        Automatic retries, notes and checkouts remain later-phase work (no worker exists). The retry
        button executes one explicit charge attempt; emails are never sent from this page.
      </p>
    </div>
  );
}
