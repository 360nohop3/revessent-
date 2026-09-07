import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SessionProvider } from "@/components/session";
import type { DemoSession } from "@revessent/contracts";
import { ToastProvider } from "@revessent/ui";

export function makeQc(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } }
  });
}

export const DEMO_SESSION: DemoSession = {
  email: "priya@acornbooks.example",
  name: "Priya Anand",
  demo: true,
  memberships: [
    { slug: "acorn-books", name: "Acorn Books", role: "owner", plan: "revessent" },
    { slug: "fernbrook", name: "Fernbrook Studio", role: "viewer", plan: "ember" }
  ]
};

export function renderWithProviders(
  ui: ReactElement,
  opts?: { qc?: QueryClient; session?: DemoSession | null }
) {
  const qc = opts?.qc ?? makeQc();
  const session = opts && "session" in opts ? opts.session : DEMO_SESSION;

  function Wrapper({ children }: { children: ReactNode }) {
    const content = session ? <SessionProvider session={session}>{children}</SessionProvider> : children;
    return (
      <QueryClientProvider client={qc}>
        <ToastProvider>{content}</ToastProvider>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper }), qc };
}
