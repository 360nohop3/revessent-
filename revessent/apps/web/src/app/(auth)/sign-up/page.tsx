import type { Metadata } from "next";
import { SignUpView } from "@/views/sign-up-view";

export const metadata: Metadata = { title: "Start your free pilot" };

export default function SignUpPage() {
  return <SignUpView />;
}
