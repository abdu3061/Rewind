import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "The verified target is Windows x64.");

test("explicit approval records encrypted synthetic history with real filters, paging, stop and restart", async ({
  profile,
}) => {
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await expect(page.getByText("Synthetic verification mode")).toBeVisible();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("active");
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual({ ok: true, value: [] });
    await page
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(() =>
            (window as unknown as { rewind: DesktopApi }).rewind.timeline.query(
              { limit: 100 },
            ),
          );
          return result.ok ? result.value.length : 0;
        },
        { timeout: 12000 },
      )
      .toBeGreaterThanOrEqual(55);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    const paused = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
        limit: 100,
      }),
    );
    expect(paused.ok).toBe(true);
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual(paused);
    await page.getByRole("button", { name: /Timeline/ }).click();
    await expect(page.getByTestId("timeline-event")).toHaveCount(50);
    await page.getByRole("button", { name: "Load older activity" }).click();
    await expect(page.getByTestId("timeline-event")).toHaveCount(
      paused.ok ? paused.value.length : 0,
    );
    await expect(page.getByTestId("timeline-event").first()).toContainText(
      "SyntheticEditor.exe",
    );
    await page.setViewportSize({ width: 800, height: 600 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/recording-timeline.png",
      fullPage: false,
    });
    await page.getByLabel("Search history").fill("nonexistent-fixture-token");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByTestId("timeline-event")).toHaveCount(0);
    await page.getByLabel("Search history").fill("Synthetic");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByTestId("timeline-event")).toHaveCount(50);
    await page.getByLabel("Event type").selectOption("capture-gap");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByTestId("timeline-event")).toHaveCount(0);
    await page.getByRole("button", { name: /Dashboard/ }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    // Revocation must work even when an unsaved exclusion draft is invalid.
    await page
      .getByLabel("Excluded applications (one name per line)")
      .fill("x".repeat(300));
    await page
      .getByRole("button", { name: "Revoke recording permission" })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await page
      .getByLabel("Excluded applications (one name per line)")
      .fill("SyntheticEditor.exe");
    await page
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    const excluded = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
        limit: 100,
      }),
    );
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual(excluded);
    if (!excluded.ok)
      throw new Error("Expected readable history while excluded.");
    await page.getByLabel("Excluded applications (one name per line)").fill("");
    await page
      .getByRole("button", { name: "Save exclusions", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
            limit: 100,
          }),
        );
        return result.ok ? result.value[0]?.id : null;
      })
      .not.toBe(excluded.value[0]?.id);
    await page
      .getByRole("button", { name: "End session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("ended");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    const finalEvents = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
        limit: 100,
      }),
    );
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual(finalEvents);
    await page
      .getByLabel("Excluded applications (one name per line)")
      .fill("SyntheticEditor.exe");
    await page
      .getByRole("button", { name: "Save exclusions", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Save exclusions", exact: true }),
    ).toBeEnabled();
    const session = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    expect(
      readFileSync(path.join(profile, "secure", "history.sqlite"))
        .subarray(0, 16)
        .toString(),
    ).not.toBe("SQLite format 3\0");
    for (const filename of [
      "history.sqlite",
      "history.sqlite-wal",
      "history.key",
    ]) {
      expect(
        readFileSync(path.join(profile, "secure", filename)).includes(
          Buffer.from("Synthetic work item"),
        ),
      ).toBe(false);
    }
    expect(errors).toEqual([]);
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("ended");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await expect(
      page.getByLabel("Excluded applications (one name per line)"),
    ).toHaveValue("SyntheticEditor.exe");
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
      ),
    ).toEqual(session);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 100,
        }),
      ),
    ).toEqual(finalEvents);
    await page.screenshot({
      path: "test-results/recording-dashboard.png",
      fullPage: true,
    });
  } finally {
    await application.close();
  }
});

test("worker crash is visible, reconnect restores a paused session and gap without permission", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await page
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await expect(
      page.getByRole("button", { name: "Revoke recording permission" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    await application.evaluate(({ app }) => {
      const workers = app
        .getAppMetrics()
        .filter(
          (metric) =>
            metric.type === "Utility" &&
            (metric.name === "Rewind recording engine" ||
              metric.serviceName === "Rewind recording engine"),
        );
      if (workers.length !== 1 || !workers[0])
        throw new Error("Expected exactly one Rewind recording worker.");
      process.kill(workers[0].pid);
    });
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection unavailable",
    );
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Reconnect recording service" })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    await expect(
      page.getByRole("button", {
        name: "Allow Windows activity for this launch",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Timeline/ }).click();
    await expect(page.getByText("Capture gap", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await application.close();
  }
});

test("missing protected key fails closed without replacing existing history", async ({
  profile,
}) => {
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await application.close();
    const database = readFileSync(
      path.join(profile, "secure", "history.sqlite"),
    );
    renameSync(
      path.join(profile, "secure", "history.key"),
      path.join(profile, "secure", "history.key.preserved"),
    );
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByRole("alert").first()).toContainText(
      "Windows-protected storage key is unavailable",
    );
    await expect(
      page.getByRole("button", {
        name: "Allow Windows activity for this launch",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Start session", exact: true }),
    ).toBeDisabled();
    expect(
      readFileSync(path.join(profile, "secure", "history.sqlite")),
    ).toEqual(database);
  } finally {
    await application.close();
  }
});
