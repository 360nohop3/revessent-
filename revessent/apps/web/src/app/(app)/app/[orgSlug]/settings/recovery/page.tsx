"use client";

import { useParams } from "next/navigation";
import { RecoveryPolicyView } from "@/views/settings/recovery-policy-view";

export default function SettingsRecoveryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <RecoveryPolicyView orgSlug={orgSlug} />;
}
