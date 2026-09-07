import type { Metadata } from "next";
import { OnboardingView } from "@/views/onboarding-view";

export const metadata: Metadata = { title: "Set up your workspace" };

export default function OnboardingPage() {
  return <OnboardingView />;
}
