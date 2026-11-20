import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  ServiceKindRegistry, UnsatisfiedServiceDependencyError,
  type ServiceDependencyStatus, type ServiceKindContext, type ServiceRequest,
} from "gik-controlface/services";
import type { Json, NativeServiceDeclaration } from "gik-kernel";
import { createCredentialAccess, createMemoryCredentialStore, type CredentialStore } from "../src/byok";
import { createGeminiByokServiceKind } from "../src/gemini-byok";
import { createOpenAiByokServiceKind } from "../src/openai-byok";

const identity = { blueprintId: "synthetic-byok", blueprintRevision: "1", serviceId: "model" };
const key = "synthetic-fixture-key";
const providers = [
  {
    kind: "gemini-byok", contract: "gemini.generate/v1", model: "gemini-fixture",
    origin: "https://generativelanguage.googleapis.com", header: "x-goog-api-key",
    factory: createGeminiByokServiceKind,
    input: { contents: [{ role: "user", parts: [{ text: "Synthetic request" }] }] } as Json,
    metadata: { name: "models/gemini-fixture" },
    reply: (text = "Synthetic OK") => ({ candidates: [{
      content: { role: "model", parts: [{ text }] }, finishReason: "STOP",
    }] }),
  },
  {
    kind: "openai-byok", contract: "openai.generate/v1", model: "gpt-4.1-fixture",
    origin: "https://api.openai.com", header: "authorization",
    factory: createOpenAiByokServiceKind,
    input: { input: [{ role: "user", content: "Synthetic request" }] } as Json,
    metadata: { id: "gpt-4.1-fixture" },
    reply: (text = "Synthetic OK") => ({ type: "response.completed", response: {
      status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text }] }],
    } }),
  },
];
type Provider = typeof providers[number];
function declaration(spec: Provider): NativeServiceDeclaration {
  return {
    kind: spec.kind, version: "1", config: { model: spec.model, credentialRef: "ai/synthetic" },
    operations: { generate: { operation: "generate", contract: spec.contract,
      settlement: { transform: { kind: "jsonata", expr: "{}" } } } },
  };
}
function request(spec: Provider): ServiceRequest {
  return { id: "synthetic", service: identity.serviceId, operation: "generate", input: spec.input,
    providerId: spec.kind, capabilityId: spec.contract, createdAt: "now" };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sse = (body: unknown) => new Response(`data: ${JSON.stringify(body)}\r\n\r\n`, {
  headers: { "content-type": "text/event-stream" },
});
function fixture(spec: Provider, response: () => Response | Promise<Response> = () => sse(spec.reply())) {
  let status: ServiceDependencyStatus = { state: "ready" };
  const lifetime = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const resolveCredential = vi.fn<NonNullable<ServiceKindContext["resolveCredential"]>>(async () => ({
    key, signal: lifetime.signal, check() { lifetime.signal.throwIfAborted(); },
  }));
  const authorizeEndpoint = vi.fn<NonNullable<ServiceKindContext["authorizeEndpoint"]>>(async () => true);
  const context: ServiceKindContext = {
    identity, hostCapabilities: [], inspectDependency: () => status, resolveCredential, authorizeEndpoint,
  };
  const factory = spec.factory({ fetch: fetcher });
  return {
    factory, adapter: factory.create(declaration(spec), context), context, fetcher, resolveCredential,
    authorizeEndpoint, lifetime, setStatus(value: ServiceDependencyStatus) { status = value; },
  };
}

for (const spec of providers) {
  test(`${spec.kind}: native validation, dependency setup and discovery do not acquire a key`, async () => {
    const f = fixture(spec);
    const registry = new ServiceKindRegistry(f.context);
    registry.register(f.factory);
    assert.equal((await registry.validate(declaration(spec))).ok, true);
    const setup = await registry.describeSetup(identity, declaration(spec));
    assert.equal(setup.ready, true);
    assert.deepEqual(setup.dependencies[0].requirement, {
      id: "api-key", title: spec.kind === "gemini-byok" ? "Gemini API Key" : "OpenAI API Key",
      kind: "credential", ref: "ai/synthetic", scheme: `${spec.kind}-api-key`,
    });
    const catalog = await f.adapter.discover();
    assert.equal(catalog.capabilities[0].id, spec.contract);
    assert.equal(f.resolveCredential.mock.calls.length, 0);
    assert.equal(f.fetcher.mock.calls.length, 0);
    const configs: Json[] = [{ model: "bad/model", credentialRef: "x" }, { model: `${spec.model}\n`, credentialRef: "x" },
      { model: spec.model, credentialRef: "" }, { model: spec.model, credentialRef: "x", key: "not-allowed" }];
    for (const config of configs) {
      assert.equal((await registry.validate({ ...declaration(spec), config })).ok, false);
    }
    for (const operation of [
      { ...declaration(spec).operations.generate, mode: "queued" as const },
      { ...declaration(spec).operations.generate, onViolation: { action: "retry" as const, maxAttempts: 2 } },
      { ...declaration(spec).operations.generate, onViolation: { action: "correction-prompt" as const, maxAttempts: 2 } },
      { ...declaration(spec).operations.generate, sense: { kind: "feed" as const, signals: {} } },
    ]) assert.equal((await registry.validate({ ...declaration(spec), operations: { generate: operation } })).ok, false);
    assert.deepEqual(f.factory.manifest.operationConstraints?.generate, { queueable: false, retryable: false });
    assert.equal(f.factory.manifest.supports.testSmoke, true);
  });

  test(`${spec.kind}: admitted fixed-origin requests carry keys only in headers and never retry`, async () => {
    const f = fixture(spec);
    await f.adapter.execute(request(spec), {});
    assert.equal(f.fetcher.mock.calls.length, 1);
    assert.equal(f.resolveCredential.mock.calls[0][0], "ai/synthetic");
    const [url, init] = f.fetcher.mock.calls[0];
    assert.equal(new URL(String(url)).origin, spec.origin);
    assert.ok(!String(url).includes(key));
    assert.equal(new Headers(init?.headers).get(spec.header), spec.header === "authorization" ? `Bearer ${key}` : key);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    assert.ok(!String(init?.body).includes(key));
    if (spec.kind === "openai-byok") assert.equal(JSON.parse(String(init?.body)).store, false);
    for (const status of [401, 403, 429, 500]) {
      const failed = fixture(spec, () => json({ error: { message: `provider echoed ${key}` } }, status));
      await assert.rejects(async () => failed.adapter.execute(request(spec), {}), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes(`HTTP ${status}`));
        assert.ok(!error.message.includes(key));
        assert.ok(!error.message.includes("provider echoed"));
        return true;
      });
      assert.equal(failed.fetcher.mock.calls.length, 1);
    }
  });

  test(`${spec.kind}: missing dependency and denied endpoint fail before key resolution`, async () => {
    const f = fixture(spec);
    f.setStatus({ state: "missing", message: "Synthetic key missing" });
    await assert.rejects(async () => f.adapter.execute(request(spec), {}), UnsatisfiedServiceDependencyError);
    assert.equal(f.resolveCredential.mock.calls.length, 0);
    f.setStatus({ state: "ready" });
    f.authorizeEndpoint.mockResolvedValue(false);
    await assert.rejects(async () => f.adapter.execute(request(spec), {}), /denied/);
    assert.equal(f.resolveCredential.mock.calls.length, 0);
    assert.equal(f.fetcher.mock.calls.length, 0);
  });

  test(`${spec.kind}: cancellation, credential replacement and late revocation suppress results`, async () => {
    const cancelled = fixture(spec);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(async () => cancelled.adapter.execute(request(spec), { signal: controller.signal }), { name: "AbortError" });
    assert.equal(cancelled.fetcher.mock.calls.length, 0);
    const revoked = fixture(spec, () => {
      revoked.setStatus({ state: "unavailable", message: "Synthetic revocation" });
      return sse(spec.reply());
    });
    await assert.rejects(async () => revoked.adapter.execute(request(spec), {}), UnsatisfiedServiceDependencyError);
    const replaced = fixture(spec, () => {
      replaced.lifetime.abort();
      return sse(spec.reply());
    });
    await assert.rejects(async () => replaced.adapter.execute(request(spec), {}), { name: "AbortError" });
    let active: AbortSignal | undefined;
    const pending = fixture(spec);
    pending.fetcher.mockImplementation(async (_url, init) => {
      active = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("data: "));
          queueMicrotask(() => controller2.abort());
        },
      }));
    });
    const controller2 = new AbortController();
    await assert.rejects(async () => pending.adapter.execute(request(spec), { signal: controller2.signal }), { name: "AbortError" });
    assert.equal(active?.aborted, true);
  });

  test(`${spec.kind}: probes confirm model access, while smoke makes a separate inference and returns redacted actual reply`, async () => {
    const probe = fixture(spec, () => json(spec.metadata));
    assert.deepEqual(await probe.adapter.probe!({}), {
      ok: true, detail: { check: "model-access", model: spec.model },
    });
    assert.equal(probe.fetcher.mock.calls[0][1]?.method, "GET");
    assert.equal(probe.fetcher.mock.calls.length, 1);
    const denied = fixture(spec, () => json({}));
    await assert.rejects(async () => denied.adapter.probe!({}), /did not confirm/);
    const smoke = fixture(spec, () => sse(spec.reply(`Actual synthetic reply ${key} sk-synthetic-other ${"x".repeat(2200)}`)));
    const result = await smoke.adapter.testSmoke(request(spec), {});
    assert.equal(result.ok, true);
    const detail = result.detail as { check: string; model: string; response: string };
    assert.equal(detail.check, "model-response");
    assert.ok(detail.response.startsWith("Actual synthetic reply [redacted] [redacted]"));
    assert.ok(detail.response.length <= 2048);
    assert.equal(smoke.fetcher.mock.calls.length, 1);
    assert.equal(smoke.fetcher.mock.calls[0][1]?.method, "POST");
    assert.match(String(smoke.fetcher.mock.calls[0][1]?.body), /Reply with OK/);
    assert.doesNotMatch(String(smoke.fetcher.mock.calls[0][1]?.body), /Synthetic request/);
    const empty = fixture(spec, () => sse(spec.reply("")));
    await assert.rejects(() => empty.adapter.testSmoke(request(spec), {}), /did not return a smoke-test response/);
  });

  test(`${spec.kind}: smoke errors retain bounded redacted provider diagnostics, without retries`, async () => {
    const f = fixture(spec, () => json({ error: {
      code: "synthetic_quota", message: `actual fixture error ${key} AIzaSyntheticOther ${"x".repeat(2400)}`,
    } }, 429));
    await assert.rejects(() => f.adapter.testSmoke(request(spec), {}), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 429.*synthetic_quota.*actual fixture error \[redacted\] \[redacted\]/);
      assert.ok(!error.message.includes(key));
      assert.ok(error.message.length < 2100);
      return true;
    });
    assert.equal(f.fetcher.mock.calls.length, 1);
    const network = fixture(spec, () => { throw new Error(`synthetic CORS failure ${key}`); });
    await assert.rejects(() => network.adapter.testSmoke(request(spec), {}), /synthetic CORS failure \[redacted\]/);
    assert.equal(network.fetcher.mock.calls.length, 1);
  });

  test(`${spec.kind}: malformed, interrupted and oversized streams never settle successfully`, async () => {
    for (const response of [
      () => new Response("data: malformed\n\n"),
      () => new Response("data: {}\n\n"),
      () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ]) {
      const f = fixture(spec, response);
      await assert.rejects(async () => f.adapter.execute(request(spec), {}));
      assert.equal(f.fetcher.mock.calls.length, 1);
    }
    const f = fixture(spec);
    await assert.rejects(async () => f.adapter.execute({ ...request(spec), input: { bad: "shape" } }, {}), /Supply/);
    const huge: Json = spec.kind === "gemini-byok"
      ? { contents: [{ role: "user", parts: [{ text: "x".repeat(16 * 1024 * 1024) }] }] }
      : { input: [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }] };
    await assert.rejects(async () => f.adapter.execute({ ...request(spec), input: huge }, {}), /size budget/);
    assert.equal(f.fetcher.mock.calls.length, 0);
  });
}

