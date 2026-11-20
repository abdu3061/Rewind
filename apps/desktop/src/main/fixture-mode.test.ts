import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readBrowserFixture,
  readAssistantFixture,
  validateFixtureRoot,
} from "./fixture-mode";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rewind-e2e-"));
  writeFileSync(
    path.join(root, "synthetic-fixture.json"),
    JSON.stringify({ format: 1, synthetic: true }),
  );
});
it("requires an explicit bounded assistant marker and never activates it without a selected CLI profile", () => {
  expect(readAssistantFixture(null)).toBe(false);
  expect(readAssistantFixture(root)).toBe(false);
  writeFileSync(
    path.join(root, "assistant-fixture.json"),
    JSON.stringify({ format: 1, syntheticAssistant: true }),
  );
  expect(readAssistantFixture(root)).toBe(true);
  expect(readAssistantFixture(null)).toBe(false);
  for (const value of [
    { format: 1, syntheticAssistant: false },
    { format: 2, syntheticAssistant: true },
    { format: 1, syntheticAssistant: true, endpoint: "https://example.test" },
  ]) {
    writeFileSync(
      path.join(root, "assistant-fixture.json"),
      JSON.stringify(value),
    );
    expect(() => readAssistantFixture(root)).toThrow(
      "INVALID_ASSISTANT_FIXTURE",
    );
  }
});
afterEach(() => {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (
    !relative.startsWith("rewind-e2e-") ||
    relative.includes(path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error("UNSAFE_FIXTURE_CLEANUP");
  rmSync(root, { recursive: true, force: true });
});
it("admits a generated browser namespace only inside the explicitly marked CLI fixture", () => {
  expect(validateFixtureRoot(root)).toBe(root);
  expect(readBrowserFixture(null)).toBeNull();
  expect(readBrowserFixture(root)).toBeNull();
  const hostName = `com.rewind.test.${"a".repeat(32)}`;
  writeFileSync(
    path.join(root, "browser-fixture.json"),
    JSON.stringify({ format: 1, hostName }),
  );
  expect(readBrowserFixture(root)).toEqual({
    root: path.join(root, "browser-assets"),
    hostName,
  });
  expect(readBrowserFixture(null)).toBeNull();
});
it.each([
  { format: 1, hostName: "com.rewind.bridge" },
  {
    format: 1,
    hostName: `com.rewind.test.${"b".repeat(32)}`,
    root: "C:\\ExpandedFixture",
  },
  { format: 1, hostName: "foreign.host" },
  { format: 2, hostName: `com.rewind.test.${"b".repeat(32)}` },
])(
  "rejects unsupported browser fixture metadata without changing the marker",
  (input) => {
    const marker = path.join(root, "synthetic-fixture.json"),
      original = readFileSync(marker);
    writeFileSync(
      path.join(root, "browser-fixture.json"),
      JSON.stringify(input),
    );
    expect(() => readBrowserFixture(root)).toThrow("INVALID_BROWSER_FIXTURE");
    expect(readFileSync(marker)).toEqual(original);
  },
);
