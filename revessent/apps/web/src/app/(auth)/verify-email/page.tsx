import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyEmailView } from "@/views/verify-email-view";

export const metadata: Metadata = { title: "Verify email" };

export default function Page() {
  return <Suspense fallback={null}><VerifyEmailView /></Suspense>;
}
