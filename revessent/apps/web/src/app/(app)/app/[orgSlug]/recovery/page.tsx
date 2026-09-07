"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SkeletonTable } from "@revessent/ui";
import { RecoveryListView } from "@/views/recovery-list-view";

export default function RecoveryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return (
    <Suspense fallback={<SkeletonTable rows={5} />}>
      <RecoveryListView orgSlug={orgSlug} />
    </Suspense>
  );
}
