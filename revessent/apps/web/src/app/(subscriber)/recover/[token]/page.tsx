import { redirect } from "next/navigation";

/**
 * Phase 2 correction (brief §19): "/c/[token]" is the canonical recovery URL
 * (product contract). This legacy path redirects and must never become a
 * competing canonical route.
 */
export default async function RecoverRedirect({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  redirect(`/c/${encodeURIComponent(token)}`);
}
