import type { Metadata } from "next";
import { Suspense } from "react";
import { SkeletonCard } from "@revessent/ui";
import { PricingView } from "@/views/pricing-view";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto grid w-[min(1120px,100%-48px)] gap-4 py-16 md:grid-cols-3">
          <SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
      }
    >
      <PricingView />
    </Suspense>
  );
}