test("Gemini model discovery paginates, filters and rejects repeated cursors", async () => {
  const spec = providers[0];
  let page = 0;
  const f = fixture(spec, () => json(++page === 1 ? {
    models: [
      { name: "models/gemini-z", displayName: "Synthetic Z", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-fixture", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "synthetic cursor",
  } : { models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }] }));
  assert.deepEqual(await f.adapter.listModels({}), [
    { id: "gemini-a", label: "gemini-a" }, { id: "gemini-z", label: "Synthetic Z" },
  ]);
  assert.match(String(f.fetcher.mock.calls[1][0]), /pageToken=synthetic%20cursor/);
  assert.ok(f.fetcher.mock.calls.every(([, init]) => init?.method === "GET"));
  const repeat = fixture(spec, () => json({ models: [], nextPageToken: "same" }));
  await assert.rejects(() => repeat.adapter.listModels({}), /cursor/);
  assert.equal(repeat.fetcher.mock.calls.length, 2);
});

test("OpenAI discovery offers candidate text/tool families, not a model acceptance claim", async () => {
  const f = fixture(providers[1], () => json({ data: [
    { id: "gpt-4.1-fixture" }, { id: "gpt-5-fixture" }, { id: "o3-fixture" },
    { id: "gpt-4o-audio-preview" }, { id: "gpt-image-1" }, { id: "text-embedding-3-small" },
    { id: "gpt-5-codex" }, { id: "unknown-model" },
  ] }));
  assert.deepEqual((await f.adapter.listModels({})).map(model => model.id),
    ["gpt-4.1-fixture", "gpt-5-fixture", "o3-fixture"]);
  assert.equal(f.fetcher.mock.calls.length, 1);
  assert.match(String(f.fetcher.mock.calls[0][0]), /\/v1\/models$/);
});

