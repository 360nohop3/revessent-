import type { Metadata } from "next";
import { UnsubscribeTokenView } from "@/views/unsubscribe-token-view";

export const metadata: Metadata = { title: "Unsubscribe" };

export default function UnsubscribeTokenPage() {
  return <UnsubscribeTokenView />;
}
