"use client";

import { useParams } from "next/navigation";
import { useOrgQuery } from "@/lib/queries";
import { OverviewView } from "@/views/overview-view";

export default function OverviewPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data: org } = useOrgQuery(orgSlug);
  if (!org) return null;
  return <OverviewView org={org} />;
}
