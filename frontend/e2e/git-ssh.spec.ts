import { generateKeyPairSync } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { openInstanceSettings, openUserSettings, signIn } from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

/** An OpenSSH ed25519 public key line, as published by a Git host. */
function hostKey() {
  const spki = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "der",
  });
  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  const blob = Buffer.concat([
    field(Buffer.from("ssh-ed25519")),
    field(spki.subarray(-32)),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

async function openSync(page: Page, worktree: string) {
  await page.goto(`/worktrees/${worktree}/flow`);
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  await dialog
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  return dialog;
}

async function configureOrigin(page: Page, dialog: any, url: string) {
  const save = dialog.getByRole("button", { name: "Save configuration" });
  // Wait for the preceding remote reload before editing its controlled inputs.
  await expect(save).toBeEnabled();
  await dialog.getByLabel("Repository URL").fill(url);
  await dialog.getByLabel("Remote branch", { exact: true }).fill("main");
  await save.click();
}

test("instance administrators trust SSH host keys and origin prefixes", async ({
  page,
}) => {
  await signIn(page);
  const original = await (await page.request.get("/api/git-hosts")).json();
  try {
    await openInstanceSettings(page, "Git hosts");
    await expect(page).toHaveURL(/\/instance-settings\/git-hosts$/);
    const keys = page.getByLabel("Trusted SSH host keys", { exact: true });
    const prefixes = page.getByLabel("Allowed origin prefixes", {
      exact: true,
    });
    const table = page.locator(".git-host-keys");
    await expect(table).toContainText("example.invalid");
    await expect(prefixes).toHaveValue(/git@example\.invalid:e2e\//);
    await keys.fill(
      `${await keys.inputValue()}[Git.Example.Test]:2222 ${hostKey()} provider\n`,
    );
    await prefixes.fill(
      `${await prefixes.inputValue()}\ngit@git.example.test:team/`,
    );
    await page.getByRole("button", { name: "Save Git hosts" }).click();
    await expect(page.getByRole("status")).toContainText("Git hosts saved.");
    const row = table.getByRole("row", { name: /\[git\.example\.test\]:2222/ });
    await expect(row).toContainText("ssh-ed25519");
    await expect(row).toContainText(/SHA256:\S+/);
    await expect(keys).toHaveValue(/\[git\.example\.test\]:2222 ssh-ed25519/);

    await keys.fill(`*.example.test ${hostKey()}`);
    await page.getByRole("button", { name: "Save Git hosts" }).click();
    await expect(page.getByRole("alert")).toContainText("without wildcards");
    await page.reload();
    await expect(table).toContainText("[git.example.test]:2222");

    await openUserSettings(page);
    await page.getByLabel("Language", { exact: true }).selectOption("fr");
    await page.goto("/instance-settings/git-hosts");
    await expect(
      page.getByRole("heading", { name: fr.gitHosts, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(fr.allowedOriginPrefixes, { exact: true }),
    ).toBeVisible();
    await page.goto("/user-settings");
    await page.getByLabel(fr.language, { exact: true }).selectOption("en");
  } finally {
    const restored = await page.request.put("/api/git-hosts", {
      data: { known_hosts: original.known_hosts, prefixes: original.prefixes },
    });
    expect(restored.ok()).toBeTruthy();
  }
});

test("synchronize over SSH with the account key after confirming each origin URL", async ({
  page,
}) => {
  await signIn(page);
  await page.request.delete("/api/ssh-key");
  const tree = await (
    await page.request.post("/api/projects", { data: { name: "SSH sync" } })
  ).json();
  const name = tree.id.replaceAll("_", "-");
  const url = `git@example.invalid:e2e/${name}.git`;
  let dialog = await openSync(page, tree.id);
  await expect(dialog).toContainText("personal SSH key");

  await configureOrigin(page, dialog, "git@elsewhere.invalid:e2e/repo.git");
  await expect(dialog.getByRole("alert")).toContainText("not allowed");
  await configureOrigin(page, dialog, url);
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // Without a key, Duckpad points to the user settings instead of server credentials.
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Generate your SSH key",
  );
  await dialog.getByRole("link", { name: "Open user settings" }).click();
  await expect(page).toHaveURL(/\/user-settings$/);
  const card = page.getByRole("region", { name: "SSH key for Git" });
  await card.getByRole("button", { name: "Generate SSH key" }).click();
  const publicKey = card.getByLabel("Public key", { exact: true });
  await expect(publicKey).toHaveValue(/^ssh-ed25519 \S+ admin@duckpad$/);
  const fingerprint = card.locator("dd code");
  await expect(fingerprint).toHaveText(/^SHA256:/);
  const first = await fingerprint.textContent();
  await expect(page.locator("body")).not.toContainText("PRIVATE KEY");
  await card.getByRole("button", { name: "Regenerate key" }).click();
  const confirmation = page.getByRole("dialog", { name: "Regenerate key" });
  await expect(confirmation).toContainText("stops working immediately");
  await confirmation.getByRole("button", { name: "Regenerate key" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(fingerprint).not.toHaveText(first!);

  dialog = await openSync(page, tree.id);
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  const consent = page.getByRole("dialog", {
    name: "Use your SSH key for this origin?",
  });
  await expect(consent.locator(".git-consent-url")).toHaveText(url);
  // Escape dismisses only the confirmation, without fetching.
  await page.keyboard.press("Escape");
  await expect(consent).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".git-sync-summary")).toContainText(
    "Not checked",
  );
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await consent
    .getByRole("button", { name: "Use my key for this URL" })
    .click();
  await expect(dialog.locator(".git-sync-summary")).toContainText(
    "Ready for first publication",
  );

  // A new origin URL needs a new confirmation, which shows the new URL.
  const other = `git@example.invalid:e2e/${name}-other.git`;
  await dialog.locator("details summary").click();
  await configureOrigin(page, dialog, other);
  await dialog.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(consent.locator(".git-consent-url")).toHaveText(other);
  await consent
    .getByRole("button", { name: "Use my key for this URL" })
    .click();
  await expect(dialog.locator(".git-sync-summary")).toContainText(
    "Ready for first publication",
  );

  await page.keyboard.press("Escape");
  await openUserSettings(page);
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  const translated = page.getByRole("region", { name: fr.sshKey });
  await expect(translated).toContainText(fr.sshPublicKey);
  await translated
    .getByRole("button", { name: fr.deleteSshKey, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: fr.deleteSshKey })
    .getByRole("button", { name: fr.deleteSshKey, exact: true })
    .click();
  await expect(
    translated.getByRole("button", { name: fr.generateSshKey }),
  ).toBeVisible();
  await page.getByLabel(fr.language, { exact: true }).selectOption("en");
  expect(await (await page.request.get("/api/ssh-key")).json()).toBeNull();
});
