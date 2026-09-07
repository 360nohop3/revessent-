import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PricingView } from "@/views/pricing-view";
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

describe("pricing pilot form (no fake success)", () => {
  it("blocks invalid emails and never submits", () => {
    renderWithProviders(<PricingView />);
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /start free pilot/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/valid work email/i);
  });

  it("stops honestly after a valid email — nothing was submitted", () => {
    renderWithProviders(<PricingView />);
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "founder@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /start free pilot/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/nothing was submitted and no email was sent/i);
  });

  it("renders plans from the shared entitlement matrix", () => {
    renderWithProviders(<PricingView />);
    expect(screen.getByText("Ember")).toBeInTheDocument();
    expect(screen.getByText("Revessent")).toBeInTheDocument();
    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText(/sso \/ saml/i)).toBeInTheDocument();
    expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(3);
  });
});
