"use client";

import { useParams } from "next/navigation";
import { BillingView } from "@/views/settings/billing-view";

export default function SettingsBillingPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <BillingView orgSlug={orgSlug} />;
}
