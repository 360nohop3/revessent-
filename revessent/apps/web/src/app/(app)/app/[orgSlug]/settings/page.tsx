"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useParams } from "next/navigation";

export default function SettingsIndex() {
  const router = useRouter();
  const params = useParams<{ orgSlug: string }>();
  useEffect(() => {
    router.replace(`/app/${params.orgSlug}/settings/account`);
  }, [router, params.orgSlug]);
  return <p role="status" className="text-[13.5px] text-ink-3">Opening account settings…</p>;
}
