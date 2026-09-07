import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockApi } from "@revessent/contracts";
import { OverviewView } from "@/views/overview-view";
import { RecoveryListView } from "@/views/recovery-list-view";
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

const ACORN = getMockApi().demo.store().get("acorn-books").org;
const FERN = getMockApi().demo.store().get("fernbrook").org;

describe("real application states", () => {
  beforeEach(() => {
    getMockApi().demo.store().reset();
    routerPush.mockClear();
    routerReplace.mockClear();
  });

  it("shows loading skeletons before data arrives", () => {
    renderWithProviders(<OverviewView org={ACORN} />);
    expect(screen.getAllByRole("status", { name: /loading/i }).length).toBeGreaterThan(0);
  });

  it("shows an error state with retry on failure", async () => {
    const api = getMockApi();
    api.demo.setOffline(true); // every request fails -> deterministic error state
    renderWithProviders(<OverviewView org={ACORN} />);
    await screen.findByRole("alert");
    api.demo.setOffline(false);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("renders the provider-disconnected state for an org without Stripe", async () => {
    renderWithProviders(<OverviewView org={FERN} />);
    expect(await screen.findByText(/stripe isn't connected yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/cash recovered/i)).not.toBeInTheDocument();
  });

  it("renders connected metrics labeled as demo fixtures", async () => {
    renderWithProviders(<OverviewView org={ACORN} />);
    expect(await screen.findByText(/cash recovered · 30 days/i)).toBeInTheDocument();
    expect(screen.getAllByText(/demo fixture/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/exposure — open failed payments/i)).toBeInTheDocument();
    expect(screen.getByText(/potential — not collected cash/i)).toBeInTheDocument();
  });

  it("shows syncing as its own state (syncing is not empty)", async () => {
    const store = getMockApi().demo.store();
    const rec = store.get("acorn-books");
    rec.connection = { ...rec.connection, backfill: "running" };
    renderWithProviders(<OverviewView org={ACORN} />);
    expect(await screen.findByText(/syncing with stripe/i)).toBeInTheDocument();
    expect(await screen.findByText(/incomplete, not empty/i)).toBeInTheDocument();
  });

  it("recovery list: empty filtered result is distinct from no data", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("status=lost&q=zzz"));
    pathnameMock.mockReturnValue("/app/acorn-books/recovery");
    renderWithProviders(<RecoveryListView orgSlug="acorn-books" />);
    expect(await screen.findByText(/no cases match this filter/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument());
  });
});
