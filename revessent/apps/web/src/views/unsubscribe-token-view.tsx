"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, Surface } from "@revessent/ui";
import { api } from "@/lib/api";

export function UnsubscribeTokenView() {
  const params = useParams<{ token: string }>();
  // Deliberately NO request on page load: the opt-out is persisted only on
  // explicit confirmation (link scanners/prefetchers must not unsubscribe people).
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
      <h1 className="text-[19px] font-bold text-ink">Stop these emails</h1>
      {done ? (
        <p role="status" className="mt-3 text-[14px] text-ink-2">
          Done. You won't receive further recovery emails about this membership.
        </p>
      ) : unknown ? (
        <p role="status" className="mt-3 text-[14px] text-ink-2">
          This link is no longer valid, so nothing was changed. If you still receive emails, use the link in the most recent one.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[14px] text-ink-2">
            We'll stop sending recovery emails about this membership.
          </p>
          <div className="mt-4 flex justify-center gap-2.5">
            {confirming ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep emails</Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api.subscriber.unsubscribe(params.token)
                      .then((r) => { if (r.state === "done") setDone(true); else setUnknown(true); })
                      .catch(() => setUnknown(true))
                      .finally(() => setBusy(false));
                  }}
                >
                  Confirm unsubscribe
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>Unsubscribe</Button>
            )}
          </div>
        </>
      )}
    </Surface>
  );
}
