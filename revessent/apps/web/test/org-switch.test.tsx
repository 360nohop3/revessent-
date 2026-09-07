import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Org } from "@revessent/contracts";
import { getMockApi } from "@revessent/contracts";
import { OrgSwitcher } from "@/components/shell/org-switcher";
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

describe("organization switching", () => {
  beforeEach(() => {
    routerPush.mockClear();
    getMockApi().demo.store().reset();
  });

  it("navigates and removes the previous org's cache slice", async () => {
    const { qc } = renderWithProviders(<OrgSwitcher current={ACORN} />);
    qc.setQueryData(["org", "acorn-books", "overview"], { some: "data" });
    expect(qc.getQueryData(["org", "acorn-books", "overview"])).toBeTruthy();

    const trigger = screen.getByRole("button", { name: /workspace: acorn books/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const item = await screen.findByText("Fernbrook Studio");
    fireEvent.click(item);

    await waitFor(() => {
      expect(useRouter().push).toHaveBeenCalledWith("/app/fernbrook/overview");
      expect(qc.getQueryData(["org", "acorn-books", "overview"])).toBeUndefined();
    });
  });
});
