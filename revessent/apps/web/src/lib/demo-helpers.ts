import type { QueryClient } from "@tanstack/react-query";

/** Removes an org's cache slice — used on org switch and demo resets so no
 *  cross-organization data can ever render (Phase 2 §8). */
export function removeOrgCache(queryClient: QueryClient, slug: string) {
  queryClient.removeQueries({ queryKey: ["org", slug] });
}
