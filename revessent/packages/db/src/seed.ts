/**
 * DEV/TEST SEED ONLY (brief §21: seed data only in development/test).
 * Mirrors the Phase 2 demo fixtures so the existing UI has real rows to read:
 * Acorn Books (connected, owner Priya + operator Hana + viewer Marcus) and
 * Fernbrook Studio (no Stripe connection, viewer role for Priya).
 * Run: MIGRATE_DATABASE_URL=... node --experimental-strip-types src/seed.ts
 * Guarded: refuses to run unless RVS_SEED_ALLOWED=1 (set by dev/test tooling).
 */
import { createHash } from "node:crypto";
import { createDb, withIdentityTx } from "./client.ts";
import * as s from "./schema.ts";
import { sql } from "drizzle-orm";

if (process.env.RVS_SEED_ALLOWED !== "1") {
  throw new Error("Seed refused: set RVS_SEED_ALLOWED=1 (dev/test only).");
}

const db = createDb(process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? "");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const now = Date.now();

async function upsertUser(email: string, name: string, opts?: { verified?: boolean }): Promise<NonNullable<Awaited<ReturnType<typeof insertUser>>>> {
  const existing = await db.select().from(s.user).where(sql`${s.user.email} = ${email}`);
  if (existing.length) return existing[0]!;
  return insertUser({ name, email, emailVerified: opts?.verified ?? true });
}
async function insertUser(values: { name: string; email: string; emailVerified: boolean }) {
  const row = (await db.insert(s.user).values(values).returning())[0];
  if (!row) throw new Error("user insert failed");
  return row;
}

const priya = await upsertUser("priya@acornbooks.example", "Priya Anand");
const hana = await upsertUser("hana@acornbooks.example", "Hana Ito");
const marcus = await upsertUser("marcus@acornbooks.example", "Marcus Reed");
const maya = await upsertUser("maya@fernbrook.example", "Maya Chen");

const existingOrgs = await db.select().from(s.organizations);
if (existingOrgs.length) {
  console.log("seed: organizations already present — skipping (idempotent)");
  process.exit(0);
}

// ---------- Acorn Books (connected workspace) ----------
const acorn = (await db.insert(s.organizations).values({
  name: "Acorn Books", slug: "acorn-books", plan: "revessent", timezone: "America/New_York",
  pilotStartedAt: new Date(now - 30 * DAY), pilotEndsAt: new Date(now + 14 * DAY), trustLevel: 0
}).returning())[0]!;

for (const pair of [[priya, "owner"], [hana, "operator"], [marcus, "viewer"]] as const) {
  const u = pair[0]!;
  const role = pair[1];
  await withIdentityTx(db, u.id, (tx) => tx.insert(s.memberships).values({ orgId: acorn.id, userId: u.id, role }));
}

// Billing mirror: customers → subscriptions → payments → cases → messages
const custRows = [
  { stripe: "cus_demo_zoe", name: "Zoe Park", email: "zoe.park@example.com", mrr: 4900, status: "past_due", country: "US", cur: "USD" },
  { stripe: "cus_demo_liam", name: "Liam Osei", email: "liam.osei@example.com", mrr: 9900, status: "active", country: "GB", cur: "USD" },
  { stripe: "cus_demo_amara", name: "Amara Obi", email: "amara.obi@example.com", mrr: 12900, status: "active", country: "NG", cur: "USD" },
  { stripe: "cus_demo_noah", name: "Noah Berg", email: "noah.berg@example.com", mrr: 2900, status: "active", country: "DE", cur: "USD" }
].map((c) => ({
  orgId: acorn.id, stripeCustomerId: c.stripe, name: c.name, email: c.email, mrrCents: c.mrr,
  status: c.status, country: c.country, currency: c.cur,
  defaultPayment: { brand: "visa", last4: "4242", exp_month: 9, exp_year: 2027, network_token: c.stripe === "cus_demo_zoe" },
  stripeCreatedAt: new Date(now - 200 * DAY)
}));
const customers = await db.insert(s.customers).values(custRows).returning();
const zoe = customers[0]!;

