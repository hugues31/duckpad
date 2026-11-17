import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { PASSWORD, openUserSettings } from "./helpers";

const CALLBACK = "https://app.example/callback";

async function registerApp(page: Page, name: string) {
  const response = await page.request.post("/api/oauth/register", {
    headers: { Cookie: "" },
    data: {
      client_name: name,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).client_id as string;
}

function authorizationUrl(client: string, baseURL: string) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "browser-state",
    resource: `${baseURL}/api/agent/mcp`,
  });
  return { url: `/oauth/authorize?${query}`, verifier };
}

/** The app's callback, which receives the decision in its address. */
async function answer(page: Page, decide: () => Promise<unknown>) {
  const received = new Promise<URL>((resolve) =>
    page.route(`${CALLBACK}**`, async (route) => {
      resolve(new URL(route.request().url()));
      await route.fulfill({ body: "Back in the app" });
    }),
  );
  await decide();
  return received;
}

test("an app asks for access, the person signs in, allows it and revokes it later", async ({
  page,
  baseURL,
}) => {
  const client = await registerApp(page, "Example agent");
  const { url, verifier } = authorizationUrl(client, baseURL!);
  await page.goto(url);
  // Signed out: the request waits behind the sign-in card.
  await page.getByLabel(en.password, { exact: true }).fill(PASSWORD);
  await page
    .getByRole("button", { name: en.signInAction, exact: true })
    .click();
  const heading = en.authorizeAppHeading.replace("{app}", "Example agent");
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle(`${en.appAuthorization} · Duckpad`);
  await expect(page.getByText(en.authorizeAppSelfNamed)).toBeVisible();
  const facts = page.locator(".app-authorization-facts");
  await expect(facts).toContainText(`${en.authorizeAppAccount}admin`);
  await expect(facts).toContainText(`${en.authorizeAppReturnsTo}app.example`);
  await expect(page.getByText(en.authorizeAppCannot)).toBeVisible();
  const allow = en.authorizeAppAllow.replace("{app}", "Example agent");
  const callback = await answer(page, () =>
    page.getByRole("button", { name: allow, exact: true }).click(),
  );
  expect(callback.searchParams.get("state")).toBe("browser-state");
  expect(callback.searchParams.get("iss")).toBe(baseURL);
  const tokens = await page.request.post("/api/oauth/token", {
    headers: { Cookie: "" },
    form: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      client_id: client,
      redirect_uri: CALLBACK,
    },
  });
  expect(tokens.status()).toBe(200);
  const { access_token: access } = await tokens.json();
  const headers = { Authorization: `Bearer ${access}`, Cookie: "" };
  const tools = await page.request.post("/api/agent/tools/list_projects", {
    headers,
    data: {},
  });
  expect((await tools.json()).ok).toBe(true);
  expect((await page.request.get("/api/workspace", { headers })).status()).toBe(
    403,
  );

  // The consent page is not kept in the history; the settings list the app.
  await page.goto("/projects");
  await openUserSettings(page, en.authorizedApps);
  const section = page.getByRole("region", {
    name: en.authorizedApps,
    exact: true,
  });
  await expect(
    section.getByLabel(en.mcpServerAddress, { exact: true }),
  ).toHaveValue(`${baseURL}/api/agent/mcp`);
  const row = section.getByRole("row").filter({ hasText: "Example agent" });
  await expect(row).toContainText("app.example");
  await row
    .getByRole("button", { name: en.revokeApiToken, exact: true })
    .click();
  await expect(row).toContainText(en.revokeAuthorizedAppHint);
  await row.getByRole("button", { name: en.confirm, exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(section).toContainText(en.noAuthorizedApps);
  const revoked = await page.request.post("/api/agent/tools/list_projects", {
    headers,
    data: {},
  });
  expect(revoked.status()).toBe(401);
});

test("a declined or untrusted request never hands out a code", async ({
  page,
  baseURL,
}) => {
  await page.goto("/");
  await page.getByLabel(en.password, { exact: true }).fill(PASSWORD);
  await page
    .getByRole("button", { name: en.signInAction, exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: en.workspace, exact: true }),
  ).toBeVisible();
  const client = await registerApp(page, "Declined agent");
  await page.goto(authorizationUrl(client, baseURL!).url);
  const callback = await answer(page, () =>
    page
      .getByRole("button", { name: en.authorizeAppDeny, exact: true })
      .click(),
  );
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.has("code")).toBe(false);

  // A registered app's error goes back to it only on a click: anyone can
  // register a redirect address, so Duckpad never forwards there on its own.
  const broken = new URL(authorizationUrl(client, baseURL!).url, baseURL);
  broken.searchParams.delete("response_type");
  await page.goto(broken.pathname + broken.search);
  await expect(page.getByRole("alert")).toContainText(
    "Only the authorization code flow is supported",
  );
  const refused = await answer(page, () =>
    page
      .getByRole("button", {
        name: en.authorizeAppReturnToApp.replace("{host}", "app.example"),
        exact: true,
      })
      .click(),
  );
  expect(refused.searchParams.get("error")).toBe("unsupported_response_type");

  // An unknown app or redirect address stays on Duckpad with an explanation.
  const unknown = authorizationUrl("oauth_client_unknown", baseURL!).url;
  await page.goto(unknown);
  await expect(
    page.getByRole("heading", { name: en.authorizeAppInvalid, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("not registered");
  await page
    .getByRole("link", { name: en.authorizeAppOpenDuckpad, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en.projects, exact: true }),
  ).toBeVisible();
});
