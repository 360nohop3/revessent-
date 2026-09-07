import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@revessent/ui";
import { SignInView } from "@/views/sign-in-view";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[380px] w-full" />}>
      <SignInView />
    </Suspense>
  );
}
