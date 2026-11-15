import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCandidate, validateProvenance, validateReleaseManifest } from "../scripts/release-artifacts.mjs";
import { validateReleaseConfig } from "../scripts/validate-npm-release.mjs";

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