const zoeSub = (await db.insert(s.subscriptions).values({
  orgId: acorn.id, customerId: zoe.id, stripeSubscriptionId: "sub_demo_zoe_1",
  stripePriceId: "price_demo_pro_m", status: "past_due", amountCents: 4900, currency: "USD",
  interval: "month", currentPeriodEnd: new Date(now + 11 * DAY)
}).returning())[0]!;

const zoePayment = (await db.insert(s.payments).values({
  orgId: acorn.id, customerId: zoe.id, subscriptionId: zoeSub.id,
  stripeInvoiceId: "in_demo_zoe_0912", stripePaymentIntentId: "pi_demo_zoe_0912",
  amountCents: 4900, currency: "USD", status: "failed", attemptedCount: 1,
  declineCode: "insufficient_funds", declineMessage: "The card was declined: insufficient funds.",
  networkTokenAvailable: true, periodStart: new Date(now - 2 * DAY), periodEnd: new Date(now + 28 * DAY),
  failedAt: new Date(now - 2 * DAY + 3 * HOUR)
}).returning())[0]!;

const zoeCase = (await db.insert(s.recoveryCases).values({
  orgId: acorn.id, customerId: zoe.id, subscriptionId: zoeSub.id, paymentId: zoePayment.id,
  status: "contacting", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
  amountCents: 4900, currency: "USD", firstFailedAt: new Date(now - 2 * DAY + 3 * HOUR),
  nextActionAt: new Date(now + 26 * HOUR), attemptNo: 1
}).returning())[0]!;

await db.insert(s.recoveryAttempts).values({
  caseId: zoeCase.id, orgId: acorn.id, kind: "auto_retry", status: "failed", declineCode: "insufficient_funds", policyVersion: 1,
  executedAt: new Date(now - 2 * DAY + 3 * HOUR), idempotencyKey: `rv:${acorn.id}:${zoeCase.id}:1`
});

const zoeMessage = (await db.insert(s.recoveryMessages).values({
  caseId: zoeCase.id, orgId: acorn.id,
  subject: "Quick help with your Acorn Books payment",
  body: "Hi Zoe — your last payment didn't go through, and we paused shipments rather than retry blindly. You can update your card in about 30 seconds and nothing else changes.",
  approvalStatus: "awaiting_approval"
}).returning())[0]!;

// Public /c/{token} records — SHA-256 of the well-known dev tokens (§7.2:
// hash stored only). In dev these mirror the Phase 2 demo tokens so the
// subscriber pages have real rows; production generates fresh tokens.
const tokenRows: Array<[string, "open" | "completed" | "expired"]> = [
  ["tok_demo_valid", "open"],
  ["tok_demo_used", "completed"],
  ["tok_demo_expired", "expired"]
];
for (const [tok, status] of tokenRows) {
  const hash = createHash("sha256").update(tok).digest("hex");
  await db.insert(s.recoveryCheckouts).values({
    caseId: zoeCase.id, tokenHash: hash, status,
    expiresAt: new Date(now + (status === "expired" ? -1 * DAY : 14 * DAY)),
    completedAt: status === "completed" ? new Date(now - 5 * HOUR) : null
  });
}

// history audit rows for the draft (append-only)
await db.insert(s.auditLogs).values({
  orgId: acorn.id, actorId: hana.id, actorKind: "user", action: "message.submitted",
  targetType: "recovery_message", targetId: zoeMessage.id,
  diff: { approvalStatus: ["draft", "awaiting_approval"] }, userAgent: "seed"
});

