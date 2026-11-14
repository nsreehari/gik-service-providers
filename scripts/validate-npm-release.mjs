import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateReleaseConfig(config, source) {
  assert.deepEqual(config.stable, [source.name], "The root package must be the sole stable publication");
  assert.deepEqual(config.experimental, []);
  assert.deepEqual(config.internal, []);
  assert.match(source.name, /^gik-[a-z0-9-]+$/);
  assert.match(source.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(!source.private, "Private packages cannot be published");
  assert.equal(source.publishConfig?.access, "public");
  assert.ok(source.exports && Object.keys(source.exports).length, "Public exports are required");
  for (const constraint of Object.values({
    ...source.dependencies, ...source.optionalDependencies, ...source.peerDependencies,
  })) assert.ok(!/^(?:file|link|workspace):/.test(constraint), "Publication dependencies must come from npm");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateReleaseConfig(JSON.parse(readFileSync("config/npm-release.json", "utf8")),
    JSON.parse(readFileSync("package.json", "utf8")));
  assert.ok(existsSync("README.md") && existsSync("LICENSE"), "Publication documentation and license are required");
  console.log("Validated standalone npm release policy");
}
