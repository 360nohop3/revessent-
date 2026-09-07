"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Skeleton, Surface } from "@revessent/ui";

const STATES: Record<string, { title: string; body: string }> = {
  pending: { title: "Waiting on confirmation", body: "The provider hasn't confirmed this yet. Pending is not success — this page will explain the outcome once it's known." },
  failed: { title: "That didn't go through", body: "The provider reported a failure. No payment was taken and nothing was sent. You can safely retry from the original link." },
  "not-available": { title: "Not available in this build", body: "This step needs the backend (Phase 3+). Nothing was executed." }
};

function Inner() {
  const params = useSearchParams();
  const key = params.get("s") ?? "pending";
  const state = STATES[key] ?? STATES["pending"]!;

  return (
    <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
      <h1 className="text-[19px] font-bold text-ink">{state.title}</h1>
      <p className="mt-2 text-[14px] text-ink-2">{state.body}</p>
      <Link href="/" className="btn btn-glass btn-sm mt-5">Back to site</Link>
    </Surface>
  );
}

export function StatusPageView() {
  return (
    <Suspense fallback={<Skeleton className="h-56 w-[min(480px,100%)]" />}>
      <Inner />
    </Suspense>
  );
}
