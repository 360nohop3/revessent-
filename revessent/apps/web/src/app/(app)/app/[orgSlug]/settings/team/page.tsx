"use client";

import { useParams } from "next/navigation";
import { TeamView } from "@/views/settings/team-view";

export default function SettingsTeamPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <TeamView orgSlug={orgSlug} />;
}
