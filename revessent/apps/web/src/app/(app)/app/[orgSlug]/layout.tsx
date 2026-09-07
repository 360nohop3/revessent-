"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode } from "react";
import { ErrorState, Skeleton } from "@revessent/ui";
import { useOrgQuery } from "@/lib/queries";
import { useSession } from "@/components/session";
import { AppShell } from "@/components/shell/app-shell";

export default function OrgLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ orgSlug: string }>();
  const slug = params.orgSlug;
  const session = useSession();
  const { data: org, isLoading, error, refetch } = useOrgQuery(slug);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8">
        <div className="flex w-[min(560px,100%)] flex-col gap-3" role="status" aria-label="Loading workspace">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (error || !org) {
    return (
      <div className="mx-auto w-[min(560px,100%)] p-8">
        <ErrorState
          title={error instanceof Error && /Unknown demo org/.test(error.message) ? "Workspace not found" : "Couldn't load this workspace"}
          message={
            error instanceof Error && /Unknown demo org/.test(error.message)
              ? `No workspace "${slug}" exists in the demo fixtures. Try Acorn Books from the account switcher.`
              : "The workspace failed to load. Nothing is broken on your side — retry, or return to the overview."
          }
          onRetry={() => void refetch()}
        />
        <div className="mt-4 text-center">
          <Link href="/app" className="btn btn-glass btn-sm">All workspaces</Link>
        </div>
      </div>
    );
  }

  const membership = session.memberships.find((m) => m.slug === slug);
  const rawRole = membership?.role ?? "viewer";
  const role = rawRole === "owner" || rawRole === "admin" || rawRole === "operator" || rawRole === "viewer" ? rawRole : "viewer";

  return (
    <AppShell org={org} role={role}>
      {children}
    </AppShell>
  );
}
