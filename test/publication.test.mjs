import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCandidate, validateProvenance, validateReleaseManifest, waitForPublishedMetadata } from "../scripts/release-artifacts.mjs";
import { validateReleaseConfig } from "../scripts/validate-npm-release.mjs";

test("registry propagation can exceed the old minute and succeed at the final check", async () => {
  const source = { name: "gik-service-providers", version: "0.3.0" };
  const published = { ...source, dist: { integrity: "expected" } };
  let checks = 0;
  const waits = [];
  assert.equal(await waitForPublishedMetadata(source, { integrity: "expected" }, {
    readMetadata: async (name, version) => {
      assert.equal(name, source.name);
      assert.equal(version, source.version);
      return ++checks === 31 ? published : null;
    },
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  }), published);
  assert.equal(checks, 31);
  assert.equal(waits.length, 30);
  assert.equal(waits.reduce((sum, milliseconds) => sum + milliseconds, 0), 300_000);
});

test("registry propagation exhaustion reports unavailability, not an integrity failure", async () => {
  let checks = 0, waits = 0;
  await assert.rejects(waitForPublishedMetadata({ name: "gik-service-providers", version: "0.3.0" }, undefined, {
    readMetadata: async () => { checks++; return null; },
    sleep: async () => { waits++; },
  }), /Registry propagation timed out.*gik-service-providers@0\.3\.0.*HTTP 404.*31 checks/);
  assert.equal(checks, 31);
  assert.equal(waits, 30);
});

test("registry identity, integrity and request failures fail immediately without retry", async () => {
  const source = { name: "gik-service-providers", version: "0.3.0" };
  for (const [result, message] of [
    [{ ...source, name: "other-package" }, /identity mismatch/],
    [{ ...source, version: "0.2.0" }, /identity mismatch/],
    [{ ...source, dist: { integrity: "changed" } }, /integrity mismatch/],
    [new Error("Registry metadata HTTP 503"), /HTTP 503/],
  ]) {
    let checks = 0;
    await assert.rejects(waitForPublishedMetadata(source, { integrity: "expected" }, {
      readMetadata: async () => { checks++; if (result instanceof Error) throw result; return result; },
      sleep: async () => { assert.fail("Invalid metadata and request errors must not be retried"); },
    }), message);
    assert.equal(checks, 1);
  }
});

test("Samples notification follows stable verification with a Samples-only App token", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const notification = workflow.slice(workflow.indexOf("  notify-samples:"));
  assert.match(notification, /needs: \[source, verify-published\]/);
  assert.match(notification, /needs\.source\.outputs\.channel == 'latest'/);
  assert.match(notification, /repositories: gik-samples\s+permission-contents: write/);
  assert.match(notification, /gik-library-release-verified/);
  assert.match(notification, /SOURCE_RUN: \$\{\{ github.run_id \}\}/);
  assert.doesNotMatch(notification, /id-token: write|npm publish|git push/);
});

test("publication rejects changed source, archive and digest handoff", () => {
  const bytes = Buffer.from("validated archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = { name: "gik-service-providers", version: "0.3.0" };
  const commit = "a".repeat(40);
  const candidate = { ...source, commit, sha256: digest, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
  assert.doesNotThrow(() => validateCandidate(candidate, source, commit, bytes, digest));
  for (const [head, archive, handoff] of [
    ["b".repeat(40), bytes, digest], [commit, Buffer.from("tampered"), digest], [commit, bytes, undefined],
  ]) assert.throws(() => validateCandidate(candidate, source, head, archive, handoff), /handoff mismatch/);
});
test("provenance must bind to this repo, workflow and exact commit", () => {
  const repository = "nsreehari/gik-service-providers", commit = "a".repeat(40), predicateType = "https://slsa.dev/provenance/v1";
  const data = { attestations: [{ predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
    predicateType, predicate: { buildDefinition: {
      externalParameters: { workflow: { repository: `https://github.com/${repository}`, path: ".github/workflows/publish.yml" } },
      resolvedDependencies: [{ uri: `git+https://github.com/${repository}`, digest: { gitCommit: commit } }],
    } },
  })).toString("base64") } } }] };
  assert.doesNotThrow(() => validateProvenance(data, repository, commit));
  assert.throws(() => validateProvenance(data, repository, "b".repeat(40)), /does not match/);
  assert.throws(() => validateProvenance(data, "another/repository", commit), /does not match/);
});
test("release policy rejects private and local-source publication", () => {
  const source = { name: "gik-service-providers", version: "0.3.0", publishConfig: { access: "public" }, exports: { "./example": "./dist/example.js" } };
  const config = { stable: [source.name], experimental: [], internal: [] };
  assert.doesNotThrow(() => validateReleaseConfig(config, source));
  assert.throws(() => validateReleaseConfig(config, { ...source, private: true }), /Private/);
  assert.throws(() => validateReleaseConfig(config, { ...source, dependencies: { "gik-react": "file:../core" } }), /come from npm/);
});
test("manifest handoff binds the reviewed tree and lock, not just archive bytes", () => {
  const archive = Buffer.from("verified archive");
  const source = { name: "gik-service-providers", version: "0.3.0" };
  const inputs = { commit: "a".repeat(40), tree: "b".repeat(40), lock: "c".repeat(64) };
  const manifest = { format: "gik-release-artifacts/1", inputs, packages: [{
    ...source, file: `${source.name}-${source.version}.tgz`, publish: true,
    sha256: createHash("sha256").update(archive).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  }] };
  const bytes = Buffer.from(JSON.stringify(manifest)), digest = createHash("sha256").update(bytes).digest("hex");
  assert.doesNotThrow(() => validateReleaseManifest(manifest, source, inputs, archive, bytes, digest));
  for (const context of [{ ...inputs, tree: "d".repeat(40) }, { ...inputs, lock: "d".repeat(64) }]) {
    assert.throws(() => validateReleaseManifest(manifest, source, context, archive, bytes, digest), /handoff mismatch/);
  }
  assert.throws(() => validateReleaseManifest(manifest, source, inputs, archive, bytes, undefined), /handoff mismatch/);
});
