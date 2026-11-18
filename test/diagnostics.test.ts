import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ServiceKindContext, ServiceRequest } from "gik-controlface/services";
import type { NativeServiceDeclaration } from "gik-kernel";
import { createGmailServiceKind, GmailSendUncertainError, type GmailConnection } from "../src/gmail";
import { createMarketQuotesServiceKind } from "../src/market-quotes";
import { createSchedulerServiceKind } from "../src/scheduler";

afterEach(() => { vi.useRealTimers(); });
const identity = { blueprintId: "diagnostics", blueprintRevision: "1", serviceId: "sample" };
const context: ServiceKindContext = {
  identity, hostCapabilities: new Set(), inspectDependency: () => ({ state: "ready" }),
  authorizeEndpoint: () => true,
};
const settlement = { transform: { kind: "jsonata" as const, expr: "{}" } };
function mailDeclaration(operation: string): NativeServiceDeclaration {
  return {
    kind: "gmail", version: "1", config: { endpoint: "https://gmail.googleapis.com", credentialRef: "sample/google" },
    operations: { [operation]: { operation, contract: `gmail.${operation}/v1`, settlement } },
  };
}
function request(operation: string, input: ServiceRequest["input"] = {}): ServiceRequest {
  return {
    id: "sample-request", service: "sample", operation, input, providerId: "sample",
    capabilityId: "sample/v1", createdAt: "now",
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function mail(operation: string, connection: GmailConnection, overrides: Partial<ServiceKindContext> = {}) {
  return createGmailServiceKind().create(mailDeclaration(operation), {
    ...context, resolveCredential: async () => connection, ...overrides,
  });
}

test("Gmail probes check readiness without reading or sending; read smoke uses a bounded real read", async () => {
  const read = vi.fn<GmailConnection["request"]>(async () => json({ messages: [{ id: "synthetic" }] }));
  const adapter = mail("search", { request: read });
  assert.equal((await adapter.probe({})).ok, true);
  assert.equal(read.mock.calls.length, 0);
  assert.deepEqual(await adapter.testSmoke(request("search", { maxResults: 100 }), {}), {
    ok: true, detail: { check: "search", liveRead: true },
  });
  assert.equal(read.mock.calls.length, 1);
  assert.equal(new URL(read.mock.calls[0][0].url).searchParams.get("maxResults"), "1");
  await assert.rejects(() => Promise.resolve(adapter.testSmoke(request("send"), {})), /not declared/);
});

test("Gmail send smoke uses the actual sample input and original host invocation, never the read port", async () => {
  const send = vi.fn<NonNullable<GmailConnection["send"]>>(async () => json({ id: "synthetic-sent" }));
  const adapter = mail("send", { request: async () => assert.fail("No read with send-only consent"), send });
  assert.equal((await adapter.probe({})).ok, true);
  assert.equal(send.mock.calls.length, 0);
  const sample = request("send", { raw: "VG86IHRlc3RAZXhhbXBsZS5pbnZhbGlkDQoNClNhbXBsZQ" });
  assert.deepEqual(await adapter.testSmoke(sample, {}), {
    ok: true, detail: { check: "send", messageId: "synthetic-sent" },
  });
  assert.equal(send.mock.calls.length, 1);
  assert.equal(send.mock.calls[0][0].method, "POST");
  assert.deepEqual(JSON.parse(send.mock.calls[0][0].body!), sample.input);
  assert.deepEqual(send.mock.calls[0][1], sample);
  const missing = mail("send", { request: async () => json({}) });
  await assert.rejects(() => Promise.resolve(missing.probe({})), /send port/);
});

test.each(["network", "server", "missing-id"])("Gmail send smoke preserves uncertain completion without retries: %s", async (failure) => {
  const send = vi.fn(async () => {
    if (failure === "network") throw new Error("Disconnected after POST");
    return failure === "server" ? json({}, 503) : json({});
  });
  const adapter = mail("send", { request: async () => assert.fail("No read"), send });
  await assert.rejects(() => Promise.resolve(adapter.testSmoke(request("send", { raw: "U2FtcGxl" }), {})), GmailSendUncertainError);
  assert.equal(send.mock.calls.length, 1);
});

test("Gmail smoke respects revocation and cancellation before accessing transport", async () => {
  const read = vi.fn(async () => json({}));
  const controller = new AbortController();
  controller.abort();
  const adapter = mail("search", { request: read });
  await assert.rejects(() => Promise.resolve(adapter.testSmoke(request("search"), { signal: controller.signal })), { name: "AbortError" });
  const revoked = mail("search", { request: read }, {
    inspectDependency: () => ({ state: "authorization-required", message: "Reconnect the account" }),
  });
  await assert.rejects(() => Promise.resolve(revoked.probe({})), /Reconnect/);
  await assert.rejects(() => Promise.resolve(revoked.testSmoke(request("search"), {})), /Reconnect/);
  assert.equal(read.mock.calls.length, 0);
});

test("probes inspect the requested service when an adapter is shared", async () => {
  const serviceIds: string[] = [];
  const adapter = mail("search", { request: async () => assert.fail("Probe must not read mail") }, {
    inspectDependency(_requirement, current) {
      serviceIds.push(current.serviceId);
      return { state: "ready" };
    },
  });
  assert.equal((await adapter.probe({ serviceId: "another-service" })).ok, true);
  assert.deepEqual(serviceIds, ["another-service", "another-service"]);
});

test("quote probe is transport-free; smoke executes the supplied reference symbols and propagates errors", async () => {
  const execute = vi.fn(async () => ({ quotes: [{ symbol: "ACME", price: 42 }] }));
  const adapter = createMarketQuotesServiceKind().create({
    kind: "market-quotes", version: "1", config: { providerRef: "quotes/sample" },
    operations: { get: { operation: "get", contract: "market-quotes/v1", settlement } },
  }, { ...context, execute });
  assert.equal((await adapter.probe({})).ok, true);
  assert.equal(execute.mock.calls.length, 0);
  assert.deepEqual(await adapter.testSmoke(request("get", { symbols: ["ACME"] }), {}), {
    ok: true, detail: { check: "quote-request", liveRead: true },
  });
  assert.equal(execute.mock.calls.length, 1);
  execute.mockRejectedValue(new Error("Quote endpoint unavailable"));
  await assert.rejects(() => Promise.resolve(adapter.testSmoke(request("get", { symbols: ["ACME"] }), {})), /unavailable/);
  await assert.rejects(() => Promise.resolve(adapter.testSmoke(request("get", { symbols: ["invalid"] }), {})), /uppercase/);
  assert.equal(execute.mock.calls.length, 2);
});

function scheduler() {
  return createSchedulerServiceKind().create({
    kind: "cron-scheduler", version: "1", config: { expression: "0 9 * * *", timezone: "UTC" },
    operations: { tick: { operation: "tick", contract: "scheduler.cron/v1", settlement } },
  }, context);
}

test("scheduler smoke fires a real one-shot timer independently of its configured schedule and cleans it up", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const adapter = scheduler();
  const probe = await adapter.probe({});
  assert.equal(probe.detail?.nextRun, "2026-01-01T09:00:00.000Z");
  assert.equal(vi.getTimerCount(), 0);
  let completed = false;
  const pending = Promise.resolve(adapter.testSmoke(request("tick"), {})).then((result) => { completed = true; return result; });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(completed, false);
  await vi.advanceTimersByTimeAsync(1500);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.detail?.check, "one-shot-timer");
  assert.equal(typeof result.detail?.firedAt, "string");
  assert.equal(vi.getTimerCount(), 0);
});

test("aborting scheduler smoke cancels its one-shot timer without late success", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = Promise.resolve(scheduler().testSmoke(request("tick"), { signal: controller.signal }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(vi.getTimerCount(), 0);
});
