// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEBUG_ASSISTANT_EVENT } from "./AskAssistant";
import ExecutionError from "./ExecutionError";
import type { NodeResult } from "./types";
import { I18n } from "./i18n";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import pt from "./locales/pt.json";

const { settings } = vi.hoisted(() => ({ settings: { enabled: false } }));
vi.mock("./shell", () => ({
  useShell: () => ({ workspace: { assistant: settings } }),
}));
afterEach(() => {
  cleanup();
  settings.enabled = false;
});

const source = "-- @output result\nSELECT missing;";
const failure: NodeResult = {
  outputs: {},
  error: "Unknown column: missing",
  error_run: "failed-run",
  diagnostic: {
    source,
    message: "Unknown column: missing",
    line: 2,
    column: 8,
    executed_sql: "DESCRIBE SELECT missing",
  },
};

it.each([
  ["en", en],
  ["fr", fr],
  ["pt", pt],
] as const)(
  "explains a Python node's policy failure in %s",
  (language, labels) => {
    render(
      <I18n.Provider value={{ language, setLanguage: () => {} }}>
        <ExecutionError
          failure={{ outputs: {}, error: "Python execution is disabled" }}
          node="python"
          environment="dev"
          currentSource=""
          onEditCode={() => {}}
          onLog={() => {}}
        />
      </I18n.Provider>,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      labels.pythonExecutionDisabled,
    );
  },
);

it("opens the saved source line and the log, but does not point into changed code", () => {
  const onEditCode = vi.fn(),
    onLog = vi.fn();
  const props = {
    failure,
    node: "query",
    environment: "dev",
    onEditCode,
    onLog,
  };
  const view = render(<ExecutionError {...props} currentSource={source} />);
  fireEvent.click(screen.getByRole("button", { name: "Open code at line 2" }));
  expect(onEditCode).toHaveBeenLastCalledWith(2);
  fireEvent.click(screen.getByRole("button", { name: "View log" }));
  expect(onLog).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: "Ask the assistant" }),
  ).toBeNull();
  view.rerender(
    <ExecutionError {...props} currentSource={source + "\n-- edited"} />,
  );
  expect(
    screen.queryByRole("button", { name: "Open code at line 2" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit code" }));
  expect(onEditCode).toHaveBeenLastCalledWith(undefined);
});

it("offers a configured assistant with the failed run and node as context", () => {
  settings.enabled = true;
  const receive = vi.fn();
  window.addEventListener(DEBUG_ASSISTANT_EVENT, receive);
  try {
    render(
      <ExecutionError
        failure={failure}
        node="query"
        environment="dev"
        currentSource={source}
        onEditCode={() => {}}
        onLog={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(receive.mock.calls[0][0].detail).toMatchObject({
      node: "query",
      run: "failed-run",
      environment: "dev",
    });
  } finally {
    window.removeEventListener(DEBUG_ASSISTANT_EVENT, receive);
  }
});
