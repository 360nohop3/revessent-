import type { Metadata } from "next";
import { StatusPageView } from "@/views/status-page-view";

export const metadata: Metadata = { title: "Status" };

export default function StatusPage() {
  return <StatusPageView />;
}
