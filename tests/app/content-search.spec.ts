import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type ElectronApplication } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";
import {
  docxEntries,
  pdfFixture,
  zipFixture,
} from "../../packages/documents/src/fixtures.test-support";

test.skip(process.platform !== "win32", "Windows packaged target.");
const needle = "PackagedCapturedBody42817";
async function selectAndStart(
  application: ElectronApplication,
  folder: string,
) {
  const page = await application.firstWindow();
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, folder);
  await page.getByRole("button", { name: /Files/ }).click();
  await page
    .getByRole("button", { name: "Select protected folder", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Allow file protection",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: /Dashboard/ }).click();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.getByTestId("collection-status")).toHaveText(
    "Recording on",
    { timeout: 15000 },
  );
  return page;
}

test("normal Search finds actual captured bodies, previews and recovers original bytes, and preserves kept text across deletion and encrypted restart", async ({
  profile,
}) => {
  test.setTimeout(90000);
  const folder = path.join(profile, "content-fixtures");
  mkdirSync(folder);
  const literal = `<img src=x onerror="window.__contentExecuted=1"> ${needle}`;
  const word = zipFixture(
    docxEntries(
      `<w:p><w:r><w:t>${literal.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</w:t></w:r></w:p>`,
    ),
  );
  writeFileSync(path.join(folder, "ordinary.docx"), word);
  writeFileSync(
    path.join(folder, "ordinary.pdf"),
    pdfFixture([`Synthetic ${needle}`]),
  );
  writeFileSync(path.join(folder, "ordinary.txt"), `Synthetic ${needle}`);
  let application = await launchVerificationApp(profile);
  const destination = path.join(profile, "recovered-searched.docx");
  try {
    let page = await selectAndStart(application, folder);
    for (const name of ["ordinary.docx", "ordinary.pdf", "ordinary.txt"])
      writeFileSync(
        path.join(folder, name),
        readFileSync(path.join(folder, name)),
      );
    await page.getByRole("button", { name: /Search/ }).click();
    let content = page.getByRole("region", {
      name: "Inside saved files",
      exact: true,
    });
    await expect(
      content.getByLabel("Captured content index status"),
    ).toContainText("3 of 3 saved versions searchable", {
      timeout: 25000,
    });
    await page.getByLabel("Search history", { exact: true }).fill(needle);
    await page.getByLabel("Search history", { exact: true }).press("Enter");
    await expect(
      content
        .getByRole("list", { name: "Captured text results" })
        .getByRole("listitem"),
    ).toHaveCount(3);
    expect(
      await page.evaluate(() => Reflect.get(window, "__contentExecuted")),
    ).toBeUndefined();
    await expect(content.locator("img")).toHaveCount(0);
    await page.screenshot({
      path: "test-results/captured-content-search.png",
      fullPage: true,
    });
    await content
      .getByRole("button", {
        name: "Preview ordinary.docx from content search",
        exact: true,
      })
      .click();
    let preview = content.locator(
      'section[aria-labelledby="content-preview-heading"]',
    );
    await expect(preview.locator(".captured-preview")).toHaveText(
      `${literal}\n`,
      { timeout: 20000 },
    );
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await preview
      .getByRole("button", {
        name: "Choose recovery copy destination",
        exact: true,
      })
      .click();
    await preview
      .getByRole("button", { name: "Confirm save recovery copy", exact: true })
      .click();
    await expect(
      preview.getByText(/Recovery copy saved and verified:/),
    ).toBeVisible({ timeout: 20000 });
    expect(readFileSync(destination).equals(word)).toBe(true);
    const kept = await page.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      const versions = await api.versions.list({ limit: 10 });
      if (!versions.ok) throw new Error("SYNTHETIC_VERSIONS_MISSING");
      const source = versions.value.find(
        (item) => item.displayName === "ordinary.docx",
      )!;
      return api.checkpoints.create({
        name: "Kept searched Word",
        sessionId: source.version.sessionId,
        kept: true,
        fileVersionIds: [source.version.id],
        activityIds: [],
      });
    });
    expect(kept.ok).toBe(true);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
      ),
    ).toMatchObject({ ok: true, value: { versionCount: 1 } });
    await expect(
      content
        .getByRole("list", { name: "Captured text results" })
        .getByRole("listitem"),
    ).toHaveCount(1);
    await application.close();
    for (const file of readdirSync(path.join(profile, "secure")))
      expect(
        readFileSync(path.join(profile, "secure", file)).includes(
          Buffer.from(needle),
        ),
      ).toBe(false);
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /Search/ }).click();
    content = page.getByRole("region", {
      name: "Inside saved files",
      exact: true,
    });
    await page.getByLabel("Search history", { exact: true }).fill(needle);
    await page.getByLabel("Search history", { exact: true }).press("Enter");
    await expect(
      content
        .getByRole("list", { name: "Captured text results" })
        .getByRole("listitem"),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({ ok: true, value: { filePermission: false } });
    await content
      .getByRole("button", {
        name: "Preview ordinary.docx from content search",
        exact: true,
      })
      .click();
    preview = content.locator(
      'section[aria-labelledby="content-preview-heading"]',
    );
    await expect(preview.locator(".captured-preview")).toHaveText(
      `${literal}\n`,
      { timeout: 20000 },
    );
    await page.screenshot({
      path: "test-results/captured-content-kept-restart.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: true }),
      ),
    ).toMatchObject({ ok: true, value: { versionCount: 0 } });
    await expect(
      content
        .getByRole("list", { name: "Captured text results" })
        .getByRole("listitem"),
    ).toHaveCount(0);
    await expect(
      content.locator('section[aria-labelledby="content-preview-heading"]'),
    ).toHaveCount(0);
    expect(readFileSync(destination).equals(word)).toBe(true);
  } finally {
    await application.close();
  }
});

