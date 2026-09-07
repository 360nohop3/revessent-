import { z } from "zod";
/**
 * Real API client (Phase 3) — implements the SAME ApiClient interface the
 * Phase 2 mock implements, against the /api/v1 backend. Every response is
 * validated with the Phase 2 Zod schemas (§9: validated outputs); errors are
 * RFC 9457 problem+json surfaced as ApiError. No demo namespace exists here.
 */
import { ApiError, type ApiClient, type CaseFilters, type CustomerFilters, type DraftAction, type Paged } from "../api";
import {
  OrgSchema, OverviewSchema, RecoveryCaseSchema, TimelineEntrySchema, OpportunitySchema,
  CustomerSchema, StripeConnectionSchema, RetryPolicySchema, VoiceProfileSchema, SyncResponseSchema,
  TeamMemberSchema, BillingInfoSchema, EntitlementsSchema, RecoveryTokenSchema, RecoveryCheckoutStartSchema, UpgradeTokenSchema,
  MessageDraftSchema, RecoveryExecutionSchema } from "../schemas";

async function parseProblem(res: Response): Promise<never> {
  let problem: { type?: string; title?: string; status?: number; detail?: string };
  try {
    problem = (await res.json()) as typeof problem;
  } catch {
    problem = { type: "/errors/internal", title: "Request failed", status: res.status };
  }
  throw new ApiError({
    type: problem.type ?? "/errors/internal",
    title: problem.title ?? "Request failed",
    status: problem.status ?? res.status,
    detail: problem.detail
  });
}

async function getJson<T extends z.ZodTypeAny>(url: string, schema: T): Promise<z.infer<T>> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) await parseProblem(res);
  return schema.parse(await res.json());
}

async function sendJson<T extends z.ZodTypeAny>(url: string, method: string, body: unknown, schema: T): Promise<z.infer<T>> {
  const res = await fetch(url, {
    method, credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) await parseProblem(res);
  if (res.status === 204) return undefined as z.infer<T>;
  return schema.parse(await res.json());
}

const PagedCases = z.object({ items: z.array(RecoveryCaseSchema), nextCursor: z.string().nullable() });
const PagedOpportunities = z.object({ items: z.array(OpportunitySchema), nextCursor: z.string().nullable() });
const PagedCustomers = z.object({ items: z.array(CustomerSchema), nextCursor: z.string().nullable() });
const CaseDetail = z.object({ case: RecoveryCaseSchema, timeline: z.array(TimelineEntrySchema) });
const Unsubscribe = z.object({ state: z.enum(["done", "unknown"]) });

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Creates the real client. Same contract, same shapes — different truth source. */
export function createRealApi(): ApiClient {
  const org = (slug: string) => `/api/v1/orgs/${encodeURIComponent(slug)}`;
  return {
    orgs: { get: (slug) => getJson(`${org(slug)}`, OrgSchema) },
    overview: (slug) => getJson(`${org(slug)}/overview`, OverviewSchema),

    recovery: {
      list: (slug, filters: CaseFilters) => getJson(`${org(slug)}/recovery/cases${qs({ status: filters.status, q: filters.q, cursor: filters.cursor ?? undefined })}`, PagedCases),
      get: (slug, caseId) => getJson(`${org(slug)}/recovery/cases/${encodeURIComponent(caseId)}`, CaseDetail),
      draft: (slug, caseId, draftId, action: DraftAction) =>
        sendJson(`${org(slug)}/recovery/cases/${encodeURIComponent(caseId)}/drafts/${encodeURIComponent(draftId)}`, "POST", action, MessageDraftSchema),
      executeRetry: (slug, caseId, input) =>
        sendJson(`${org(slug)}/recovery/cases/${encodeURIComponent(caseId)}/retry`, "POST", input, RecoveryExecutionSchema)
    },

    expansion: {
      list: (slug) => getJson(`${org(slug)}/expansion/opportunities`, PagedOpportunities),
      get: (slug, id) => getJson(`${org(slug)}/expansion/opportunities/${encodeURIComponent(id)}`, OpportunitySchema),
      draft: (slug, id, _draftId, action: DraftAction) =>
        sendJson(`${org(slug)}/expansion/opportunities/${encodeURIComponent(id)}/draft`, "POST", action, MessageDraftSchema),
      dismiss: (slug, id) =>
        sendJson(`${org(slug)}/expansion/opportunities/${encodeURIComponent(id)}/dismiss`, "POST", undefined, z.object({ dismissed: z.literal(true) }))
    },

    customers: {
      list: (slug, filters: CustomerFilters) => getJson(`${org(slug)}/customers${qs({ status: filters.status, q: filters.q, cursor: filters.cursor ?? undefined })}`, PagedCustomers),
      get: (slug, id) => getJson(`${org(slug)}/customers/${encodeURIComponent(id)}`, CustomerSchema)
    },

    settings: {
      stripe: (slug) => getJson(`${org(slug)}/settings/stripe`, StripeConnectionSchema),
      stripeConnect: (slug, key) => sendJson(`${org(slug)}/settings/stripe/keys`, "POST", { key }, StripeConnectionSchema),
      stripeDisconnect: (slug) => sendJson(`${org(slug)}/settings/stripe`, "DELETE", undefined, StripeConnectionSchema),
      sync: (slug) => sendJson(`${org(slug)}/settings/stripe/sync`, "POST", undefined, SyncResponseSchema),
      reconcile: (slug) => sendJson(`${org(slug)}/settings/stripe/reconcile`, "POST", undefined, SyncResponseSchema),
      policy: (slug) => getJson(`${org(slug)}/settings/policy`, RetryPolicySchema),
      savePolicy: (slug, policy) => sendJson(`${org(slug)}/settings/policy`, "PUT", policy, RetryPolicySchema),
      voice: (slug) => getJson(`${org(slug)}/settings/voice`, VoiceProfileSchema),
      saveVoice: (slug, voice) => sendJson(`${org(slug)}/settings/voice`, "PUT", voice, VoiceProfileSchema),
      team: (slug) => getJson(`${org(slug)}/settings/team`, z.array(TeamMemberSchema)),
      invite: (slug, input) => sendJson(`${org(slug)}/settings/team/invitations`, "POST", input,
        z.object({ invited: z.literal(true), emailSent: z.literal(false), team: z.array(TeamMemberSchema) })),
      billing: (slug) => getJson(`${org(slug)}/settings/billing`, BillingInfoSchema),
      entitlements: (slug) => getJson(`${org(slug)}/entitlements`, EntitlementsSchema)
    },

    subscriber: {
      recoveryToken: (token) => getJson(`/api/v1/c/${encodeURIComponent(token)}`, RecoveryTokenSchema),
      startRecoveryCheckout: (token) => sendJson(`/api/v1/c/${encodeURIComponent(token)}`, "POST", {}, RecoveryCheckoutStartSchema),
      upgradeToken: (token) => getJson(`/api/v1/upgrade/${encodeURIComponent(token)}`, UpgradeTokenSchema),
      unsubscribe: (token) => sendJson(`/api/v1/unsubscribe/${encodeURIComponent(token)}`, "POST", undefined, Unsubscribe)
    }
  } satisfies ApiClient;
}

export type { Paged };
