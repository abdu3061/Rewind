import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "The supported target is Windows.");

test("existing files are not imported, idle work is bounded and identical saves do not add versions across restart", async ({
  profile,
}, testInfo) => {
  test.setTimeout(90000);
  for (const name of ["Desktop", "Documents", "Downloads"])
    mkdirSync(path.join(profile, name));
  const file = path.join(profile, "Documents", "work.txt");
  for (let index = 0; index < 2500; index++)
    writeFileSync(
      path.join(profile, "Documents", "untouched-" + index + ".txt"),
      "Synthetic untouched content",
    );
  writeFileSync(file, "Synthetic original outside recording");
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Allow and start recording", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Updating recording...", exact: true }),
    ).toBeHidden({ timeout: 30000 });
    await expect(
      page.getByRole("button", {
        name: "Turn off automatic recording",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    const count = async () =>
      page.evaluate(async () => {
        const result = await (
          window as unknown as { rewind: DesktopApi }
        ).rewind.versions.list({ limit: 100 });
        return result.ok ? result.value.length : -1;
      });
    await application.evaluate(({ app }) => app.getAppMetrics());
    const samples = [];
    for (let index = 0; index < 5; index++) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Deliberate idle measurement interval.
      samples.push(
        await application.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .filter(
              (metric) =>
                metric.name === "Rewind recording engine" ||
                metric.serviceName === "Rewind recording engine",
            )
            .map((metric) => ({
              pid: metric.pid,
              cpuPercent: metric.cpu.percentCPUUsage,
              workingSetKiB: metric.memory.workingSetSize,
            })),
        ),
      );
    }
    expect(await count()).toBe(0);
    expect(samples.every((sample) => sample.length === 1)).toBe(true);
    const idleCpu =
      samples.reduce((sum, sample) => sum + sample[0]!.cpuPercent, 0) /
      samples.length;
    const memoryGrowthKiB =
      samples.at(-1)![0]!.workingSetKiB - samples[0]![0]!.workingSetKiB;
    expect(idleCpu).toBeLessThan(10);
    expect(memoryGrowthKiB).toBeLessThan(32 * 1024);
    const measurement = {
      synthetic: true,
      existingFiles: 2501,
      storedVersionsWhileIdle: 0,
      engineIdleCpuPercent: idleCpu,
      engineWorkingSetGrowthKiB: memoryGrowthKiB,
      samples,
    };
    console.log(
      "SYNTHETIC_CHANGE_ONLY_PERFORMANCE",
      JSON.stringify(measurement),
    );
    await testInfo.attach("idle-performance", {
      body: JSON.stringify(measurement, null, 2),
      contentType: "application/json",
    });
    writeFileSync(file, "Synthetic active saved change");
    await expect.poll(count, { timeout: 15000 }).toBe(1);
    writeFileSync(file, "Synthetic active saved change");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await count()).toBe(1);
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await expect(
      page.getByTestId("timeline-event").filter({ hasText: "work.txt" }),
    ).toHaveCount(1);
    await expect(
      page.getByTestId("timeline-event").filter({ hasText: "untouched-" }),
    ).toHaveCount(0);
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    writeFileSync(file, "Synthetic active saved change");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await count()).toBe(1);
    writeFileSync(file, "Synthetic second distinct saved change");
    await expect.poll(count, { timeout: 15000 }).toBe(2);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByLabel("Search history", { exact: true }).fill("work.txt");
    await page.getByLabel("Search history", { exact: true }).press("Enter");
    await expect(
      page.getByTestId("timeline-event").filter({ hasText: "work.txt" }),
    ).toHaveCount(2);
  } finally {
    await application.close();
  }
});

test("change-only recording ignores old large folders and coalesces a save burst", async ({
  profile,
}) => {
  test.setTimeout(45000);
  for (const name of ["Desktop", "Documents", "Downloads"])
    mkdirSync(path.join(profile, name));
  const documents = path.join(profile, "Documents");
  for (let index = 0; index < 2105; index++)
    writeFileSync(
      path.join(documents, "unsupported-" + index + ".bin"),
      "Synthetic unsupported fixture",
    );
  const saved = path.join(documents, "supported.txt");
  writeFileSync(saved, "Synthetic old file");
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Allow and start recording", exact: true })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    writeFileSync(saved, "Synthetic save 1");
    writeFileSync(saved, "Synthetic save 2");
    writeFileSync(saved, "Synthetic save final");
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const result = await (
              window as unknown as { rewind: DesktopApi }
            ).rewind.versions.list({ limit: 100 });
            return result.ok ? result.value.length : 0;
          }),
        { timeout: 15000 },
      )
      .toBe(1);
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
  } finally {
    await application.close();
  }
});