test("Gemini preserves function calls and thought signatures without invoking tools", async () => {
  const parts = [{ thought: true, text: "Synthetic thought", thoughtSignature: "opaque-fixture" },
    { functionCall: { id: "call-fixture", name: "synthetic_tool", args: { value: 1 } } }];
  const f = fixture(providers[0], () => sse({ candidates: [{
    content: { parts }, finishReason: "STOP",
  }] }));
  assert.deepEqual((await f.adapter.execute(request(providers[0]), {})).output, { parts, finishReason: "STOP" });
});

test("OpenAI preserves opaque reasoning and tool calls and rejects incomplete streams", async () => {
  const spec = providers[1];
  const items = [{ type: "reasoning", id: "reason-fixture", encrypted_content: "opaque-fixture" },
    { type: "function_call", call_id: "call-fixture", name: "synthetic_tool", arguments: '{"value":1}' }];
  const f = fixture(spec, () => sse({ type: "response.completed", response: { status: "completed", output: items } }));
  assert.deepEqual((await f.adapter.execute(request(spec), {})).output, { items });
  const incomplete = fixture(spec, () => sse({ type: "response.incomplete",
    response: { incomplete_details: { reason: `synthetic_output_limit ${key}` } } }));
  await assert.rejects(() => incomplete.adapter.testSmoke(request(spec), {}), /synthetic_output_limit \[redacted\]/);
  const failed = fixture(spec, () => sse({ type: "response.failed",
    response: { error: { code: "fixture_failure", message: `synthetic failure ${key}` } } }));
  await assert.rejects(() => failed.adapter.testSmoke(request(spec), {}), /fixture_failure.*synthetic failure \[redacted\]/);
});

