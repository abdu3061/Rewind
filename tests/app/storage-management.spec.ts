import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "Windows packaged target.");
test("real settings and confirmed deletion drain recording and persist across restart", async ({
  profile,
}) => {
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.storage.usage(),
        );
        return result.ok ? result.value.activityCount : 0;
      })
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: /Settings/ }).click();
    await page.getByLabel("Data retention period").fill("24");
    await page.getByLabel("Storage limit", { exact: true }).fill("32");
    await page.getByRole("button", { name: "Save storage settings" }).click();
    await expect(
      page.getByText("Storage settings saved and cleanup verified."),
    ).toBeVisible();
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await page.getByRole("button", { name: /Settings/ }).click();
    const invalid = await page.evaluate(() =>
      Reflect.apply(
        (window as unknown as { rewind: DesktopApi }).rewind.storage
          .deleteHistory,
        null,
        [{ includeKept: true, confirmed: false }],
      ),
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await page
      .getByRole("button", { name: "Delete history…", exact: true })
      .click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const before = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.storage.usage(),
    );
    expect(before.ok && before.value.activityCount).toBeGreaterThan(0);
    // Delete while a live changing source is recording; acknowledgement must fence later writes.
    await page
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    await page.getByRole("button", { name: /Settings/ }).click();
    await page
      .getByRole("button", { name: "Delete history…", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm deletion", exact: true })
      .click();
    await expect(
      page.getByText("History deletion verified. Recording permission is off."),
    ).toBeVisible();
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual({ ok: true, value: [] });
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /Settings/ }).click();
    await expect(page.getByLabel("Data retention period")).toHaveValue("24");
    await expect(page.getByLabel("Storage limit", { exact: true })).toHaveValue(
      "32",
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.storage.usage(),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        activityCount: 0,
        preferences: { retentionHours: 24, storageLimitBytes: 32 * 1024 ** 2 },
      },
    });
  } finally {
    await application.close();
  }
});
