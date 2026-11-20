import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "Windows packaged target.");
test("explicit overwrite preserves current bytes, rejects intervening changes and leaves the backup outside history deletion", async ({
  profile,
}) => {
  test.setTimeout(60000);
  const source = path.join(profile, "protected"),
    target = path.join(profile, "selected.txt"),
    original = "SyntheticOverwriteCaptured7612 <plain-text>",
    current = "SyntheticCurrentUncapturedBytes7612";
  mkdirSync(source);
  writeFileSync(path.join(source, "original.txt"), original);
  writeFileSync(target, current);
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, source);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page
      .getByRole("button", { name: "Select protected folder", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Allow file protection",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
      { timeout: 15000 },
    );
    await page.getByRole("button", { name: "Files", exact: true }).click();
    writeFileSync(path.join(source, "original.txt"), original);
    await expect(page.getByTestId("captured-version")).toHaveCount(1, {
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page
      .getByRole("button", { name: /Preview original.txt captured/ })
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(original);
    await page
      .getByText("Optional: overwrite an existing file", { exact: true })
      .click();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    const choose = () =>
      page
        .getByRole("button", {
          name: "Choose existing file for overwrite",
          exact: true,
        })
        .click();
    await choose();
    const review = page.getByRole("region", {
      name: "Review overwrite recovery",
      exact: true,
    });
    await expect(review).toHaveCount(0);
    expect(readFileSync(target, "utf8")).toBe(current);
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, target);
    await choose();
    await expect(review).toBeVisible({ timeout: 10000 });
    const cancelledBackup = await review.locator("strong").nth(1).innerText();
    expect(existsSync(cancelledBackup)).toBe(false);
    await page
      .getByRole("button", { name: "Cancel overwrite recovery", exact: true })
      .click();
    expect(readFileSync(target, "utf8")).toBe(current);
    expect(existsSync(cancelledBackup)).toBe(false);
    await choose();
    await expect(review).toBeVisible();
    const staleBackup = await review.locator("strong").nth(1).innerText();
    writeFileSync(target, "Intervening synthetic editor save");
    await page
      .getByRole("button", {
        name: "Confirm preserve current file and overwrite",
        exact: true,
      })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "prerequisites failed",
      { timeout: 20000 },
    );
    expect(readFileSync(target, "utf8")).toBe(
      "Intervening synthetic editor save",
    );
    expect(existsSync(staleBackup)).toBe(false);
    await choose();
    await expect(review).toBeVisible();
    const backup = await review.locator("strong").nth(1).innerText();
    expect(existsSync(backup)).toBe(false);
    await page
      .locator("details.recovery-copy")
      .screenshot({ path: "test-results/overwrite-review.png" });
    await page
      .getByRole("button", {
        name: "Confirm preserve current file and overwrite",
        exact: true,
      })
      .click();
    await expect(page.getByText(/Overwrite saved and verified:/)).toBeVisible({
      timeout: 20000,
    });
    await expect(
      page.getByText(/Current bytes preserved and verified:/),
    ).toContainText(backup);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readFileSync(backup, "utf8")).toBe(
      "Intervening synthetic editor save",
    );
    await page
      .locator("details.recovery-copy")
      .screenshot({ path: "test-results/overwrite-receipt.png" });
    expect(
      (
        await page.evaluate(() =>
          (
            window as unknown as { rewind: DesktopApi }
          ).rewind.storage.deleteHistory({
            confirmed: true,
            includeKept: false,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readFileSync(backup, "utf8")).toBe(
      "Intervening synthetic editor save",
    );
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("ended");
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readFileSync(backup, "utf8")).toBe(
      "Intervening synthetic editor save",
    );
  } finally {
    await application.close();
  }
});
