"use client";

import { useParams } from "next/navigation";
import { useOrgQuery } from "@/lib/queries";
import { AccountView } from "@/views/settings/account-view";

export default function AccountPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data: org } = useOrgQuery(orgSlug);
  if (!org) return null;
  return <AccountView org={org} />;
}
