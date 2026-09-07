"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { formatMoney } from "@revessent/domain";
import { Badge, DataTable, ErrorState, EvidenceList, Skeleton, Surface, Timeline, type Column } from "@revessent/ui";
import type { PaymentRow } from "@revessent/contracts";
import { formatDateTime } from "@/lib/format";
import { useCustomer } from "@/lib/queries";

export function CustomerDetailView() {
  const params = useParams<{ orgSlug: string; customerId: string }>();
  const slug = params.orgSlug;
  const id = params.customerId;
  const query = useCustomer(slug, id);

  if (query.isLoading) {
    return (
      <div className="mx-auto flex w-[min(900px,100%)] flex-col gap-4" role="status" aria-label="Loading customer">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="mx-auto w-[min(640px,100%)] pt-6">
        <ErrorState title="Customer unavailable" message="This customer couldn't be loaded from the fixtures." onRetry={() => void query.refetch()} retrying={query.isRefetching} />
        <div className="mt-4 text-center">
          <Link href={`/app/${slug}/customers`} className="btn btn-glass btn-sm">Back to customers</Link>
        </div>
      </div>
    );
  }

  const customer = query.data;

  const paymentColumns: Column<PaymentRow>[] = [
    { key: "at", header: "Date", cell: (p) => <span className="num font-mono text-[12.5px]">{formatDateTime(p.at)}</span> },
    { key: "amount", header: "Amount", align: "right", cell: (p) => <span className="num font-mono text-[13px]">{formatMoney(p.amount)}</span> },
    { key: "outcome", header: "Outcome", cell: (p) => <Badge tone={p.outcome === "paid" ? "ok" : p.outcome === "failed" ? "err" : "neutral"}>{p.outcome}</Badge> },
    { key: "source", header: "Via", hideBelow: "md", cell: (p) => <span className="font-mono text-[12px] text-ink-3">{p.source}</span> }
  ];

  return (
    <div className="mx-auto flex w-[min(1000px,100%)] flex-col gap-5">
      <nav aria-label="Breadcrumb" className="text-[12.5px] text-ink-3">
        <Link href={`/app/${slug}/customers`} className="underline underline-offset-2 hover:text-ink">Customers</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{customer.name}</span>
      </nav>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">{customer.name}</h1>
        <Badge tone={customer.status === "active" ? "ok" : customer.status === "past_due" ? "warn" : "neutral"}>
          {customer.status.replace("_", " ")}
        </Badge>
        <span className="num ml-auto font-mono text-[14px] text-ink-2">{formatMoney(customer.mrr)} /mo</span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section aria-label="Profile" className="glass p-5">
          <h2 className="text-[15px] font-bold text-ink">Profile</h2>
          <div className="mt-3">
            <EvidenceList
              items={[
                { label: "Email", value: customer.email },
                { label: "Risk", value: customer.riskStatus.replace("_", " ") },
                { label: "Expansion", value: customer.expansionStatus === "none" ? "—" : customer.expansionStatus }
              ]}
            />
          </div>
        </section>

        <section aria-label="Subscriptions" className="glass p-5">
          <h2 className="text-[15px] font-bold text-ink">Subscriptions</h2>
          <ul className="mt-3 flex flex-col divide-y divide-line-soft">
            {customer.subscriptions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2.5">
                <span className="text-[13.5px] font-semibold text-ink">{s.plan}</span>
                <span className="num font-mono text-[12.5px] text-ink-2">
                  {formatMoney(s.amount)}{s.interval === "unsupported" ? " · cadence unsupported" : s.interval === "month" ? " /mo" : " /yr"} · {s.status}
                </span>
              </li>
            ))}
            {customer.subscriptions.length === 0 ? <li className="py-2 text-[13.5px] text-ink-3">None recorded.</li> : null}
          </ul>
        </section>
      </div>

      <section aria-label="Payment history" className="glass p-5">
        <h2 className="text-[15px] font-bold text-ink">Payment history</h2>
        <div className="mt-3">
          <DataTable
            columns={paymentColumns}
            rows={customer.payments}
            getKey={(p) => p.id}
            caption="Payment history"
            mobileCard={(p) => (
              <Surface level={2} className="flex items-baseline justify-between p-3.5">
                <span className="num font-mono text-[13px]">{formatMoney(p.amount)}</span>
                <Badge tone={p.outcome === "paid" ? "ok" : p.outcome === "failed" ? "err" : "neutral"}>{p.outcome}</Badge>
              </Surface>
            )}
          />
        </div>
      </section>

      <section aria-label="Communication timeline" className="glass p-5">
        <h2 className="text-[15px] font-bold text-ink">Timeline</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-3">Recovery and expansion events for this member (fixtures).</p>
        <div className="mt-4">
          <Timeline
            label="Customer timeline"
            entries={customer.payments.map((p) => ({
              id: p.id,
              at: p.at,
              title: p.outcome === "paid" ? "Payment succeeded"
                : p.outcome === "failed" ? "Payment failed"
                : p.outcome === "refunded" ? "Payment refunded"
                : p.outcome === "open" ? "Invoice open — not yet attempted"
                : "Invoice voided",
              detail: `via ${p.source}`,
              tone: p.outcome === "paid" ? "ok" : p.outcome === "failed" ? "err" : "neutral",
              timeLabel: formatDateTime(p.at)
            }))}
          />
        </div>
      </section>
    </div>
  );
}
