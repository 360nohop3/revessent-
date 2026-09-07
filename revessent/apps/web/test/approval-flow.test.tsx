import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getMockApi } from "@revessent/contracts";
import { DraftMessageCard } from "@/views/draft-message-card";
import { renderWithProviders } from "./utils";

const slug = "acorn-books";
const parentId = "case_acorn_2";
const qkCase = ["org", slug, "case", parentId] as const;

describe("approval flow (edit invalidates approval)", () => {
  beforeEach(() => {
    getMockApi().demo.store().reset();
  });

  it("approves a draft, then invalidates the approval when edited", async () => {
    const api = getMockApi();
    const { case: initial } = await api.recovery.get(slug, parentId);
    expect(initial.draft?.approvalStatus).toBe("awaiting_approval");
    const draft = initial.draft!;

    const view = renderWithProviders(
      <DraftMessageCard slug={slug} kind="case" parentId={parentId} queryKey={qkCase} draft={draft} role="owner" />
    );

    fireEvent.click(screen.getByRole("button", { name: /review & approve/i }));
    const approveButton = await screen.findByRole("button", { name: /^approve$/i });
    fireEvent.click(approveButton);

    await waitFor(async () => {
      const { case: after } = await api.recovery.get(slug, parentId);
      expect(after.draft?.approvalStatus).toBe("approved");
    });

    // Re-render with the fresh draft (as the live query would provide)
    const approved = (await api.recovery.get(slug, parentId)).case.draft!;
    view.rerender(
      <DraftMessageCard slug={slug} kind="case" parentId={parentId} queryKey={qkCase} draft={approved} role="owner" />
    );

    const editButton = await screen.findByRole("button", { name: /edit \(invalidates approval\)/i });
    fireEvent.click(editButton);
    const subject = await screen.findByLabelText(/subject/i);
    fireEvent.change(subject, { target: { value: "Revised subject" } });
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(async () => {
      const { case: afterEdit } = await api.recovery.get(slug, parentId);
      expect(afterEdit.draft?.approvalStatus).toBe("draft");
      expect(afterEdit.draft?.subject).toBe("Revised subject");
    });

    expect(await screen.findByText(/previous approval was invalidated/i)).toBeInTheDocument();
  }, 20000);

  it("hides actions from viewers and explains why", async () => {
    const api = getMockApi();
    const { case: rec } = await api.recovery.get(slug, parentId);
    renderWithProviders(
      <DraftMessageCard slug={slug} kind="case" parentId={parentId} queryKey={qkCase} draft={rec.draft} role="viewer" />
    );
    expect(screen.getByText(/your role \(viewer\)/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit for approval/i })).not.toBeInTheDocument();
  });
});
