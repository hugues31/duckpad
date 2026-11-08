// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FormModal, ConfirmModal } from "./modals";

afterEach(cleanup);

it("serializes submissions, preserves failed input, and closes after a successful retry", async () => {
  let fail!: (error: Error) => void;
  const submit = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <FormModal
      title="Create item"
      fields={[{ key: "name", label: "Name", value: "Original" }]}
      onSubmit={submit}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Edited" },
  });
  const form = screen.getByRole("button", { name: "Create" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(submit).toHaveBeenCalledExactlyOnceWith({ name: "Edited" });
  expect(close).not.toHaveBeenCalled();
  await act(async () => fail(new Error("Try again")));
  expect(screen.getByRole("alert").textContent).toBe("Try again");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "Edited",
  );
  await act(async () => fireEvent.submit(form));
  expect(submit).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(1);
});

it("keeps confirmation cancel controls from submitting", () => {
  const confirm = vi.fn();
  const close = vi.fn();
  render(
    <ConfirmModal
      title="Delete"
      confirmLabel="Delete"
      onConfirm={confirm}
      onClose={close}
    >
      Delete the item?
    </ConfirmModal>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
});
