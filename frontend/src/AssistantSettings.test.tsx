// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { PromptSettings } from "./AssistantPrompts";
import AssistantSettings from "./AssistantSettings";
import type { QuickPrompt } from "./assistantTypes";
import { ShellContext, type Shell } from "./shell";

afterEach(cleanup);

const saved = {
  enabled: false,
  allow_data: true,
  max_rows: 50,
  providers: [
    {
      id: "primary",
      kind: "deepseek",
      base_url: "",
      models: [],
      has_key: true,
    },
  ],
  default_provider: "",
  default_model: "",
  quick_prompts: null,
};

it("lists the models of an unsaved provider and defaults to the first allowed one", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      const body =
        path === "/api/assistant/settings"
          ? saved
          : { models: ["deepseek-chat", "deepseek-reasoner"], listed: true };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const shell = { refreshWorkspace: async () => ({}) } as unknown as Shell;
  render(
    <ShellContext.Provider value={shell}>
      <AssistantSettings />
    </ShellContext.Provider>,
  );
  const provider = await screen.findByRole("group", { name: "DeepSeek" });
  expect(within(provider).getByText("Key saved")).toBeTruthy();
  expect(
    (screen.getByLabelText("Enable the assistant") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(
    within(provider).getByRole("button", { name: "Load available models" }),
  );
  fireEvent.click(
    await within(provider).findByRole("checkbox", {
      name: "deepseek-reasoner",
    }),
  );
  // The saved key stays on the server: the draft is sent without it.
  expect(requests[1]).toEqual({
    path: "/api/assistant/models",
    method: "POST",
    body: { id: "primary", kind: "deepseek", base_url: "", models: [] },
  });
  expect(within(provider).getByRole("listitem").textContent).toBe(
    "deepseek-reasoner",
  );
  const model = screen.getByLabelText(
    "Instance default model",
  ) as HTMLSelectElement;
  expect(model.selectedOptions[0].textContent).toBe(
    "DeepSeek · deepseek-reasoner",
  );
  expect(
    (screen.getByLabelText("Enable the assistant") as HTMLInputElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(requests).toHaveLength(2);
});

it("closes an untouched new quick prompt without customizing the defaults", () => {
  const changes: (QuickPrompt[] | null)[] = [];
  function Prompts() {
    const [value, setValue] = useState<QuickPrompt[] | null>(null);
    return (
      <PromptSettings
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Prompts />);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Add quick prompt" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(changes.at(-1)).toBeNull();
});
