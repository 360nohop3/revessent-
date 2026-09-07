import type { Metadata } from "next";
import { UpgradeTokenView } from "@/views/upgrade-token-view";

export const metadata: Metadata = { title: "Plan upgrade" };

export default function UpgradeTokenPage() {
  return <UpgradeTokenView />;
}
