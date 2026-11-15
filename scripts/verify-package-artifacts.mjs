import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024, ...options,
});
export async function packRelease() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Registry operations require GitHub Actions");
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(!source.main && !source.types);
  assert.ok(Object.keys(source.exports).length > 0);
  assert.ok(Object.keys(source.exports).every((entry) => entry.startsWith("./") && !/[*\\]/.test(entry)
    && entry.slice(2).split("/").every((part) => part && part !== "." && part !== "..")));
  const directory = ".artifacts/npm-release";
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, "Release artifact directory must be empty");
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]))[0];
  assert.equal(packed.filename, `${source.name}-${source.version}.tgz`);
  const archive = resolve(directory, packed.filename);
  const entries = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
  assert.equal(new Set(entries).size, entries.length);
  assert.ok(entries.every((entry) => entry.startsWith("package/") && !entry.includes("\\")
    && !entry.split("/").includes("..") && !/[\x00-\x1f]/.test(entry)));
  assert.ok(!run("tar", ["-tvzf", archive]).split(/\r?\n/).some((line) => /^[lh]/.test(line)));
  const installedManifest = JSON.parse(run("tar", ["-xOf", archive, "package/package.json"]));
  for (const key of ["name", "version", "exports", "dependencies", "peerDependencies"]) {
    assert.deepEqual(installedManifest[key], source[key]);
  }
  const targets = (value) => typeof value === "string" ? [value] : Object.values(value).flatMap(targets);
  for (const target of targets(source.exports)) {
    assert.ok(target.startsWith("./dist/") && entries.includes(`package/${target.slice(2)}`), `Missing export ${target}`);
  }
  await exerciseConsumer(archive, source);
  const bytes = readFileSync(archive);
  const manifest = {
    format: "gik-release-artifacts/1",
    inputs: {
      commit: run("git", ["rev-parse", "HEAD"]).trim(), tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
      lock: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
      node: process.version, npm: run("npm", ["--version"]).trim(), platform: process.platform, arch: process.arch,
    },
    packages: [{
      name: source.name, version: source.version, file: packed.filename, dependencies: {}, publish: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    }],
  };
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(directory, "release-artifacts.json"), manifestBytes);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `manifest_sha256=${createHash("sha256").update(manifestBytes).digest("hex")}\n`);
  console.log(`Verified ${source.name}@${source.version}: independent public entries, packed types and runtime`);
}

export async function exerciseConsumer(packageSpec, source, signatureAudit = false) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Registry operations require GitHub Actions");
  const targets = (value) => typeof value === "string" ? [value] : Object.values(value).flatMap(targets);
  const temporary = mkdtempSync(join(tmpdir(), `${source.name}-consumer-`));
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", ["install",
      "--ignore-scripts", "--no-audit", "--no-fund", packageSpec, "typescript@^5.9.2", "@types/node@^24"], { cwd: temporary });
    const installed = JSON.parse(readFileSync(join(temporary, "node_modules", source.name, "package.json"), "utf8"));
    for (const key of ["name", "version", "exports", "dependencies", "peerDependencies"]) assert.deepEqual(installed[key], source[key]);
    if (signatureAudit) run("npm", ["audit", "signatures"], { cwd: temporary });
    const specifiers = Object.keys(source.exports).map((entry) => source.name + entry.slice(1));
    writeFileSync(join(temporary, "check.ts"), specifiers.map((specifier, index) =>
      `import * as entry${index} from ${JSON.stringify(specifier)};\nvoid entry${index};`).join("\n"));
    run(process.execPath, [join(temporary, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "check.ts"], { cwd: temporary });
    for (const specifier of specifiers) {
      const siblingTargets = Object.entries(source.exports)
        .filter(([entry]) => source.name + entry.slice(1) !== specifier)
        .flatMap(([, value]) => targets(value)).filter((target) => /\.[cm]?js$/.test(target))
        .map((target) => `/node_modules/${source.name}/${target.slice(2)}`);
      run(process.execPath, ["--input-type=module", "-e", `
  import assert from "node:assert/strict";
  import { registerHooks } from "node:module";
  const specifier = ${JSON.stringify(specifier)};
  registerHooks({ resolve(request, context, next) {
    if (request.startsWith(${JSON.stringify(source.name + "/")}) && request !== specifier) throw new Error("Eager sibling provider import");
    if (["gik-service-providers/foundry", "gik-service-providers/gmail"].includes(specifier)
      && (request === "croner" || request.startsWith("croner/"))) throw new Error("Unrelated scheduler dependency");
    const result = next(request, context);
    if (${JSON.stringify(siblingTargets)}.some((target) => result.url.endsWith(target))) throw new Error("Eager relative sibling provider import");
    return result;
  } });
  await import(specifier);
  await assert.rejects(import(${JSON.stringify(source.name)}), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  `], { cwd: temporary });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
