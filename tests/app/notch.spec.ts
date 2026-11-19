import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

async function captureExpandedNotch(page: Page, name: string): Promise<void> {
  // ResizeObserver -> validated main command -> HWND bounds is asynchronous.
  // Wait for real native fit rather than capturing a transient clipped frame.
  await expect
    .poll(() =>
      page
        .locator(".notch-panel")
        .evaluate(
          (panel) =>
            Math.ceil(panel.getBoundingClientRect().height + 16) -
            window.innerHeight,
        ),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({ path: `test-results/premium-${name}.png` });
}

test.skip(
  process.platform !== "win32",
  "The supported desktop target is Windows.",
);

test("losing the notch renderer acknowledges shutdown and leaves no hidden recording worker", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
  let closed = false;
  application.on("close", () => {
    closed = true;
  });
  try {
    const desktop = await application.firstWindow();
    await desktop
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await desktop
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(desktop.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    const created = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    const notch = await created;
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    const exited = application.waitForEvent("close");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind notch")
        ?.webContents.forcefullyCrashRenderer(),
    );
    await exited;
    const records = readFileSync(
      path.join(profile, "logs/operations.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(records.map((record) => record.code)).toContain("RENDERER_GONE");
    expect(records.at(-1)?.code).toBe("DESKTOP_STOPPED");
  } finally {
    if (!closed) await application.close();
  }
});

test("minimize, hover, keyboard, restore and single-instance activation preserve desktop state", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
  try {
    const desktop = await application.firstWindow();
    const errors: string[] = [];
    desktop.on("pageerror", (error) => errors.push(error.message));
    desktop.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await expect(desktop.getByTestId("session-status")).toHaveText(
      "not started",
    );
    await desktop.screenshot({
      path: "test-results/premium-dashboard.png",
      fullPage: true,
    });
    await desktop.getByRole("button", { name: "Search", exact: true }).click();
    await desktop.getByLabel("Search history").fill("my retained draft");
    const notchCreated = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    const notch = await notchCreated;
    notch.on("pageerror", (error) => errors.push(error.message));
    notch.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    await notch.screenshot({
      path: "test-results/premium-notch-collapsed.png",
    });
    const initial = await application.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (item) => item.getTitle() === "Rewind notch",
      );
      return {
        count: BrowserWindow.getAllWindows().length,
        top: window?.isAlwaysOnTop(),
        bounds: window?.getBounds(),
        focused: window?.isFocused(),
        sandboxed: app
          .getAppMetrics()
          .find((metric) => metric.pid === window?.webContents.getOSProcessId())
          ?.sandboxed,
        workers: app
          .getAppMetrics()
          .filter((metric) => metric.name === "Rewind recording engine").length,
      };
    });
    expect(initial).toMatchObject({
      count: 2,
      top: true,
      focused: false,
      bounds: { width: 144, height: 64 },
      sandboxed: true,
      workers: 1,
    });
    const bridge = await notch.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      return {
        keys: Object.keys(api),
        runtime: Object.keys(api.runtime),
        versions: Object.keys(api.versions),
        checkpoints: Object.keys(api.checkpoints),
        node: typeof Reflect.get(window, "require"),
        invalidWindowAction: await Reflect.apply(
          api.presentation.send,
          api.presentation,
          [{ action: "open", page: "file:///untrusted" }],
        ),
      };
    });
    expect(bridge).toEqual({
      keys: [
        "presentation",
        "sessions",
        "runtime",
        "timeline",
        "versions",
        "checkpoints",
      ],
      runtime: ["get", "onChanged"],
      versions: ["list"],
      checkpoints: ["create"],
      node: "undefined",
      invalidWindowAction: {
        ok: false,
        error: expect.objectContaining({ code: "INVALID_INPUT" }),
      },
    });
    await notch.getByRole("button", { name: /Expand Rewind/ }).hover();
    await expect(notch.getByLabel("Ask Rewind")).toBeVisible();
    await notch.getByLabel("Ask Rewind").click();
    await captureExpandedNotch(notch, "notch-expanded");
    await notch.getByLabel("Ask Rewind").fill("Start my session");
    await notch.getByLabel("Ask Rewind").press("Tab");
    await expect(
      notch.getByRole("button", { name: "Run command" }),
    ).toBeFocused();
    await notch.keyboard.press("Enter");
    await expect(notch.getByTestId("notch-recording-status")).toHaveText(
      "Session active · Recording off",
    );
    expect(
      await desktop.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({
      ok: true,
      value: { collection: "off", preferences: { collectionConsent: false } },
    });
    // A separate synthetic native window models click-away without observing
    // any personal application or starting a real collector.
    // CDP input does not activate a native Windows HWND as a physical click does.
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind notch")
        ?.focus(),
    );
    await application.evaluate(({ BrowserWindow }) => {
      const probe = new BrowserWindow({
        title: "Rewind focus verification",
        width: 200,
        height: 100,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      probe.show();
      probe.focus();
    });
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind focus verification")
        ?.destroy(),
    );
    await notch.getByRole("button", { name: /Expand Rewind/ }).focus();
    await notch.getByRole("button", { name: /Expand Rewind/ }).press("Enter");
    await expect(notch.getByLabel("Ask Rewind")).toBeVisible();
    await notch.getByLabel("Ask Rewind").press("Escape");
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    // Restore is the same native event delivered by a Windows taskbar click.
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.restore(),
    );
    await expect(desktop.getByRole("heading", { level: 1 })).toHaveText(
      "Search",
    );
    await expect(desktop.getByLabel("Search history")).toHaveValue(
      "my retained draft",
    );
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Rewind notch")
          ?.isVisible(),
      ),
    ).toBe(false);
    await desktop.screenshot({
      path: "test-results/premium-desktop-restored.png",
    });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    await notch.getByRole("button", { name: /Expand Rewind/ }).hover();
    await notch
      .getByRole("button", { name: "Open Rewind", exact: true })
      .click();
    await expect(desktop.getByLabel("Search history")).toHaveValue(
      "my retained draft",
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    await expect(
      notch.getByRole("button", { name: /Expand Rewind/ }),
    ).toBeVisible();
    await notch.getByRole("button", { name: /Expand Rewind/ }).hover();
    await notch
      .getByRole("button", { name: "Hide notch", exact: true })
      .click();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === "Rewind notch")
          ?.isVisible(),
      ),
    ).toBe(false);
    // Second-instance activation shares the tray Open Rewind restore path.
    await application.evaluate(({ app }) =>
      app.emit("second-instance", {}, [], "", {}),
    );
    await expect(desktop.getByLabel("Search history")).toHaveValue(
      "my retained draft",
    );
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});

