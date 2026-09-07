"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ApiClient } from "@revessent/contracts";
import { qk } from "@revessent/contracts";
import { api } from "@/lib/api";

export function useOrgQuery(slug: string): UseQueryResult<Awaited<ReturnType<ApiClient["orgs"]["get"]>>> {
  return useQuery({ queryKey: qk.org(slug), queryFn: () => api.orgs.get(slug) });
}

export function useOverview(slug: string) {
  return useQuery({ queryKey: qk.overview(slug), queryFn: () => api.overview(slug) });
}

export function useStripeConnection(slug: string) {
  return useQuery({ queryKey: qk.stripe(slug), queryFn: () => api.settings.stripe(slug) });
}

export function useCases(slug: string, filters: { status?: string; q?: string }) {
  return useQuery({
    queryKey: qk.cases(slug, filters),
    queryFn: () => api.recovery.list(slug, filters),
    placeholderData: (prev) => prev
  });
}

export function useCase(slug: string, caseId: string) {
  return useQuery({ queryKey: qk.case(slug, caseId), queryFn: () => api.recovery.get(slug, caseId) });
}

export function useOpportunities(slug: string) {
  return useQuery({ queryKey: qk.opportunities(slug), queryFn: () => api.expansion.list(slug) });
}

export function useOpportunity(slug: string, id: string) {
  return useQuery({ queryKey: qk.opportunity(slug, id), queryFn: () => api.expansion.get(slug, id) });
}

export function useCustomers(slug: string, filters: { q?: string; status?: string }) {
  return useQuery({
    queryKey: qk.customers(slug, filters),
    queryFn: () => api.customers.list(slug, filters),
    placeholderData: (prev) => prev
  });
}

export function useCustomer(slug: string, id: string) {
  return useQuery({ queryKey: qk.customer(slug, id), queryFn: () => api.customers.get(slug, id) });
}

export function useTeam(slug: string) {
  return useQuery({ queryKey: qk.team(slug), queryFn: () => api.settings.team(slug) });
}

export function usePolicy(slug: string) {
  return useQuery({ queryKey: qk.policy(slug), queryFn: () => api.settings.policy(slug) });
}

export function useVoice(slug: string) {
  return useQuery({ queryKey: qk.voice(slug), queryFn: () => api.settings.voice(slug) });
}

export function useBilling(slug: string) {
  return useQuery({ queryKey: qk.billing(slug), queryFn: () => api.settings.billing(slug) });
}
