"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SkeletonTable } from "@revessent/ui";
import { CustomersListView } from "@/views/customers-list-view";

export default function CustomersPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return (
    <Suspense fallback={<SkeletonTable rows={5} />}>
      <CustomersListView orgSlug={orgSlug} />
    </Suspense>
  );
}
