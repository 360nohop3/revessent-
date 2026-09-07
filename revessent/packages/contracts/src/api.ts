import type {
  BillingInfo, Customer, MessageDraft, Opportunity, Org,
  Overview, Problem, RecoveryCase, RecoveryTokenInfo, RetryPolicy,
  StripeConnection, TeamMember, TimelineEntry, UpgradeTokenInfo, VoiceProfile, Role
} from "./schemas";
import type { RecoveryExecution } from "./schemas";
import type { ApprovalEvent, ApprovalStatus } from "@revessent/domain";

export interface CaseFilters { status?: string; q?: string; cursor?: string | null }
export interface CustomerFilters { q?: string; status?: string; cursor?: string | null }
export interface Paged<T> { items: T[]; nextCursor: string | null }

/** Draft mutations the UI may request. Each maps 1:1 to a domain ApprovalEvent. */
export type DraftAction = Extract<ApprovalEvent, { type: "submit" | "approve" | "cancel" }> | { type: "edit"; subject: string; body: string; actor: string };

/** Demo-only provider simulation events. The REAL confirmations arrive as
 *  provider webhooks in Phase 5 — never from a browser click. */
export type DemoProviderAction =
  | { type: "demo.execution_started" }
  | { type: "demo.provider_pending" }
  | { type: "demo.provider_confirmed"; providerRef: string }
  | { type: "demo.provider_failed"; reason: string };

export interface ApiClient {
  orgs: {
    get(slug: string): Promise<Org>;
  };
  overview(slug: string): Promise<Overview>;

  recovery: {
    list(slug: string, filters: CaseFilters): Promise<Paged<RecoveryCase>>;
    get(slug: string, caseId: string): Promise<{ case: RecoveryCase; timeline: TimelineEntry[] }>;
    draft(slug: string, caseId: string, draftId: string, action: DraftAction): Promise<MessageDraft>;
    /** Phase 4C: EXPLICIT manual retry — one idempotent payment execution. */
    executeRetry(slug: string, caseId: string, input?: { idempotencyKey?: string }): Promise<RecoveryExecution>;
  };

  expansion: {
    list(slug: string): Promise<Paged<Opportunity>>;
    get(slug: string, id: string): Promise<Opportunity>;
    draft(slug: string, id: string, draftId: string, action: DraftAction): Promise<MessageDraft>;
    dismiss(slug: string, id: string): Promise<{ dismissed: true }>;
  };

  customers: {
    list(slug: string, filters: CustomerFilters): Promise<Paged<Customer>>;
    get(slug: string, id: string): Promise<Customer>;
  };

  settings: {
    stripe(slug: string): Promise<StripeConnection>;
    /** Demo: records the intent + validates key FORMAT only. No key is stored or sent anywhere. */
    stripeConnect(slug: string, key: string): Promise<StripeConnection>;
    stripeDisconnect(slug: string): Promise<StripeConnection>;
    /** Phase 4A: manual read-only sync. */
    sync(slug: string): Promise<{ started: true; connection: StripeConnection; summary: Record<string, { status: string; pages: number; upserted: number; anomalies: number; errorCode: string | null }> }>;
    /** Phase 4B: deeper read-only reconciliation pass (also resolves failed webhook events). */
    reconcile(slug: string): Promise<{ started: true; connection: StripeConnection; summary: Record<string, { status: string; pages: number; upserted: number; anomalies: number; errorCode: string | null }> }>;
    policy(slug: string): Promise<RetryPolicy>;
    savePolicy(slug: string, policy: RetryPolicy): Promise<RetryPolicy>;
    voice(slug: string): Promise<VoiceProfile>;
    saveVoice(slug: string, voice: VoiceProfile): Promise<VoiceProfile>;
    team(slug: string): Promise<TeamMember[]>;
    invite(slug: string, input: { email: string; role: Role }): Promise<{ invited: true; emailSent: boolean; team: TeamMember[] }>;
    billing(slug: string): Promise<BillingInfo>;
  };

  subscriber: {
    recoveryToken(token: string): Promise<RecoveryTokenInfo>;
    upgradeToken(token: string): Promise<UpgradeTokenInfo>;
    unsubscribe(token: string): Promise<{ state: "done" | "unknown" }>;
  };
}

export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }
}

export function statusForDraftAction(action: DraftAction): { from: ApprovalStatus[]; event: ApprovalEvent } {
  switch (action.type) {
    case "submit": return { from: ["draft"], event: { type: "submit" } };
    case "approve": return { from: ["awaiting_approval"], event: { type: "approve", actor: action.actor } };
    case "cancel": return { from: ["draft", "awaiting_approval", "approved", "queued"], event: { type: "cancel", actor: action.actor } };
    case "edit": return { from: ["draft", "awaiting_approval", "approved"], event: { type: "edit" } };
  }
}

/** Type-level names for demo provider simulation actions (see DemoProviderAction). */
export type DemoProviderActionType =
  | "demo.execution_started"
  | "demo.provider_pending"
  | "demo.provider_confirmed"
  | "demo.provider_failed";
export interface DemoProviderActionInput {
  type: DemoProviderActionType;
  providerRef?: string;
  reason?: string;
}
