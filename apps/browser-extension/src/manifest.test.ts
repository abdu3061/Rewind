import { readFileSync } from "node:fs";
import { createHash, createPublicKey } from "node:crypto";
import { expect, it } from "vitest";

it("declares only the metadata/native/profile capabilities, excludes incognito and keeps controls non-embeddable", () => {
  const manifest = JSON.parse(
    readFileSync("apps/browser-extension/public/manifest.json", "utf8"),
  ) as Record<string, unknown>;
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.incognito).toBe("not_allowed");
  expect(manifest.minimum_chrome_version).toBe("116");
  expect(manifest.permissions).toEqual(["tabs", "nativeMessaging", "storage"]);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(manifest.externally_connectable).toBeUndefined();
  const csp = (manifest.content_security_policy as { extension_pages: string })
    .extension_pages;
  for (const directive of [
    "script-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ])
    expect(csp).toContain(directive);
  const der = Buffer.from(manifest.key as string, "base64");
  expect(der.toString("base64")).toBe(manifest.key);
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  expect(publicKey.type).toBe("public");
  expect(publicKey.asymmetricKeyType).toBe("rsa");
  expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(
    createHash("sha256")
      .update(der)
      .digest("hex")
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (value) =>
        String.fromCharCode(97 + parseInt(value, 16)),
      ),
  ).toBe("coenmeplfkocojebfacfbebinadfijoh");
  expect(manifest.background).toEqual({
    service_worker: "background.js",
    type: "module",
  });
});
