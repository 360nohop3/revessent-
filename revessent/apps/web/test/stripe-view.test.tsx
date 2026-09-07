import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getMockApi, qk } from "@revessent/contracts";
import type { StripeConnection } from "@revessent/contracts";
import { StripeView } from "@/views/settings/stripe-view";
import { renderWithProviders, makeQc, DEMO_SESSION } from "./utils";
import type { DemoSession } from "@revessent/contracts";

const slug = "acorn-books";

describe("stripe settings view — honest states (§10/§20)", () => {
  beforeEach(() => {
    getMockApi().demo.store().reset();
  });

  it("connected (read-only): badge, provider identity, last-4 only, sync freshness + Sync button", async () => {
    renderWithProviders(<StripeView orgSlug={slug} />);
    expect(await screen.findByText(/connected · read-only/i)).toBeTruthy();
    expect(screen.getByText(/acct_demo_acorn/i)).toBeTruthy();
    expect(screen.getByText(/b3x1 \(stored encrypted\)/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /sync now/i })).toBeTruthy();
    expect(screen.getAllByText(/fresh/i).length).toBeGreaterThanOrEqual(3);
    // read-only: no fabricated retry/write claims
    expect(screen.getByText(/none — read-only/i)).toBeTruthy();
  });

  it("Phase 4B: webhook delivery status is honest — configured, last delivery, no failures", async () => {
    renderWithProviders(<StripeView orgSlug={slug} />);
    const block = await screen.findByTestId("webhook-status");
    expect(block.textContent).toContain("configured");
    expect(block.textContent).toContain("we_demo_acorn");
    expect(block.textContent).not.toContain("Failed events"); // zero failures → no failure row
    expect(block.textContent).not.toContain("Reconcile with Stripe"); // nothing failed → no reconcile button
  });

  it("Phase 4B: failed webhook events are surfaced with reconciliation, never hidden", async () => {
    const store = getMockApi().demo.store();
    const acorn = (store as unknown as { orgs: Map<string, { connection: StripeConnection }> })
      .orgs.get(slug)!;
    acorn.connection = {
      ...acorn.connection,
      webhooks: {
        configured: true, endpointId: "we_demo_acorn", lastWebhookAt: new Date().toISOString(),
        failed: 2, unprocessed: 0, lastFailureCode: "dependency_missing:customer_not_synced", lastFailureAt: new Date().toISOString()
      }
    };
    renderWithProviders(<StripeView orgSlug={slug} />);
    const block = await screen.findByTestId("webhook-status");
    expect(block.textContent).toContain("2");
    expect(block.textContent).toContain("dependency_missing:customer_not_synced");
    expect(block.textContent).toContain("preserved for reconciliation");
    expect(await screen.findByRole("button", { name: /reconcile with stripe/i })).toBeTruthy();
  });

  it("not connected: explains the need, shows connect form, never claims success", async () => {
    const session: DemoSession = {
      ...DEMO_SESSION,
      memberships: [{ slug: "fernbrook", name: "Fernbrook Studio", role: "owner", plan: "ember" }]
    };
    renderWithProviders(<StripeView orgSlug="fernbrook" />, { session });
    expect(await screen.findByText(/not connected/i)).toBeTruthy();
    expect(screen.getByText(/connect with a restricted key/i)).toBeTruthy();
    expect(screen.getByText(/demo validates the format only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /sync now/i })).toBeNull();
  });

  it("viewer sees the connection but can neither sync nor connect", async () => {
    renderWithProviders(<StripeView orgSlug="fernbrook" />);
    expect(await screen.findByText(/requires an admin or owner role/i)).toBeTruthy();
  });

  it("revoked: explains reconnect requirement and offers the connect form — badge is not 'connected'", async () => {
    const revoked: StripeConnection = {
      status: "revoked", mode: "test", accountRef: "acct_demo_acorn (test mode)",
      lastSyncAt: new Date().toISOString(), backfill: "done",
      keyLast4: "b3x1", displayName: "Acorn Books (demo)", country: "US", defaultCurrency: "USD",
      lastValidatedAt: new Date().toISOString(),
      sync: {
        customers: { status: "stale", lastSuccessAt: new Date().toISOString(), lastAttemptAt: null, errorCode: "revoked" },
        subscriptions: { status: "stale", lastSuccessAt: new Date().toISOString(), lastAttemptAt: null, errorCode: "revoked" },
        invoices: { status: "stale", lastSuccessAt: new Date().toISOString(), lastAttemptAt: null, errorCode: "revoked" }
      }
    };
    const qc = makeQc();
    qc.setQueryData(qk.stripe(slug), revoked);
    renderWithProviders(<StripeView orgSlug={slug} />, { qc });
    expect(await screen.findByText(/revoked — reconnect required/i)).toBeTruthy();
    expect(screen.getByText(/reconnect with a fresh restricted key/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect$/i })).toBeTruthy();
  });

  it("failed sync: shows preserved-data message with safe reason — no fake success, no data wipe", async () => {
    const failed: StripeConnection = {
      status: "read_only", mode: "test", accountRef: "acct_demo_acorn (test mode)",
      lastSyncAt: new Date(Date.now() - 3600_000).toISOString(), backfill: "done",
      keyLast4: "b3x1", displayName: "Acorn Books (demo)", country: "US", defaultCurrency: "USD",
      lastValidatedAt: new Date().toISOString(),
      sync: {
        customers: { status: "failed", lastSuccessAt: new Date(Date.now() - 3600_000).toISOString(), lastAttemptAt: new Date().toISOString(), errorCode: "rate_limited" },
        subscriptions: { status: "fresh", lastSuccessAt: new Date().toISOString(), lastAttemptAt: null, errorCode: null },
        invoices: { status: "stale", lastSuccessAt: new Date(Date.now() - 8 * 3600_000).toISOString(), lastAttemptAt: null, errorCode: null }
      }
    };
    const qc = makeQc();
    qc.setQueryData(qk.stripe(slug), failed);
    renderWithProviders(<StripeView orgSlug={slug} />, { qc });
    expect(await screen.findByText(/failed — previous data preserved/i)).toBeTruthy();
    expect(screen.getByText(/rate-limited the sync/i)).toBeTruthy();
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it("connect submit: the key is never rendered anywhere in the DOM afterwards", async () => {
    const session: DemoSession = {
      ...DEMO_SESSION,
      memberships: [{ slug: "fernbrook", name: "Fernbrook Studio", role: "owner", plan: "ember" }]
    };
    const KEY = "rk_test_0123456789abcdefABCD";
    renderWithProviders(<StripeView orgSlug="fernbrook" />, { session });
    const input = await screen.findByPlaceholderText("rk_test_…");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    // the key leaves the DOM once submission completes (§5 credential hygiene):
    // the connect form unmounts on success and the key is never displayed again
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("rk_test_…")).toBeNull();
    });
    expect(await screen.findByText(/connected · read-only/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });
});