test("memory credential access cancels replaced grants and exposes only non-secret snapshots", async () => {
  const store = createMemoryCredentialStore();
  const access = createCredentialAccess(store, "ai/synthetic");
  const listener = vi.fn();
  const unsubscribe = access.subscribe(listener);
  await assert.rejects(() => access.resolve(), /Configure/);
  await access.save(` ${key} `);
  const grant = await access.resolve();
  assert.equal(grant.key, key);
  assert.equal(access.getSnapshot().available, true);
  assert.ok(!JSON.stringify(access.getSnapshot()).includes(key));
  await access.save("synthetic-replacement");
  assert.equal(grant.signal.aborted, true);
  assert.throws(() => grant.check(), { name: "AbortError" });
  const replacement = await access.resolve();
  await access.clear();
  assert.equal(replacement.signal.aborted, true);
  assert.equal(access.getSnapshot().available, false);
  assert.equal(await store.read("ai/synthetic"), undefined);
  await assert.rejects(() => access.resolve(), /Configure/);
  assert.ok(listener.mock.calls.length > 0);
  unsubscribe();
  for (const invalid of ["", "has spaces", "bad\nkey", "x".repeat(4097)])
    await assert.rejects(() => access.save(invalid), /valid API key/);
});

test("host-injected async stores cannot resurrect a key when clear overtakes save", async () => {
  const memory = createMemoryCredentialStore();
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const store: CredentialStore = { ...memory,
    async write(reference, value) { await gate; await memory.write(reference, value); },
  };
  const access = createCredentialAccess(store, "ai/synthetic");
  const save = access.save(key);
  const clear = access.clear();
  complete();
  await Promise.all([save, clear]);
  assert.equal(await store.read("ai/synthetic"), undefined);
  assert.equal(access.getSnapshot().available, false);
  await assert.rejects(() => access.resolve(), /Configure/);
});

test("host vault read failures remain failures and in-flight reads are invalidated", async () => {
  let complete!: (key: string) => void;
  const store: CredentialStore = {
    read: () => new Promise(resolve => { complete = resolve; }),
    async write() {}, async remove() {},
  };
  const access = createCredentialAccess(store, "ai/synthetic");
  const resolving = access.resolve();
  await Promise.resolve();
  await access.clear();
  complete(key);
  await assert.rejects(() => resolving, { name: "AbortError" });
  const failed = createCredentialAccess({ ...store, async read() { throw new Error("Synthetic vault offline"); } }, "vault/fixture");
  await assert.rejects(() => failed.resolve(), /Synthetic vault offline/);
});
