// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { signInReturn } from "./routes";

it("returns to an app's authorization request with its whole query, and to nothing foreign", () => {
  const request =
    "/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fapp.test%2Fclient.json&state=s";
  expect(signInReturn(request)).toBe(request);
  expect(signInReturn("/projects?client_id=x")).toBe("/projects");
  expect(signInReturn("//example.invalid/oauth/authorize?x=1")).toBeNull();
  expect(signInReturn("https://example.invalid/oauth/authorize")).toBeNull();
});
