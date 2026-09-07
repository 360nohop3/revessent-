import { relations } from "drizzle-orm";
import * as s from "./schema.ts";

export const organizationsRelations = relations(s.organizations, ({ many, one }) => ({
  memberships: many(s.memberships),
  customers: many(s.customers),
  cases: many(s.recoveryCases),
  opportunities: many(s.expansionOpportunities),
  connections: many(s.stripeConnections),
  policies: many(s.retryPolicies),
  voice: one(s.voiceProfiles),
  billing: one(s.orgSubscriptions),
  audit: many(s.auditLogs)
}));

export const membershipsRelations = relations(s.memberships, ({ one }) => ({
  org: one(s.organizations, { fields: [s.memberships.orgId], references: [s.organizations.id] }),
  user: one(s.user, { fields: [s.memberships.userId], references: [s.user.id] })
}));

export const customersRelations = relations(s.customers, ({ one, many }) => ({
  org: one(s.organizations, { fields: [s.customers.orgId], references: [s.organizations.id] }),
  subscriptions: many(s.subscriptions),
  payments: many(s.payments)
}));

export const subscriptionsRelations = relations(s.subscriptions, ({ one }) => ({
  customer: one(s.customers, { fields: [s.subscriptions.customerId], references: [s.customers.id] })
}));

export const paymentsRelations = relations(s.payments, ({ one, many }) => ({
  customer: one(s.customers, { fields: [s.payments.customerId], references: [s.customers.id] }),
  attempts: many(s.paymentAttempts)
}));

export const recoveryCasesRelations = relations(s.recoveryCases, ({ one, many }) => ({
  customer: one(s.customers, { fields: [s.recoveryCases.customerId], references: [s.customers.id] }),
  payment: one(s.payments, { fields: [s.recoveryCases.paymentId], references: [s.payments.id] }),
  attempts: many(s.recoveryAttempts),
  messages: many(s.recoveryMessages),
  checkouts: many(s.recoveryCheckouts)
}));

export const recoveryMessagesRelations = relations(s.recoveryMessages, ({ one }) => ({
  case: one(s.recoveryCases, { fields: [s.recoveryMessages.caseId], references: [s.recoveryCases.id] })
}));

export const expansionOpportunitiesRelations = relations(s.expansionOpportunities, ({ one }) => ({
  customer: one(s.customers, { fields: [s.expansionOpportunities.customerId], references: [s.customers.id] }),
  signal: one(s.expansionSignals, { fields: [s.expansionOpportunities.signalId], references: [s.expansionSignals.id] })
}));
