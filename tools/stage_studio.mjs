import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFirmware } from "../web/fw-protocol.mjs";
import { releaseAssetName, releaseAssetPath, validateRelease } from "../web/studio-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [assetDirectory, tag] = process.argv.slice(2);
if (Boolean(assetDirectory) !== Boolean(tag)) throw Error("Usage: node tools/stage_studio.mjs [release-asset-directory release-tag]");

const files = new Map();
for (const file of await readdir(resolve(root, "web"), { withFileTypes: true })) {
  if (file.isFile() && (/\.(?:html|mjs|css)$/.test(file.name) || file.name === "default-bindings.json") && !["demo.mjs", "fw-demo.mjs"].includes(file.name)) {
    files.set(file.name, resolve(root, "web", file.name));
  }
}

let release;
if (assetDirectory) {
  release = { schema: "split-studio-release-v1", hardware: 86, tag, firmware: {} };
  for (const role of ["left", "right"]) {
    const path = resolve(assetDirectory, releaseAssetName(role));
    const bytes = await readFile(path);
    if (bytes.length > 450000) throw Error(`Oversized release package: ${role}`);
    const { manifest } = await validateFirmware(bytes.toString("utf8"));
    if (manifest.role !== role) throw Error(`Incorrect role in release package: ${role}`);
    release.firmware[role] = {
      version: manifest.version,
      versionNumber: manifest.version_number,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    files.set(releaseAssetPath(role), bytes);
  }
  validateRelease(release);
}

const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
const output = await mkdtemp(`${dist}/studio-`);
if (release) {
  await mkdir(resolve(output, "firmware"));
  await writeFile(resolve(output, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
}
for (const [name, file] of files) {
  if (Buffer.isBuffer(file)) await writeFile(resolve(output, name), file);
  else await copyFile(file, resolve(output, name));
}
await writeFile(resolve(output, "_headers"), "/*\n  Cache-Control: no-cache\n  Permissions-Policy: hid=(self)\n  X-Content-Type-Options: nosniff\n");
await writeFile(resolve(output, "404.html"), '<!doctype html><meta charset="utf-8"><title>Split Studio</title><p>페이지를 찾을 수 없습니다. <a href="/">Studio로 돌아가기</a></p>\n');
console.log(output);
