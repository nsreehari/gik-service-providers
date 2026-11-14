import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export function validateCandidate(candidate, source, commit, bytes, digest) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "") || !/^[a-f0-9]{64}$/.test(digest ?? "")
    || candidate.commit !== commit || candidate.name !== source.name || candidate.version !== source.version
    || candidate.sha256 !== digest || sha256(bytes) !== digest || candidate.integrity !== integrity(bytes)) {
    throw new Error("Candidate source, version, integrity or validation handoff mismatch");
  }
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (!["publish", "verify"].includes(mode)) throw new Error("Expected publish or verify");
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  const candidate = JSON.parse(readFileSync(".artifacts/package/candidate.json", "utf8"));
  const bytes = readFileSync(".artifacts/package/package.tgz");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  validateCandidate(candidate, source, commit, bytes, process.env.PACKAGE_SHA);
  if (commit !== process.env.GITHUB_SHA || source.name !== process.env.GITHUB_REPOSITORY?.split("/")[1]) {
    throw new Error("Publication repository/event source mismatch");
  }
  if (mode === "publish") {
    run("git", ["fetch", "origin", "main:refs/remotes/origin/main"]);
    if (execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim() !== commit) throw new Error("Main advanced after validation");
    const existing = await metadata(source.name, source.version);
    if (existing && existing.dist?.integrity !== candidate.integrity) throw new Error("Published version differs; advance the reviewed package version");
    if (!existing) run("npm", ["exec", "--yes", "--package=npm@11.19.0", "--", "npm", "publish",
      ".artifacts/package/package.tgz", "--ignore-scripts", "--access", "public", "--provenance",
      "--tag", source.version.includes("-") ? "next" : "latest"]);
  } else {
    let published;
    for (let attempt = 0; attempt < 6; attempt++) {
      published = await metadata(source.name, source.version);
      if (published) break;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    if (!published || published.name !== source.name || published.version !== source.version
      || published.dist?.integrity !== candidate.integrity) throw new Error("Published candidate integrity mismatch");
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
    if (sha256(Buffer.from(await (await fetchArtifact(tarball)).arrayBuffer())) !== candidate.sha256) throw new Error("Registry archive differs from validated bytes");
    validateProvenance(await (await fetchArtifact(attestation)).json(), process.env.GITHUB_REPOSITORY, commit);
    const temporary = mkdtempSync(join(tmpdir(), "gik-registry-consumer-"));
    try {
      writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
      run("npm", ["exec", "--yes", "--package=npm@11.19.0", "--", "npm", "install", "--ignore-scripts",
        "--no-audit", "--no-fund", `${source.name}@${source.version}`], { cwd: temporary });
      run("npm", ["exec", "--yes", "--package=npm@11.19.0", "--", "npm", "audit", "signatures"], { cwd: temporary });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
