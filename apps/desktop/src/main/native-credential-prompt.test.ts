import { execFileSync } from "node:child_process";
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  credentialPromptCode,
  credentialPromptScript,
} from "./credential-prompt-script";
import { NativeCredentialPrompt } from "./native-credential-prompt";
import type { AssistantCredentialChallenge } from "@rewind/contracts";
import { SecureStorage } from "@rewind/storage";
import { AssistantCredentials } from "./assistant-credentials";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

function challenge() {
  const pair = generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicExponent: 65537,
    }),
    key = pair.publicKey.export({ format: "jwk" });
  const reply: AssistantCredentialChallenge = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    modulus: Buffer.from(key.n!, "base64url").toString("base64"),
    exponent: "AQAB",
  };
  return { pair, reply };
}
it.runIf(process.platform === "win32")(
  "seals a synthetic native buffer directly to the utility recipient without emitting the plaintext secret",
  async () => {
    const { pair, reply } = challenge(),
      secret = "Synthetic_Native_Gemini_Key_6821";
    const script = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
${credentialPromptCode}
'@ -Language CSharp
$request=[Console]::ReadLine() | ConvertFrom-Json
$buffer=[Runtime.InteropServices.Marshal]::StringToHGlobalUni([string]$request.testKey)
try {
  $method=[RewindCredentialPrompt].GetMethod('Seal',[Reflection.BindingFlags]::Static -bor [Reflection.BindingFlags]::NonPublic)
  $sealed=$method.Invoke($null,@($buffer,([string]$request.testKey).Length,[string]$request.id,[string]$request.modulus,[string]$request.exponent))
  [Console]::WriteLine((@{id=$request.id;sealed=$sealed} | ConvertTo-Json -Compress))
} finally {
  for($offset=0;$offset -lt (([string]$request.testKey).Length+1)*2;$offset++){[Runtime.InteropServices.Marshal]::WriteByte($buffer,$offset,0)}
  [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
}
`;
    const run = (
      testKey: string,
      destination: AssistantCredentialChallenge = reply,
    ) =>
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          input: JSON.stringify({ ...destination, testKey }) + "\n",
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 4096,
          timeout: 10000,
        },
      );
    const output = run(secret),
      packet = JSON.parse(output) as { id: string; sealed: string };
    expect(output).not.toContain(secret);
    expect(packet.id).toBe(reply.id);
    expect(packet.sealed).toHaveLength(684);
    const plain = privateDecrypt(
      {
        key: pair.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(packet.sealed, "base64"),
    );
    try {
      expect(JSON.parse(plain.toString("utf8"))).toEqual({
        id: reply.id,
        apiKey: secret,
      });
    } finally {
      plain.fill(0);
    }
    expect(JSON.parse(run("Invalid synthetic key with spaces"))).toMatchObject({
      sealed: null,
    });
    const root = newSecureFixture(),
      key = randomBytes(32),
      storage = new SecureStorage(path.join(root, "history.sqlite"), key);
    const receiver = new AssistantCredentials({
      store: {
        read: () => storage.assistantCredential.read(),
        write: (...args) => storage.assistantCredential.write(...args),
      },
      quiesce: async () => ({ ok: true, value: undefined }),
    });
    try {
      expect((await storage.open()).ok).toBe(true);
      const prepared = await receiver.prepare(true);
      if (!prepared.ok)
        throw new Error("SYNTHETIC_NATIVE_RECIPIENT_UNAVAILABLE");
      const nativePacket = JSON.parse(run(secret, prepared.value)) as {
        id: string;
        sealed: string;
      };
      expect(await receiver.accept(nativePacket, true)).toEqual({
        ok: true,
        value: true,
      });
      expect(await storage.assistantCredential.read()).toMatchObject({
        ok: true,
        value: { apiKey: secret, revision: 1 },
      });
      expect(await storage.getSettings()).toMatchObject({
        ok: true,
        value: { cloudAiEnabled: false },
      });
      for (const name of readdirSync(root))
        expect(
          readFileSync(path.join(root, name)).includes(Buffer.from(secret)),
        ).toBe(false);
    } finally {
      expect((await receiver.close()).ok).toBe(true);
      expect((await storage.close()).ok).toBe(true);
      key.fill(0);
      removeSecureFixture(root);
    }
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "compiles the actual native prompt, refuses an invalid owner and observes helper exit",
  async () => {
    const { reply } = challenge(),
      prompt = new NativeCredentialPrompt(() => ({
        parent: "1",
        processId: process.pid,
      }));
    expect(
      Buffer.from(credentialPromptScript, "utf16le").toString("base64").length,
    ).toBeLessThan(30000);
    expect((await prompt.prompt(reply)).ok).toBe(false);
    expect((await prompt.close()).ok).toBe(true);
    expect((await prompt.prompt(reply)).ok).toBe(false);
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "rejects expired challenges and cancels an owned helper during shutdown",
  async () => {
    const { reply } = challenge(),
      prompt = new NativeCredentialPrompt(() => ({
        parent: "1",
        processId: process.pid,
      }));
    expect(
      (await prompt.prompt({ ...reply, expiresAt: "2020-01-01T00:00:00.000Z" }))
        .ok,
    ).toBe(false);
    const pending = prompt.prompt(reply);
    expect((await prompt.close()).ok).toBe(true);
    expect((await pending).ok).toBe(false);
  },
  15000,
);
