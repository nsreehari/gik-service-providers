import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { exerciseConsumer, packRelease } from "./verify-package-artifacts.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export function validateCandidate(candidate, source, commit, bytes, digest) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "") || !/^[a-f0-9]{64}$/.test(digest ?? "")
    || candidate.commit !== commit || candidate.name !== source.name || candidate.version !== source.version
    || candidate.sha256 !== digest || sha256(bytes) !== digest || candidate.integrity !== integrity(bytes)) {
    throw new Error("Candidate source, version, integrity or validation handoff mismatch");
  }
}
export function validateReleaseManifest(manifest, source, inputs, archive, manifestBytes, expectedDigest) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? "") || sha256(manifestBytes) !== expectedDigest
    || manifest.format !== "gik-release-artifacts/1" || manifest.packages?.length !== 1
    || Object.entries(inputs).some(([key, value]) => manifest.inputs?.[key] !== value)) {
    throw new Error("Release manifest, source, lock, toolchain or digest handoff mismatch");
  }
  const entry = manifest.packages[0];
  if (entry.file !== `${source.name}-${source.version}.tgz` || entry.publish !== true) throw new Error("Unexpected release package");
  validateCandidate({ ...entry, commit: manifest.inputs.commit }, source, inputs.commit, archive, entry.sha256);
}
export function validateProvenance(data, repository, commit) {
  const uri = `git+https://github.com/${repository}`;
  const commits = new Set();
  for (const entry of data.attestations ?? []) {
    if (!["https://slsa.dev/provenance/v1", "https://slsa.dev/provenance/v0.2"].includes(entry.predicateType)) continue;
    const statement = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    if (statement.predicateType !== entry.predicateType) continue;
    const predicate = statement.predicate;
    if (entry.predicateType.endsWith("/v1")) {
      const definition = predicate?.buildDefinition;
      const workflow = definition?.externalParameters?.workflow;
      if (workflow?.repository !== `https://github.com/${repository}` || workflow.path !== ".github/workflows/publish.yml") continue;
      for (const dependency of definition.resolvedDependencies ?? []) {
        if ((dependency.uri === uri || dependency.uri?.startsWith(`${uri}@`))
          && /^[a-f0-9]{40}$/.test(dependency.digest?.gitCommit ?? "")) commits.add(dependency.digest.gitCommit);
      }
    } else {
      const config = predicate?.invocation?.configSource;
      if ((config?.uri === uri || config?.uri?.startsWith(`${uri}@`))
        && config.entryPoint === ".github/workflows/publish.yml" && /^[a-f0-9]{40}$/.test(config.digest?.sha1 ?? "")) {
        commits.add(config.digest.sha1);
      }
    }
  }
  if (commits.size !== 1 || !commits.has(commit)) throw new Error("Registry provenance does not match repository, workflow and source");
}
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
async function metadata(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name}/${version}`,
    { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry metadata HTTP ${response.status}`);
  return response.json();
}
function releaseSource() {
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (commit !== process.env.GITHUB_SHA || source.name !== process.env.GITHUB_REPOSITORY?.split("/")[1]) {
    throw new Error("Publication repository/event source mismatch");
  }
  return { source, commit };
}
function verifyRelease(source, commit, expectedDigest) {
  const directory = ".artifacts/npm-release";
  const manifestBytes = readFileSync(`${directory}/release-artifacts.json`);
  const manifest = JSON.parse(manifestBytes);
  const file = `${source.name}-${source.version}.tgz`;
  const bytes = readFileSync(`${directory}/${file}`);
  validateReleaseManifest(manifest, source, {
    commit, tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    lock: sha256(readFileSync("package-lock.json")), node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), platform: process.platform, arch: process.arch,
  }, bytes, manifestBytes, expectedDigest);
  if (readdirSync(directory).sort().join("\n") !== [file, "release-artifacts.json"].sort().join("\n")) throw new Error("Unexpected release artifact files");
  return manifest.packages[0];
}
export async function verifyPublished(expectedDigest) {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Registry operations require GitHub Actions");
  const { source, commit } = releaseSource();
  const requiresCandidate = process.env.GITHUB_EVENT_NAME === "release" || expectedDigest !== undefined;
  const candidate = requiresCandidate ? verifyRelease(source, commit, expectedDigest) : undefined;
  let published;
  for (let attempt = 0; attempt < 6; attempt++) {
    published = await metadata(source.name, source.version);
    if (published) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!published || published.name !== source.name || published.version !== source.version
    || (candidate && published.dist?.integrity !== candidate.integrity)) throw new Error("Published candidate integrity mismatch");
  const tarball = new URL(published.dist.tarball);
  const attestation = new URL(published.dist.attestations.url);
  for (const url of [tarball, attestation]) {
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password) throw new Error("Untrusted registry URL");
  }
  if (!attestation.pathname.startsWith("/-/npm/v1/attestations/")) throw new Error("Invalid attestation URL");
  const fetchArtifact = async (url) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Registry artifact HTTP ${response.status}`);
    return response;
  };
  const archive = Buffer.from(await (await fetchArtifact(tarball)).arrayBuffer());
  if (integrity(archive) !== published.dist.integrity || (candidate && sha256(archive) !== candidate.sha256)) throw new Error("Registry archive differs from validated bytes");
  if (candidate) validateProvenance(await (await fetchArtifact(attestation)).json(), process.env.GITHUB_REPOSITORY, commit);
  await exerciseConsumer(`${source.name}@${source.version}`, source, true);
  console.log(candidate ? "Verified exact newly published artifact and source provenance" : "Verified existing registry version as a clean typed/runtime consumer; not a publication attestation");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Registry operations require GitHub Actions");
  const mode = process.argv[2];
  if (mode === "pack") await packRelease();
  else if (mode === "publish") {
    const { source, commit } = releaseSource();
    const candidate = verifyRelease(source, commit, process.env.RELEASE_MANIFEST_SHA256);
    run("git", ["fetch", "origin", "main:refs/remotes/origin/main"]);
    if (execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim() !== commit) throw new Error("Main advanced after validation");
    const channel = source.version.includes("-") ? "next" : "latest";
    if (process.env.RELEASE_CHANNEL !== channel) throw new Error("Release channel/version mismatch");
    const existing = await metadata(source.name, source.version);
    if (existing && existing.dist?.integrity !== candidate.integrity) throw new Error("Published version differs; advance the reviewed package version");
    if (!existing) run("npm", ["publish", `.artifacts/npm-release/${candidate.file}`, "--ignore-scripts",
      "--access", "public", "--provenance", "--tag", channel]);
  } else {
    throw new Error("Expected pack or publish");
  }
}