// a recovered case (attribution ledger row proves recovered ≠ potential)
const liamPayment = (await db.insert(s.payments).values({
  orgId: acorn.id, customerId: customers[1]!.id,
  stripeInvoiceId: "in_demo_liam_0901", amountCents: 9900, currency: "USD",
  status: "paid", attemptedCount: 2, paidAt: new Date(now - 9 * DAY),
  failedAt: new Date(now - 10 * DAY), declineCode: "expired_card"
}).returning())[0]!;
const liamCase = (await db.insert(s.recoveryCases).values({
  orgId: acorn.id, customerId: customers[1]!.id, paymentId: liamPayment.id,
  status: "recovered", declineCode: "expired_card", declineCategory: "expired_card",
  amountCents: 9900, currency: "USD", firstFailedAt: new Date(now - 10 * DAY),
  recoveredCents: 9900, closedAt: new Date(now - 9 * DAY), closedReason: null, attemptNo: 2
}).returning())[0]!;
await db.insert(s.recoveryAttributions).values({
  orgId: acorn.id, caseId: liamCase.id, customerId: customers[1]!.id, paymentId: liamPayment.id,
  source: "retry", amountCents: 9900, withinWindow: true, policySnapshot: { version: 1 }
});

// expansion signal → opportunity with draft
const signal = (await db.insert(s.expansionSignals).values({
  orgId: acorn.id, customerId: customers[2]!.id, kind: "usage_limit",
  payload: { seatsUsed: 12, seatsIncluded: 10 }
}).returning())[0]!;
await db.insert(s.expansionOpportunities).values({
  orgId: acorn.id, customerId: customers[2]!.id, signalId: signal.id,
  currentPriceId: "price_demo_starter_m", recommendedPriceId: "price_demo_pro_m",
  potentialMrrCents: 8000, rationale: "12 active seats on a 10-seat Starter plan for 3 weeks.",
  draftSubject: "More room for your team?", draftBody: "Hi Amara — your team outgrew Starter seats this month. Pro covers 15 seats and keeps your history intact.",
  draftStatus: "awaiting_approval", status: "awaiting_approval"
});

// settings
await db.insert(s.retryPolicies).values({
  orgId: acorn.id, version: 1, createdBy: priya.id,
  rules: { maxAutoRetries: 3, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 48, noteAfterFailedRetries: 1, checkoutAfterNote: true }
});
await db.insert(s.voiceProfiles).values({
  orgId: acorn.id, sampleText: "We paused shipments rather than retry blindly.",
  styleSummary: "Short, warm, no urgency theater.", greeting: "Hi {{first_name}} —", signoff: "— Acorn Books"
});
await db.insert(s.orgSubscriptions).values({
  orgId: acorn.id, plan: "revessent", status: "trialing",
  guaranteeStartedAt: new Date(now - 30 * DAY), guaranteeEndsAt: new Date(now + 60 * DAY)
});

// Stripe connection — restricted key stored envelope-encrypted is Phase 4's sync
// concern for the SECRET; Phase 3 stores the row with an empty-format marker the
// service layer rejects reads of. Seed uses a placeholder ciphertext for dev only.
await db.insert(s.stripeConnections).values({
  orgId: acorn.id, mode: "test", stripeAccountId: "acct_demo_acorn",
  keyCiphertext: "seed:placeholder-not-a-key", keyLast4: "k_test_…9f2a",
  scopes: { read: ["customers", "charges", "invoices"] }, status: "active"
});

console.log("seed: acorn-books + fixtures written");

// ---------- Fernbrook Studio (disconnected workspace) ----------
const fern = (await db.insert(s.organizations).values({
  name: "Fernbrook Studio", slug: "fernbrook", plan: "ember", timezone: "America/Los_Angeles"
}).returning())[0]!;
for (const pair of [[priya, "viewer"], [maya, "owner"]] as const) {
  const u = pair[0]!;
  const role = pair[1];
  await withIdentityTx(db, u.id, (tx) => tx.insert(s.memberships).values({ orgId: fern.id, userId: u.id, role }));
}
await db.insert(s.orgSubscriptions).values({ orgId: fern.id, plan: "ember", status: "trialing" });
console.log("seed: fernbrook written (no Stripe connection, no fixtures)");
