"use client";

import { PLANS } from "@revessent/domain";
import { EvidenceList, Surface } from "@revessent/ui";
import { useSession } from "@/components/session";
import type { Org } from "@revessent/contracts";

export function AccountView({ org }: { org: Org }) {
  const session = useSession();
  return (
    <Surface level={2} className="p-6">
      <h2 className="text-[16px] font-bold text-ink">Account</h2>
      <p className="mt-1 text-[13px] text-ink-3">
        Account and profile management arrive with the Phase 4 auth backend. Values below reflect the
        demo session.
      </p>
      <div className="mt-4">
        <EvidenceList
          items={[
            { label: "Signed in as", value: session.email, source: "demo" },
            { label: "Workspace", value: org.name },
            { label: "Plan", value: PLANS[org.plan].label },
            { label: "Timezone", value: org.timezone }
          ]}
        />
      </div>
    </Surface>
  );
}
