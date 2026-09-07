"use client";

import { useParams } from "next/navigation";
import { VoiceView } from "@/views/settings/voice-view";

export default function SettingsMessagingPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <VoiceView orgSlug={orgSlug} />;
}
