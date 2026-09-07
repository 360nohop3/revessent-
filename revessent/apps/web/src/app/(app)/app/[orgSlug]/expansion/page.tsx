"use client";

import { useParams } from "next/navigation";
import { ExpansionListView } from "@/views/expansion-list-view";

export default function ExpansionPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <ExpansionListView orgSlug={orgSlug} />;
}
