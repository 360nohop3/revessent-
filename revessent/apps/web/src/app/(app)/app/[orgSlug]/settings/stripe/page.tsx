"use client";

import { useParams } from "next/navigation";
import { StripeView } from "@/views/settings/stripe-view";

export default function SettingsStripePage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <StripeView orgSlug={orgSlug} />;
}
