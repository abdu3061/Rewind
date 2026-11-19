import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test, launchVerificationApp } from "./fixtures";

test("minimum window preserves keyboard navigation and all six release screens", async ({
  profile,
}, testInfo) => {
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await expect(page.getByTestId("session-status")).toHaveText("not started");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(800, 600),
    );
    await page.getByRole("link", { name: "Skip to content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    const pages = [
      "Dashboard",
      "Timeline",
      "Search",
      "Files",
      "Checkpoints",
      "Settings",
    ];
    for (const [index, name] of pages.entries()) {
      const navigation = page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: new RegExp(name) });
      await navigation.focus();
      await page.keyboard.press("Enter");
      await expect(navigation).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByRole("heading", { level: 1, name, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${index + 1}-${name.toLowerCase()}.png`),
        fullPage: true,
      });
    }
  } finally {
    await application.close();
  }
});

test("renderer loss drains an active synthetic session before exit and restart", async ({
  profile,
}) => {
  const application = await launchVerificationApp(profile);
  let closed = false;
  application.on("close", () => {
    closed = true;
  });
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("active");
    const exited = application.waitForEvent("close");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    await exited;
    const records = readFileSync(
      path.join(profile, "logs", "operations.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(records.map((record) => record.code)).toContain("RENDERER_GONE");
    expect(records.at(-1)?.code).toBe("DESKTOP_STOPPED");
    const restarted = await launchVerificationApp(profile);
    try {
      const fresh = await restarted.firstWindow();
      await expect(fresh.getByTestId("session-status")).toHaveText("ended");
      await expect(fresh.getByTestId("collection-status")).toHaveText(
        "Collection off",
      );
    } finally {
      await restarted.close();
    }
  } finally {
    if (!closed) await application.close();
  }
});

test("obsolete installer invocation exits without opening history or starting the desktop", async ({
  profile,
}) => {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    APPDATA: profile,
    LOCALAPPDATA: profile,
  };
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      path.resolve("apps/desktop/out/Rewind-win32-x64/Rewind.exe"),
      ["--squirrel-obsolete", `--rewind-fixture-root=${profile}`],
      { env, windowsHide: true, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("SYNTHETIC_INSTALLER_TIMEOUT"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  expect(code).toBe(0);
  expect(existsSync(path.join(profile, "secure"))).toBe(false);
  expect(existsSync(path.join(profile, "logs"))).toBe(false);
});