test("normal Search stops automatic content work, explicitly indexes saved history while paused and reports unavailable documents without accepting injected capability arguments", async ({
  profile,
}) => {
  test.setTimeout(90000);
  const folder = path.join(profile, "backfill-fixtures");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "ordinary.txt"), `Synthetic ${needle}`);
  writeFileSync(
    path.join(folder, "encrypted.pdf"),
    pdfFixture(["not searchable"], true),
  );
  const application = await launchVerificationApp(profile);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /Search/ }).click();
    await page
      .getByRole("button", { name: "Stop content indexing", exact: true })
      .click();
    await expect(
      page.getByText(/Automatic indexing is paused until Rewind restarts/),
    ).toBeVisible();
    await selectAndStart(application, folder);
    for (const name of ["ordinary.txt", "encrypted.pdf"])
      writeFileSync(
        path.join(folder, name),
        readFileSync(path.join(folder, name)),
      );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await (
            window as unknown as { rewind: DesktopApi }
          ).rewind.content.state();
          return result.ok ? result.value.counts : null;
        }),
      )
      .toEqual({ eligible: 2, indexed: 0, unavailable: 0, pending: 2 });
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.sessions.pause(),
      ),
    ).toMatchObject({ ok: true });
    const invalid = await page.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      return [
        await Reflect.apply(api.content.state, null, ["injected"]),
        await Reflect.apply(api.content.stop, null, ["injected"]),
        await Reflect.apply(api.content.indexSaved, null, [
          { confirmed: false, retryFailures: true },
        ]),
        await Reflect.apply(api.content.search, null, [
          {
            text: "synthetic",
            limit: 25,
            path: "C:\\Synthetic",
            key: "injected",
          },
        ]),
        await Reflect.apply(api.content.clearSearch, null, ["injected"]),
      ];
    });
    expect(
      invalid.every(
        (result) => !result.ok && result.error.code === "INVALID_INPUT",
      ),
    ).toBe(true);
    await page.getByRole("button", { name: /Search/ }).click();
    const content = page.getByRole("region", {
      name: "Inside saved files",
      exact: true,
    });
    await content
      .getByRole("button", { name: "Index saved content", exact: true })
      .click();
    await expect(
      content.getByLabel("Captured content index status"),
    ).toContainText(
      "1 of 2 saved versions searchable · 0 waiting · 1 unreadable",
      { timeout: 25000 },
    );
    await content.getByLabel("Retry unavailable documents").check();
    await expect(
      content.getByRole("button", { name: "Index saved content", exact: true }),
    ).toBeEnabled();
    await content
      .getByRole("button", { name: "Index saved content", exact: true })
      .click();
    await expect(
      content.getByLabel("Captured content index status"),
    ).toContainText(
      "1 of 2 saved versions searchable · 0 waiting · 1 unreadable",
      { timeout: 25000 },
    );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await (
            window as unknown as { rewind: DesktopApi }
          ).rewind.content.state();
          return result.ok
            ? {
                mode: result.value.indexing.mode,
                busy: result.value.indexing.busy,
                processed: result.value.indexing.processed,
                unavailable: result.value.indexing.unavailable,
              }
            : null;
        }),
      )
      .toEqual({ mode: "saved", busy: false, processed: 1, unavailable: 1 });
    await page.getByLabel("Search history", { exact: true }).fill(needle);
    await page.getByLabel("Search history", { exact: true }).press("Enter");
    await expect(
      content
        .getByRole("list", { name: "Captured text results" })
        .getByRole("listitem"),
    ).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({ ok: true, value: { session: { status: "paused" } } });
    await page.screenshot({
      path: "test-results/captured-content-backfill.png",
      fullPage: true,
    });
  } finally {
    await application.close();
  }
});
