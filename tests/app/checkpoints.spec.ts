import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "Windows packaged target.");
test("named checkpoints pin actual captured bytes/activity, survive deletion/restart, and support rename Unkeep and confirmed removal", async ({
  profile,
}) => {
  test.setTimeout(60000);
  const folder = path.join(profile, "protected"),
    text = "SyntheticCheckpointOriginalByteMarker5392",
    name = "Synthetic checkpoint5392";
  mkdirSync(folder);
  writeFileSync(path.join(folder, "checkpoint.txt"), text);
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    const setup = await page.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      return [
        await api.files.selectFolder(),
        await api.files.permission(true),
        await api.sessions.start(),
      ];
    });
    expect(setup.every((result) => result.ok)).toBe(true);
    await page.getByRole("button", { name: /Files/ }).click();
    await expect(page.getByTestId("captured-version")).toHaveCount(1, {
      timeout: 15000,
    });
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.sessions.pause(),
      ),
    ).toMatchObject({ ok: true });
    await page.getByRole("button", { name: /Checkpoints/ }).click();
    await page.getByLabel("Checkpoint name", { exact: true }).fill(name);
    await page
      .getByRole("checkbox", { name: /Select version checkpoint.txt/ })
      .check();
    await page
      .getByRole("checkbox", { name: /Select activity / })
      .first()
      .check();
    await page
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(
      page.getByText("Checkpoint saved with confirmed captured evidence.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("saved-checkpoint")).toHaveCount(1);
    await expect(page.getByTestId("saved-checkpoint")).toContainText(
      "1 versions · 1 activities",
    );
    await page
      .getByRole("button", { name: "Preview checkpoint version", exact: true })
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(text);
    const retained = await page.evaluate(() =>
      (
        window as unknown as { rewind: DesktopApi }
      ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
    );
    expect(retained).toMatchObject({
      ok: true,
      value: { versionCount: 1, activityCount: 1, keptCheckpointCount: 1 },
    });
    await page.screenshot({
      path: "test-results/checkpoint-evidence.png",
      fullPage: true,
    });
    await application.close();
    for (const file of readdirSync(path.join(profile, "secure"))) {
      const bytes = readFileSync(path.join(profile, "secure", file));
      expect(bytes.includes(Buffer.from(name))).toBe(false);
      expect(bytes.includes(Buffer.from(text))).toBe(false);
    }
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /Checkpoints/ }).click();
    await expect(page.getByTestId("saved-checkpoint")).toHaveCount(1);
    await page
      .getByRole("button", { name: `View checkpoint ${name}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Preview checkpoint version", exact: true })
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(text);
    await expect(
      page.getByRole("checkbox", {
        name: "Keep saved checkpoint",
        exact: true,
      }),
    ).toBeChecked();
    await page
      .getByLabel("Saved checkpoint name", { exact: true })
      .fill("Renamed checkpoint5392");
    await page
      .getByRole("checkbox", { name: "Keep saved checkpoint", exact: true })
      .uncheck();
    await page
      .getByRole("button", { name: "Save checkpoint changes", exact: true })
      .click();
    await expect(page.getByTestId("saved-checkpoint")).toContainText(
      "Renamed checkpoint5392",
    );
    await expect(page.getByTestId("saved-checkpoint")).toContainText(
      "Subject to retention",
    );
    await page
      .getByRole("button", {
        name: "View checkpoint Renamed checkpoint5392",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Delete checkpoint", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Cancel checkpoint deletion", exact: true })
      .click();
    await expect(page.getByTestId("saved-checkpoint")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Delete checkpoint", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete checkpoint", exact: true })
      .click();
    await expect(page.getByTestId("saved-checkpoint")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
      ),
    ).toMatchObject({
      ok: true,
      value: { versionCount: 0, activityCount: 0, checkpointCount: 0 },
    });
    expect(readFileSync(path.join(folder, "checkpoint.txt"), "utf8")).toBe(
      text,
    );
  } finally {
    await application.close();
  }
});
