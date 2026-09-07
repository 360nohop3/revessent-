"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { PLANS } from "@revessent/domain";
import type { Org } from "@revessent/contracts";
import { useSession } from "@/components/session";

/**
 * Organization switcher. Switching orgs navigates and REMOVES the previous
 * org's cache slice (every org-scoped query is keyed under ["org", slug], so
 * data never leaks across organizations — Phase 2 §8).
 */
export function OrgSwitcher({ current }: { current: Org }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();

  function switchTo(slug: string) {
    if (slug === current.slug) return;
    queryClient.removeQueries({ queryKey: ["org", current.slug] });
    router.push(`/app/${slug}/overview`);
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        className="flex max-w-[220px] items-center gap-2 rounded-full border border-edge bg-well/50 px-3.5 py-1.5 text-[13.5px] font-semibold text-ink hover:bg-well/80"
      >
        <span className="truncate">{current.name}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={8} className="glass glass-3 z-50 min-w-[240px] p-1.5">
          <p className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[.07em] text-ink-4">Workspaces</p>
          <DropdownMenu.RadioGroup value={current.slug} onValueChange={switchTo}>
            {session.memberships.map((m) => (
              <DropdownMenu.RadioItem
                key={m.slug}
                value={m.slug}
                className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-[13.5px] text-ink outline-none data-[highlighted]:bg-well/70"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{m.name}</span>
                  <span className="text-[11.5px] text-ink-3">
                    {PLANS[(m.plan in PLANS ? m.plan : "ember") as keyof typeof PLANS].label} plan · {m.role}
                  </span>
                </span>
                <span className="text-[12px] text-accent-ink">{current.slug === m.slug ? "✓" : ""}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Item
            onSelect={() => router.push("/onboarding")}
            className="mt-1 cursor-pointer rounded-xl border-t border-line-soft px-3 py-2 text-[13px] text-ink-3 outline-none data-[highlighted]:bg-well/70"
          >
            + New workspace
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
