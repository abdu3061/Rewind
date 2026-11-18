import { execFileSync, spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import guardSource from "../native/document-resource-guard.cs?raw";
import { copyDocumentRuntime } from "../../document-runtime";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";
import {
  docxEntries,
  pdfFixture,
  zipFixture,
} from "../../../../packages/documents/src/fixtures.test-support";

const packagedArtifacts = process.env.REWIND_TEST_DOCUMENT_PACKAGED === "1";
it.skipIf(process.platform !== "win32")(
  `extracts actual DOCX/PDF bytes in guarded Electron utilities (${packagedArtifacts ? "Forge ASAR assets" : "fixture assets"}) and terminates a hung parser`,
  async () => {
    const root = newSecureFixture(),
      require = createRequire(import.meta.url);
    const appRoot = path.join(root, "synthetic-app"),
      resources = path.resolve("apps/desktop/out/Rewind-win32-x64/resources"),
      guard = packagedArtifacts
        ? path.join(resources, "documents/RewindDocumentGuard.exe")
        : path.join(root, "SyntheticDocumentGuard.exe"),
      workerEntry = packagedArtifacts
        ? path.join(resources, "app.asar/.vite/build/document-entry.cjs")
        : path.join(appRoot, "worker/document-entry.cjs");
    let child: ReturnType<typeof spawn> | undefined;
    let observedClose = false;
    try {
      await mkdir(appRoot, { recursive: true });
      if (!packagedArtifacts) {
        await copyDocumentRuntime(appRoot, "win32", "x64");
        const guardFile = path.join(root, "ResourceGuard.cs");
        writeFileSync(guardFile, guardSource);
        execFileSync(
          path.join(
            process.env.WINDIR ?? "C:\\Windows",
            "Microsoft.NET",
            "Framework64",
            "v4.0.30319",
            "csc.exe",
          ),
          [
            "/nologo",
            "/target:exe",
            "/platform:x64",
            `/out:${guard}`,
            guardFile,
          ],
          { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
        );
        await build({
          configFile: false,
          logLevel: "silent",
          build: {
            outDir: path.join(appRoot, "worker"),
            emptyOutDir: false,
            lib: {
              entry: path.resolve("apps/desktop/src/main/document-entry.ts"),
              formats: ["cjs"],
              fileName: () => "document-entry.cjs",
            },
            rollupOptions: {
              external: [
                ...builtinModules,
                "electron",
                /^node:/,
                /^pdfjs-dist\//,
              ],
            },
          },
        });
      }
      const hangEntry = path.join(appRoot, "hang.cjs");
      await writeFile(
        hangEntry,
        "process.parentPort.on('message',()=>{process.stdout.write('SYNTHETIC_HANG_STARTED\\n');while(true){}});\n",
      );
      const bootstrap = path.join(root, "bootstrap.ts"),
        mainDirectory = path.resolve("apps/desktop/src/main");
      const source = `
import {app,utilityProcess} from 'electron';
import {createDocumentBackend} from ${JSON.stringify(path.join(mainDirectory, "document-backend.ts"))};
import {DocumentProcess} from ${JSON.stringify(path.join(mainDirectory, "document-process.ts"))};
import {admitDocumentProcess} from ${JSON.stringify(path.join(mainDirectory, "document-resource-guard.ts"))};
import {documentEnvironment} from ${JSON.stringify(path.join(mainDirectory, "document-environment.ts"))};
app.setPath('userData',${JSON.stringify(path.join(root, "marked-synthetic-profile"))});
app.whenReady().then(async()=>{
 const service=createDocumentBackend(${JSON.stringify(workerEntry)},${JSON.stringify(guard)});
 const docx=Buffer.from(${JSON.stringify(zipFixture(docxEntries("<w:p><w:r><w:t>Synthetic guarded Word text</w:t></w:r></w:p>")).toString("base64"))},'base64');
 const pdf=Buffer.from(${JSON.stringify(pdfFixture(["Synthetic guarded PDF text"]).toString("base64"))},'base64');
 const original=Buffer.from(pdf);
 const word=await service.extract('docx',docx),portable=await service.extract('pdf',pdf);
 const closed=await service.close();
 let hangStarted=false,hangAdmitted=false,hangOutput='';
 const hung=new DocumentProcess({deadlineMs:4000,spawn:()=>{
   const child=utilityProcess.fork(${JSON.stringify(hangEntry)},[],{stdio:'pipe',env:documentEnvironment(),execArgv:['--max-old-space-size=192','--disallow-code-generation-from-strings']});
   child.stdout?.on('data',data=>{hangOutput=(hangOutput+data.toString()).slice(-64);hangStarted ||= hangOutput.includes('SYNTHETIC_HANG_STARTED');});child.stderr?.resume();return child;
 },admit:async(pid,signal,lost)=>{const lease=await admitDocumentProcess(${JSON.stringify(guard)},pid,signal,lost);hangAdmitted=lease!==null;return lease;}});
 const timeout=await hung.extract('pdf',Uint8Array.of(1)),hungClosed=await hung.close();
 console.log('DOCUMENT_SYNTHETIC_RESULT '+JSON.stringify({word:word.state==='available'&&word.text.includes('Synthetic guarded Word text'),pdf:portable.state==='available'&&portable.text.includes('Synthetic guarded PDF text'),unchanged:pdf.equals(original),closed,timeout:timeout.state==='unavailable'?timeout.reason:'unexpected',hungClosed,hangStarted,hangAdmitted,busy:hung.busy,wordState:word.state,pdfState:portable.state}));
 app.exit(0);
}).catch(()=>app.exit(1));
`;
      await writeFile(bootstrap, source);
      await writeFile(
        path.join(root, "synthetic-document-fixture.json"),
        JSON.stringify({ synthetic: true, format: 1 }),
      );
      await build({
        configFile: false,
        logLevel: "silent",
        build: {
          outDir: appRoot,
          emptyOutDir: false,
          lib: {
            entry: bootstrap,
            formats: ["cjs"],
            fileName: () => "bootstrap.cjs",
          },
          rollupOptions: { external: ["electron", /^node:/] },
        },
      });
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          child = spawn(
            require("electron") as string,
            [path.join(appRoot, "bootstrap.cjs")],
            {
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
            },
          );
          let output = "";
          const timer = setTimeout(() => {
            child?.kill();
            reject(new Error("SYNTHETIC_DOCUMENT_APP_TIMEOUT"));
          }, 20000);
          child.stdout?.on("data", (bytes: Buffer) => {
            output += bytes.toString();
            if (output.length > 4096) {
              child?.kill();
              reject(new Error("SYNTHETIC_DOCUMENT_OUTPUT_LIMIT"));
            }
          });
          child.stderr?.resume();
          child.on("error", reject);
          child.once("close", (code) => {
            observedClose = true;
            clearTimeout(timer);
            resolve({ code, output });
          });
        },
      );
      expect(result.code).toBe(0);
      const line = result.output
        .split(/\r?\n/)
        .find((value) => value.startsWith("DOCUMENT_SYNTHETIC_RESULT "));
      expect(line).toBeDefined();
      expect(
        JSON.parse(line!.slice("DOCUMENT_SYNTHETIC_RESULT ".length)),
      ).toEqual({
        word: true,
        pdf: true,
        unchanged: true,
        closed: true,
        timeout: "timeout",
        hungClosed: true,
        hangStarted: true,
        hangAdmitted: true,
        busy: false,
        wordState: "available",
        pdfState: "available",
      });
    } finally {
      if (child && !observedClose)
        await new Promise<void>((resolve) => {
          child!.once("close", () => {
            observedClose = true;
            resolve();
          });
          child!.kill();
        });
      removeSecureFixture(root);
    }
  },
  30000,
);
