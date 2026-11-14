import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateCandidate, validateProvenance } from "../scripts/publication.mjs";

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
