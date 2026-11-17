import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "Windows packaged target.");
test("selected synthetic folders capture saved bytes with independent consent and verified previews across restart", async ({
  profile,
}) => {
  test.setTimeout(60000);
  const source = path.join(profile, "protected");
  mkdirSync(source);
  const file = path.join(source, "synthetic.txt");
  const alpha =
    "SyntheticNativeSnapshotMarkerA9482\n<script>window.__captured=1</script>";
  const beta = "SyntheticNativeSnapshotMarkerB9482";
  writeFileSync(file, alpha);
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
    await page.getByRole("button", { name: /Files/ }).click();
    await expect(
      page.getByRole("button", {
        name: "Allow file protection for this launch",
      }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Select protected folder", exact: true })
      .click();
    await expect(page.locator(".protected-folders")).toContainText(source);
    await page
      .getByRole("button", { name: "Allow file protection for this launch" })
      .click();
    await expect(
      page.getByRole("button", { name: "Revoke file protection", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.privacy.get(),
      ),
    ).toMatchObject({ ok: true, value: { collectionConsent: false } });
    await page.getByRole("button", { name: /Files/ }).click();
    await expect(page.getByTestId("captured-version")).toHaveCount(1, {
      timeout: 15000,
    });
    await page
      .getByRole("button", { name: /Preview synthetic.txt captured/ })
      .first()
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(alpha);
    expect(
      await page.evaluate(() => Reflect.get(window, "__captured")),
    ).toBeUndefined();
    writeFileSync(file, beta);
    await expect(page.getByTestId("captured-version")).toHaveCount(2, {
      timeout: 12000,
    });
    await page
      .getByRole("button", { name: /Preview synthetic.txt captured/ })
      .first()
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(beta);
    const timeline = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
        limit: 100,
        text: "synthetic",
        types: ["file-change"],
      }),
    );
    expect(timeline.ok && timeline.value.length).toBe(2);
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    writeFileSync(file, "A paused synthetic change must not be captured");
    await page.waitForTimeout(2300);
    const paused = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.versions.list({
        limit: 100,
      }),
    );
    expect(paused.ok && paused.value.length).toBe(2);
    await page.getByRole("button", { name: /Files/ }).click();
    await page
      .getByRole("button", { name: "Revoke file protection", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Allow file protection for this launch",
      }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/file-protection.png",
      fullPage: true,
    });
    await application.close();
    for (const name of readdirSync(path.join(profile, "secure"))) {
      const bytes = readFileSync(path.join(profile, "secure", name));
      expect(bytes.includes(Buffer.from(alpha))).toBe(false);
      expect(bytes.includes(Buffer.from(beta))).toBe(false);
    }
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /Files/ }).click();
    await expect(page.locator(".protected-folders")).toContainText(source);
    await expect(page.getByTestId("captured-version")).toHaveCount(2);
    await expect(
      page.getByRole("button", {
        name: "Allow file protection for this launch",
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Preview synthetic.txt captured/ })
      .first()
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(beta);
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
  } finally {
    await application.close();
  }
});
