import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024, ...options,
});
const source = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(!source.main && !source.types);
assert.ok(Object.keys(source.exports).every((entry) => entry.startsWith("./") && !entry.includes("*")));
const directory = ".artifacts/package";
mkdirSync(directory, { recursive: true });
const packed = JSON.parse(run("npm", ["exec", "--yes", "--package=npm@11.19.0", "--", "npm",
  "pack", "--ignore-scripts", "--json", "--pack-destination", directory]))[0];
const archive = resolve(directory, "package.tgz");
renameSync(join(directory, packed.filename), archive);
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
const temporary = mkdtempSync(join(tmpdir(), `${source.name}-consumer-`));
try {
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["exec", "--yes", "--package=npm@11.19.0", "--", "npm", "install",
    "--ignore-scripts", "--no-audit", "--no-fund", archive, "typescript@^5.9.2", "@types/node@^24"], { cwd: temporary });
  const specifiers = Object.keys(source.exports).map((entry) => source.name + entry.slice(1));
  writeFileSync(join(temporary, "check.ts"), specifiers.map((specifier, index) =>
    `import * as entry${index} from ${JSON.stringify(specifier)};\nvoid entry${index};`).join("\n"));
  run(process.execPath, [join(temporary, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "check.ts"], { cwd: temporary });
  for (const specifier of specifiers) {
    run(process.execPath, ["--input-type=module", "-e", `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const specifier = ${JSON.stringify(specifier)};
registerHooks({ resolve(request, context, next) {
  if (request.startsWith(${JSON.stringify(source.name + "/")}) && request !== specifier) throw new Error("Eager sibling provider import");
  return next(request, context);
} });
await import(specifier);
await assert.rejects(import(${JSON.stringify(source.name)}), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`], { cwd: temporary });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const bytes = readFileSync(archive);
const candidate = {
  name: source.name, version: source.version, commit: run("git", ["rev-parse", "HEAD"]).trim(),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
};
writeFileSync(join(directory, "candidate.json"), JSON.stringify(candidate, null, 2) + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${candidate.sha256}\n`);
console.log(`Verified ${source.name}@${source.version}: independent public entries, packed types and runtime`);
