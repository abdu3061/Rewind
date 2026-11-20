import { expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";

test.skip(process.platform !== "win32", "Windows packaged target.");
async function navigate(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
}
async function recordAndConfigure(page: Page) {
  await page.getByRole("button", { name: "Allow Windows activity" }).click();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.timeline.query({
          limit: 10,
        }),
      );
      return result.ok ? result.value.length : 0;
    })
    .toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await navigate(page, "Settings");
  await page
    .getByRole("button", { name: "Configure Gemini key", exact: true })
    .click();
  await expect(
    page.getByText(
      "Key saved in encrypted local storage. Cloud approval is still off.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.assistant.state(),
    ),
  ).toMatchObject({ ok: true, value: { configured: true, permission: false } });
  await page.getByRole("button", { name: "Allow cloud questions" }).click();
  await expect(
    page.getByRole("button", { name: "Revoke cloud approval" }),
  ).toBeVisible();
  await navigate(page, "Search");
  await expect(page.getByTestId("timeline-event").first()).toBeVisible();
  await page.getByLabel("Select observation for Gemini").nth(0).check();
}
async function prepare(page: Page, question: string) {
  await page.getByLabel("Question for Gemini").fill(question);
  await page
    .getByRole("button", { name: "Prepare local sharing review" })
    .click();
  await expect(
    page.getByRole("region", { name: "Question sharing review" }),
  ).toBeVisible();
}
async function approveAndSend(page: Page, key = "E1") {
  await page
    .getByRole("checkbox", { name: new RegExp(`Share ${key}:`) })
    .check();
  await page
    .getByRole("button", { name: "Send reviewed question to Gemini" })
    .click();
}
test("normal Settings and Search use sealed configuration, explicit sharing subsets, actual source citations and restart-scoped approval", async ({
  profile,
}, info) => {
  test.setTimeout(60000);
  writeFileSync(
    path.join(profile, "assistant-fixture.json"),
    JSON.stringify({ format: 1, syntheticAssistant: true }),
  );
  let application = await launchVerificationApp(profile);
  try {
    let page = await application.firstWindow();
    await recordAndConfigure(page);
    const records = await page.evaluate(async () => {
      const result = await (
        window as unknown as { rewind: DesktopApi }
      ).rewind.timeline.query({ limit: 50 });
      if (!result.ok) throw new Error("SYNTHETIC_HISTORY_UNAVAILABLE");
      return result.value;
    });
    await page.getByLabel("Select observation for Gemini").nth(1).check();
    await prepare(page, "Which synthetic title was recorded?");
    await expect(
      page.getByRole("button", { name: "Send reviewed question to Gemini" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Gemini answer" }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("sharing-review.png"),
      fullPage: true,
    });
    await approveAndSend(page, "E2");
    const answer = page.getByRole("region", { name: "Gemini answer" });
    await expect(answer).toBeVisible();
    const second = records[1]!,
      first = records[0]!;
    if (first.type !== "foreground" || second.type !== "foreground")
      throw new Error("SYNTHETIC_FOREGROUND_EXPECTED");
    await expect(answer).toContainText(second.payload.windowTitle);
    await expect(answer).not.toContainText(first.payload.windowTitle);
    await expect(answer.getByText(/Source 1:/)).toBeVisible();
    await answer.getByText(/Source 1:/).click();
    await expect(answer).toContainText("title-only");
    await expect(answer.locator("img")).toHaveCount(0);
    await expect(answer).toContainText("<img src=x onerror=alert(1)>");
    expect(await page.content()).not.toContain(
      "Synthetic_Rewind_Only_Gemini_16905",
    );
    const invalid = await page.evaluate(() => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind
        .assistant;
      return Promise.all([
        Reflect.apply(api.configure, api, [false]),
        Reflect.apply(api.prepare, api, [
          { question: "Question", activityIds: [], evidence: [] },
        ]),
        Reflect.apply(api.ask, api, [
          { id: "invalid", keys: ["E1"], confirmed: true, apiKey: "untrusted" },
        ]),
      ]);
    });
    expect(
      invalid.every(
        (result) => !result.ok && result.error.code === "INVALID_INPUT",
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("gemini-answer.png"),
      fullPage: true,
    });
    await application.close();
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    const state = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.assistant.state(),
    );
    expect(state).toMatchObject({
      ok: true,
      value: { configured: true, permission: false },
    });
    await navigate(page, "Settings");
    await expect(
      page.getByRole("button", {
        name: "Allow cloud questions",
      }),
    ).toBeEnabled();
    await page.screenshot({
      path: info.outputPath("gemini-settings.png"),
      fullPage: true,
    });
  } finally {
    await application.close();
  }
});
test("provider failure and missing information stay explicit; Stop cancels a pending SDK request and confirmed key removal preserves history", async ({
  profile,
}) => {
  test.setTimeout(60000);
  writeFileSync(
    path.join(profile, "assistant-fixture.json"),
    JSON.stringify({ format: 1, syntheticAssistant: true }),
  );
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await recordAndConfigure(page);
    await prepare(page, "synthetic-provider-error");
    await approveAndSend(page);
    await expect(
      page.getByRole("alert").filter({ hasText: "Gemini could not complete" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Gemini answer" }),
    ).toHaveCount(0);
    await prepare(page, "synthetic-missing-evidence");
    await approveAndSend(page);
    await expect(
      page.getByRole("region", { name: "Gemini answer" }),
    ).toContainText(
      "The selected evidence does not establish a complete answer.",
    );
    await prepare(page, "synthetic-provider-delay");
    await approveAndSend(page);
    await expect(
      page.getByText("Waiting for a verified Gemini answer..."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Stop Gemini request" }).click();
    await expect
      .poll(async () => {
        const result = await page.evaluate(() =>
          (
            window as unknown as { rewind: DesktopApi }
          ).rewind.assistant.state(),
        );
        return result.ok && !result.value.busy;
      })
      .toBe(true);
    await expect(
      page.getByRole("region", { name: "Gemini answer" }),
    ).toHaveCount(0);
    await navigate(page, "Settings");
    await page.getByLabel("Remove the saved Gemini key from Rewind").check();
    await page.getByRole("button", { name: "Confirm key removal" }).click();
    await expect(page.getByText(/Saved key removed\./)).toBeVisible();
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.assistant.state(),
      ),
    ).toMatchObject({
      ok: true,
      value: { configured: false, permission: false },
    });
    const used = await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.storage.usage(),
    );
    expect(used.ok && used.value.activityCount).toBeGreaterThan(0);
  } finally {
    await application.close();
  }
});
