import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Org } from "@revessent/contracts";
import { getMockApi } from "@revessent/contracts";
import { MobileNav } from "@/components/shell/mobile-nav";
import { renderWithProviders } from "./utils";
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const pathnameMock = vi.hoisted(() => vi.fn(() => "/app/acorn-books/recovery"));
const searchParamsMock = vi.hoisted(() => vi.fn(() => new URLSearchParams()));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameMock(),
  useParams: () => ({}),
  useSearchParams: () => searchParamsMock()
}));

const ACORN: Org = getMockApi().demo.store().get("acorn-books").org;

describe("mobile navigation", () => {
  it("opens an accessible dialog with nav links and closes", async () => {
    renderWithProviders(<MobileNav open onOpenChange={() => undefined} org={ACORN} role="owner" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    for (const label of ["Overview", "Recovery", "Expansion", "Customers", "Settings"]) {
      expect(screen.getAllByRole("link", { name: new RegExp(label, "i") }).length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole("button", { name: /close menu/i }));
  });
});
