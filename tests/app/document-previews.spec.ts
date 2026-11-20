import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type ElectronApplication } from "@playwright/test";
import type { DesktopApi } from "@rewind/contracts";
import { test, launchVerificationApp } from "./fixtures";
import {
  docxEntries,
  pdfFixture,
  imageOnlyPdfFixture,
  zipFixture,
} from "../../packages/documents/src/fixtures.test-support";

test.skip(process.platform !== "win32", "Windows packaged target.");
async function capture(
  application: ElectronApplication,
  folder: string,
  names: string[],
) {
  const page = await application.firstWindow();
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
  for (const name of names)
    writeFileSync(
      path.join(folder, name),
      readFileSync(path.join(folder, name)),
    );
  await page.getByRole("button", { name: /Files/ }).click();
  await expect(page.getByTestId("captured-version")).toHaveCount(names.length, {
    timeout: 15000,
  });
  expect(
    await page.evaluate(() =>
      (window as unknown as { rewind: DesktopApi }).rewind.sessions.pause(),
    ),
  ).toMatchObject({ ok: true });
  return page;
}

test("real captured DOCX/PDF previews are escaped, recover original bytes and survive kept-checkpoint deletion and restart", async ({
  profile,
}) => {
  test.setTimeout(90000);
  const folder = path.join(profile, "document-fixtures");
  mkdirSync(folder);
  const wordText =
    '<img src=x onerror="window.__docxExecuted=1"> Synthetic Word captured text 72641';
  const word = zipFixture(
    docxEntries(
      `<w:p><w:r><w:t>${wordText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</w:t></w:r></w:p>`,
    ),
  );
  const pdf = pdfFixture(["Synthetic captured PDF text 72641"]);
  writeFileSync(path.join(folder, "synthetic.docx"), word);
  writeFileSync(path.join(folder, "synthetic.pdf"), pdf);
  let application = await launchVerificationApp(profile);
  try {
    let page = await capture(application, folder, [
      "synthetic.docx",
      "synthetic.pdf",
    ]);
    await page
      .getByRole("button", { name: /Preview synthetic.docx captured/ })
      .click();
    await expect(page.locator(".captured-preview")).toHaveText(
      `${wordText}\n`,
      { timeout: 20000 },
    );
    await expect(page.getByText(/Extracted DOCX body text/)).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, "__docxExecuted")),
    ).toBeUndefined();
    const destination = path.join(profile, "recovered-synthetic.docx");
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await page
      .getByRole("button", {
        name: "Choose recovery copy destination",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Confirm save recovery copy", exact: true })
      .click();
    await expect(
      page.getByText(/Recovery copy saved and verified:/),
    ).toBeVisible({ timeout: 20000 });
    expect(readFileSync(destination).equals(word)).toBe(true);
    await page
      .getByRole("button", { name: /Preview synthetic.pdf captured/ })
      .click();
    await expect(page.locator(".captured-preview")).toContainText(
      "Synthetic captured PDF text 72641",
      { timeout: 20000 },
    );
    await expect(page.getByText(/Extracted PDF selectable text/)).toBeVisible();
    // Native parser helpers can move foreground focus. A background Electron
    // window may throttle the animation frames used by screenshot capture.
    await application.evaluate(({ BrowserWindow }) => {
      const desktop = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Rewind",
      );
      if (!desktop) throw new Error("SYNTHETIC_DESKTOP_REQUIRED");
      desktop.show();
      desktop.focus();
    });
    await page.screenshot({
      path: "test-results/document-file-preview.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: /Checkpoints/ }).click();
    await page
      .getByLabel("Checkpoint name", { exact: true })
      .fill("Synthetic document checkpoint 72641");
    await page
      .getByRole("checkbox", { name: /Select version synthetic.docx/ })
      .check();
    await page
      .getByRole("checkbox", { name: /Select version synthetic.pdf/ })
      .check();
    await page
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(
      page.getByText("Checkpoint saved.", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview checkpoint version", exact: true })
      .first()
      .click();
    await expect(page.locator(".captured-preview")).toBeVisible({
      timeout: 20000,
    });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
      ),
    ).toMatchObject({
      ok: true,
      value: { versionCount: 2, keptCheckpointCount: 1 },
    });
    await expect(page.locator(".captured-preview")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Preview checkpoint version", exact: true })
      .first()
      .click();
    await expect(page.locator(".captured-preview")).toBeVisible({
      timeout: 20000,
    });
    await application.evaluate(({ BrowserWindow }) => {
      const desktop = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Rewind",
      );
      if (!desktop) throw new Error("SYNTHETIC_DESKTOP_REQUIRED");
      desktop.show();
      desktop.focus();
    });
    await page.screenshot({
      path: "test-results/document-checkpoint-preview.png",
      fullPage: true,
    });
    await application.close();
    for (const file of readdirSync(path.join(profile, "secure")))
      expect(
        readFileSync(path.join(profile, "secure", file)).includes(
          Buffer.from("Synthetic captured PDF text 72641"),
        ),
      ).toBe(false);
    application = await launchVerificationApp(profile);
    page = await application.firstWindow();
    await page.getByRole("button", { name: /Files/ }).click();
    await expect(page.getByTestId("captured-version")).toHaveCount(2);
    await page
      .getByRole("button", { name: /Preview synthetic.pdf captured/ })
      .click();
    await expect(page.locator(".captured-preview")).toContainText(
      "Synthetic captured PDF text 72641",
      { timeout: 20000 },
    );
    expect(readFileSync(path.join(folder, "synthetic.pdf")).equals(pdf)).toBe(
      true,
    );
    await expect(page.getByTestId("collection-status")).toHaveText(
      "Recording off",
    );
  } finally {
    await application.close();
  }
});

