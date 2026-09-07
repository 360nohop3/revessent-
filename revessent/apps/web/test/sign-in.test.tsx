import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInView } from "@/views/sign-in-view";
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

describe("sign-in (demo session)", () => {
  beforeEach(() => {
    routerPush.mockClear();
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it("validates locally before anything else", async () => {
    renderWithProviders(<SignInView />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText(/enter a valid email/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("starts a demo session and redirects", async () => {
    renderWithProviders(<SignInView />);
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "priya@acornbooks.example" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "notarealpassword" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/demo/session", { method: "POST" });
      expect(useRouter().push).toHaveBeenCalledWith("/app");
    });
  });
});
