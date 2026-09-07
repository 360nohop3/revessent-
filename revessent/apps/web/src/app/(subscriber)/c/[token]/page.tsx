import type { Metadata } from "next";
import { RecoveryTokenView } from "@/views/recovery-token-view";

export const metadata: Metadata = { title: "Update your card" };

export default function RecoverTokenPage() {
  return <RecoveryTokenView />;
}