test("one permission starts real default-folder capture, remembers approval and honors exclusions and revoke", async ({
  profile,
}) => {
  test.setTimeout(60000); // Three launches plus real native default-folder admission.
  for (const name of ["Desktop", "Documents", "Downloads"])
    mkdirSync(path.join(profile, name));
  const saved = path.join(profile, "Documents", "draft.txt");
  const secret = path.join(profile, "Desktop", "exclude-me.txt");
  writeFileSync(saved, "Synthetic automatic recording draft");
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording off",
    );
    await expect(
      page.getByLabel("Automatic file protection locations"),
    ).toContainText(path.join(profile, "Documents"));
    await expect(
      page.getByRole("button", {
        name: "Allow and start recording",
        exact: true,
      }),
    ).toBeEnabled();
    // Strict preload validation: no missing confirmation or renderer-supplied roots.
    expect(
      await page.evaluate(() => {
        const api = (window as unknown as { rewind: DesktopApi }).rewind;
        return (api.recording.configure as (...args: unknown[]) => unknown)(
          true,
        );
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    await page
      .getByRole("button", { name: "Allow and start recording", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Updating recording...", exact: true }),
    ).toBeHidden({ timeout: 30000 });
    await expect(
      page.getByRole("button", {
        name: "Turn off automatic recording",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    const first = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    expect(first.ok && first.value.session?.status).toBe("active");
    writeFileSync(saved, "Synthetic automatic recording draft");
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(() =>
            (window as unknown as { rewind: DesktopApi }).rewind.versions.list({
              limit: 100,
            }),
          );
          return result.ok ? result.value.map((item) => item.displayName) : [];
        },
        { timeout: 20000 },
      )
      .toContain("draft.txt");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByLabel("Excluded files or folders (one full path per line)")
      .fill(secret);
    await page
      .getByLabel("Excluded applications (one name per line)")
      .fill("SyntheticEditor.exe");
    await page
      .getByRole("button", { name: "Save exclusions", exact: true })
      .click();
    await expect(
      page.getByText("Exclusions saved. Recording continues."),
    ).toBeVisible();
    writeFileSync(secret, "Synthetic excluded new save");
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    await page.screenshot({
      path: "test-results/automatic-recording-enabled.png",
      fullPage: true,
    });
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
    const next = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.get(),
    );
    expect(next.ok && next.value.session?.id).not.toBe(
      first.ok && first.value.session?.id,
    );
    const state = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
    );
    expect(state).toMatchObject({
      ok: true,
      value: {
        automaticRecording: true,
        filePermission: true,
        browserPermission: false,
        assistant: { permission: false },
        preferences: {
          excludedApplications: ["SyntheticEditor.exe"],
          excludedFolderPaths: [secret],
        },
      },
    });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording off",
    );
    const captured = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.versions.list({
        limit: 100,
      }),
    );
    expect(
      captured.ok &&
        captured.value.some((item) => item.displayName === "exclude-me.txt"),
    ).toBe(false);
    await page
      .getByRole("button", {
        name: "Turn off automatic recording",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Allow and start recording",
        exact: true,
      }),
    ).toBeVisible();
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording off",
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({
      ok: true,
      value: { automaticRecording: false, filePermission: false },
    });
    await page.setViewportSize({ width: 800, height: 600 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/automatic-recording-setup.png",
      fullPage: true,
    });
  } finally {
    await application.close();
  }
});

test("remembered approval stays stopped after a worker crash and reconnect", async ({
  profile,
}) => {
  for (const name of ["Desktop", "Documents", "Downloads"])
    mkdirSync(path.join(profile, name));
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await page
      .getByRole("button", { name: "Allow and start recording", exact: true })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
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
        throw new Error("SYNTHETIC_WORKER_REQUIRED");
      process.kill(workers[0].pid);
    });
    await page
      .getByRole("button", { name: "Reconnect recording service" })
      .click();
    await expect(page.getByTestId("session-status")).toHaveText("paused");
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording off",
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        automaticRecording: true,
        filePermission: false,
        preferences: { collectionConsent: false },
      },
    });
    await page
      .getByRole("button", {
        name: "Re-enable approved recording",
        exact: true,
      })
      .click();
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording on",
    );
  } finally {
    await application.close();
  }
});
