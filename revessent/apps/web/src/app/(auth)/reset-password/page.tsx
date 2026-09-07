import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordView } from "@/views/reset-password-view";

export const metadata: Metadata = { title: "Reset password" };

export default function Page() {
  return <Suspense fallback={null}><ResetPasswordView /></Suspense>;
}