test("notch session, recall and reviewed checkpoint actions use the same encrypted worker", async ({
  profile,
}) => {
  let application = await launchVerificationApp(profile);
  try {
    let desktop = await application.firstWindow();
    await expect(desktop.getByTestId("session-status")).toHaveText(
      "not started",
    );
    await desktop
      .getByRole("button", { name: "Allow Windows activity for this launch" })
      .click();
    await desktop
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(desktop.getByTestId("collection-status")).toHaveText(
      "Collection active",
    );
    await expect
      .poll(
        async () => {
          const result = await desktop.evaluate(() =>
            (window as unknown as { rewind: DesktopApi }).rewind.timeline.query(
              { limit: 100 },
            ),
          );
          return result.ok ? result.value.length : 0;
        },
        { timeout: 12000 },
      )
      .toBeGreaterThanOrEqual(55);
    const session = await desktop.evaluate(() =>
      // Retain identity across both views.
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    const created = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    const notch = await created;
    await expect(
      notch.getByRole("button", {
        name: "Expand Rewind · Recording",
        exact: true,
      }),
    ).toBeVisible();
    await notch.screenshot({
      path: "test-results/premium-notch-recording-collapsed.png",
    });
    await notch.getByRole("button", { name: /Expand Rewind/ }).hover();
    await expect(notch.getByTestId("notch-recording-status")).toHaveText(
      "Recording",
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind notch")
        ?.focus(),
    );
    await notch.getByLabel("Ask Rewind").click();
    await captureExpandedNotch(notch, "notch-recording");
    await notch
      .getByRole("button", { name: "Pause session", exact: true })
      .click();
    await expect(notch.getByTestId("notch-recording-status")).toHaveText(
      "Session paused",
    );
    await expect(desktop.getByTestId("session-status")).toHaveText("paused");
    await notch.getByLabel("Ask Rewind").fill("Find Synthetic");
    await notch.getByRole("button", { name: "Run command" }).click();
    await expect(notch.locator(".notch-results li")).toHaveCount(5);
    await captureExpandedNotch(notch, "notch-search");
    await notch
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(
      notch.getByRole("group", {
        name: "Select recent evidence from this session",
      }),
    ).toBeVisible();
    await notch
      .getByLabel("Checkpoint name", { exact: true })
      .fill("Notch synthetic checkpoint");
    await notch.getByRole("checkbox").first().check();
    await notch
      .getByRole("button", { name: "Save selected checkpoint" })
      .click();
    await expect(
      notch.getByText(
        "Checkpoint “Notch synthetic checkpoint” saved. Manage Keep in Rewind.",
        { exact: true },
      ),
    ).toBeVisible();
    const saved = await desktop.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.checkpoints.list({
        limit: 100,
      }),
    );
    await captureExpandedNotch(notch, "notch-checkpoint");
    expect(saved).toMatchObject({
      ok: true,
      value: [
        { name: "Notch synthetic checkpoint", kept: false, activityCount: 1 },
      ],
    });
    await notch
      .getByRole("button", { name: "Resume session", exact: true })
      .click();
    await expect(notch.getByTestId("notch-recording-status")).toHaveText(
      "Recording",
    );
    await notch
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await notch.getByRole("checkbox").first().check();
    const activityBefore = await desktop.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
        limit: 1,
      }),
    );
    await expect
      .poll(async () => {
        const next = await desktop.evaluate(() =>
          (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
            limit: 1,
          }),
        );
        return next.ok ? next.value[0]?.id : null;
      })
      .not.toBe(activityBefore.ok ? activityBefore.value[0]?.id : null);
    await expect(notch.getByRole("checkbox").first()).toBeChecked();
    await notch
      .getByRole("button", { name: "Open Rewind", exact: true })
      .click();
    await expect(desktop.getByTestId("session-status")).toHaveText("active");
    const resumed = await desktop.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    expect(resumed.ok && resumed.value.session?.id).toEqual(
      session.ok && session.value.session?.id,
    );
    const exited = application.waitForEvent("close");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.close(),
    );
    await exited;
    application = await launchVerificationApp(profile);
    desktop = await application.firstWindow();
    await expect(desktop.getByTestId("session-status")).toHaveText("ended");
    await expect(desktop.getByTestId("collection-status")).toHaveText(
      "Collection off",
    );
    const persisted = await desktop.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.checkpoints.list({
        limit: 100,
      }),
    );
    expect(persisted).toMatchObject({
      ok: true,
      value: [{ name: "Notch synthetic checkpoint" }],
    });
    expect(
      await application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    const reopened = application.waitForEvent("window");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Rewind")
        ?.minimize(),
    );
    const freshNotch = await reopened;
    await freshNotch.getByRole("button", { name: /Expand Rewind/ }).hover();
    await freshNotch
      .getByRole("button", { name: "What was I working on?", exact: true })
      .click();
    await expect(freshNotch.locator(".notch-results li")).toHaveCount(5);
    // Exercise full-app authority invalidation against an already-visible
    // overlay query. This only deletes this test's marked synthetic history.
    expect(
      await desktop.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ includeKept: false, confirmed: true }),
      ),
    ).toMatchObject({ ok: true });
    await expect(freshNotch.locator(".notch-results li")).toHaveCount(0);
    await freshNotch
      .getByRole("button", { name: "What was I working on?", exact: true })
      .click();
    await expect(
      freshNotch.getByText(
        "No matching recorded activity. Search saved file contents in the full app.",
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await application.close();
  }
});