test("malformed and encrypted previews stay explicit and recoverable; cancelling a guarded pending request and deleting its history reject late content", async ({
  profile,
}) => {
  test.setTimeout(90000);
  const folder = path.join(profile, "document-failure-fixtures");
  mkdirSync(folder);
  writeFileSync(
    path.join(folder, "synthetic.pdf"),
    pdfFixture(["Synthetic delayed document text 72642"]),
  );
  writeFileSync(
    path.join(folder, "encrypted.pdf"),
    pdfFixture(["not shared"], true),
  );
  writeFileSync(
    path.join(folder, "malformed.docx"),
    Buffer.from("synthetic malformed zip"),
  );
  writeFileSync(path.join(folder, "image-only.pdf"), imageOnlyPdfFixture());
  const application = await launchVerificationApp(profile);
  try {
    const page = await capture(application, folder, [
      "synthetic.pdf",
      "encrypted.pdf",
      "malformed.docx",
      "image-only.pdf",
    ]);
    const invalid = await page.evaluate(async () => {
      const api = (window as unknown as { rewind: DesktopApi }).rewind;
      const versions = await api.versions.list({ limit: 1 });
      if (!versions.ok || !versions.value[0])
        throw new Error("SYNTHETIC_VERSION_MISSING");
      return [
        await api.versions.preview(versions.value[0].version.id, "invalid"),
        await api.versions.cancelPreview("invalid"),
      ];
    });
    expect(
      invalid.every(
        (result) => !result.ok && result.error.code === "INVALID_INPUT",
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: /Preview image-only.pdf captured/ })
      .click();
    await expect(
      page.getByText(/No selectable text was found; OCR is unavailable/),
    ).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".captured-preview")).toHaveText("");
    await page
      .getByRole("button", { name: /Preview encrypted.pdf captured/ })
      .click();
    await expect(
      page.getByText(/Password-protected documents are not previewed/),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByRole("button", {
        name: "Choose recovery copy destination",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: /Preview malformed.docx captured/ })
      .click();
    await expect(
      page.getByText(/The captured document could not be parsed/),
    ).toBeVisible({ timeout: 20000 });
    await application.evaluate(({ utilityProcess }) => {
      const state = { held: 0, exited: 0 };
      Reflect.set(globalThis, "__syntheticDocumentHold", state);
      const fork = utilityProcess.fork.bind(utilityProcess);
      utilityProcess.fork = (entry, args, options) => {
        const child = fork(entry, args, options);
        if (options?.serviceName === "Rewind document text preview") {
          const post = child.postMessage.bind(child);
          child.postMessage = (value) => {
            const message = structuredClone(value);
            state.held++;
            const timer = setTimeout(() => {
              try {
                post(message);
              } catch {
                /* Synthetic cancelled process. */
              } finally {
                if (message.bytes instanceof Uint8Array) message.bytes.fill(0);
              }
            }, 2000);
            child.once("exit", () => {
              clearTimeout(timer);
              if (message.bytes instanceof Uint8Array) message.bytes.fill(0);
              state.exited++;
            });
          };
        }
        return child;
      };
    });
    await page
      .getByRole("button", { name: /Preview synthetic.pdf captured/ })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          () => Reflect.get(globalThis, "__syntheticDocumentHold").held,
        ),
      )
      .toBe(1);
    await page
      .getByRole("button", { name: "Cancel preview", exact: true })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          () => Reflect.get(globalThis, "__syntheticDocumentHold").exited,
        ),
      )
      .toBe(1);
    await expect(page.locator(".captured-preview")).toHaveCount(0);
    await page
      .getByRole("button", { name: /Preview synthetic.pdf captured/ })
      .click();
    await expect
      .poll(() =>
        application.evaluate(
          () => Reflect.get(globalThis, "__syntheticDocumentHold").held,
        ),
      )
      .toBe(2);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { rewind: DesktopApi }
        ).rewind.storage.deleteHistory({ confirmed: true, includeKept: false }),
      ),
    ).toMatchObject({ ok: true, value: { versionCount: 0 } });
    await expect
      .poll(() =>
        application.evaluate(
          () => Reflect.get(globalThis, "__syntheticDocumentHold").exited,
        ),
      )
      .toBe(2);
    await page.waitForTimeout(2200);
    await expect(page.locator(".captured-preview")).toHaveCount(0);
    await expect(page.getByTestId("captured-version")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as unknown as { rewind: DesktopApi }).rewind.runtime.get(),
      ),
    ).toMatchObject({
      ok: true,
      value: { service: "ready", secureStorage: true, filePermission: false },
    });
  } finally {
    await application.close();
  }
});
