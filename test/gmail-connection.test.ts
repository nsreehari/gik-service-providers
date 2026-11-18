import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ServiceDependencyRequirement } from "gik-controlface/services";
import { createGmailAuthorizationConnection, createGmailReadConnection, type GmailReadGrant, type GmailAuthorizationRequest } from "../src/gmail-connection";
import { gmailScopes } from "../src/gmail";

afterEach(() => vi.useRealTimers());
const requirement: ServiceDependencyRequirement = {
  id: "read", title: "Read", kind: "credential", scheme: "google-oauth2",
  ref: "google/test", permissions: [gmailScopes.readonly],
};
const input = () => ({
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=synthetic",
  method: "GET" as const, signal: new AbortController().signal,
});
function grant(): GmailReadGrant {
  return {
    expiresAt: Date.now() + 60_000, grantedScopes: [gmailScopes.readonly],
    getToken: () => "synthetic-token", invalidate: vi.fn(),
  };
}

test("discovery is passive and only read requirements can authorize", async () => {
  const authorized = grant();
  const authorize = vi.fn(async () => authorized);
  const helper = createGmailReadConnection({ credentialRef: requirement.ref!, authorize });
  assert.equal(helper.inspect(requirement).state, "authorization-required");
  assert.equal(authorize.mock.calls.length, 0);
  assert.equal(helper.inspect({ ...requirement, permissions: [gmailScopes.send] }).state, "unavailable");
  await assert.rejects(helper.connect({ ...requirement, ref: "other" }), /not registered/);
  await helper.connect(requirement);
  assert.equal(helper.inspect(requirement).state, "ready");
  assert.deepEqual(Object.keys(helper.getSnapshot()).sort(), ["authorized", "busy", "revision"]);
  assert.equal(helper.connection.send, undefined);
  helper.disconnect();
  assert.equal(helper.getSnapshot().authorized, false);
  assert.equal(vi.mocked(authorized.invalidate).mock.calls.length, 1);
});

test("read port bounds endpoints and returns the existing Response contract", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{"messages":[]}'));
  const helper = createGmailReadConnection({ credentialRef: requirement.ref!, authorize: async () => grant(), fetcher });
  await helper.connect(requirement);
  for (const url of ["https://example.test/gmail/v1/users/me/messages",
    `${input().url}&unknown=1`, "https://gmail.googleapis.com/gmail/v1/users/me/profile"]) {
    await assert.rejects(helper.connection.request({ ...input(), url }), /read surface/);
  }
  await assert.rejects(helper.connection.request({ ...input(), method: "POST" }), /read surface/);
  assert.equal(fetcher.mock.calls.length, 0);
  assert.deepEqual(await (await helper.connection.request(input())).json(), { messages: [] });
  assert.equal(fetcher.mock.calls[0][1]?.credentials, "omit");
  assert.equal(fetcher.mock.calls[0][1]?.redirect, "error");
  helper.disconnect();
});

test("late authorization after disconnect is invalidated and never installed", async () => {
  let resolve!: (value: GmailReadGrant) => void;
  const helper = createGmailReadConnection({
    credentialRef: requirement.ref!, authorize: () => new Promise(value => { resolve = value; }),
  });
  const pending = helper.connect(requirement);
  helper.disconnect();
  const stale = grant();
  resolve(stale);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(helper.getSnapshot().authorized, false);
  assert.equal(vi.mocked(stale.invalidate).mock.calls.length, 1);
});

test("stale 401 cannot revoke a replacement grant", async () => {
  let resolve!: (value: Response) => void;
  const next = grant();
  const authorize = vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(next);
  const fetcher = vi.fn<typeof fetch>(() => new Promise(value => { resolve = value; }));
  const helper = createGmailReadConnection({ credentialRef: requirement.ref!, authorize, fetcher });
  await helper.connect(requirement);
  const pending = helper.connection.request(input());
  helper.disconnect();
  await helper.connect(requirement);
  resolve(new Response("{}", { status: 401 }));
  await assert.rejects(pending);
  assert.equal(helper.getSnapshot().authorized, true);
  assert.equal(vi.mocked(next.invalidate).mock.calls.length, 0);
  helper.disconnect();
});

test("expiry and cancelled authorization deny access without transport", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>();
  const helper = createGmailReadConnection({ credentialRef: requirement.ref!, authorize: async () => grant(), fetcher });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(helper.connect(requirement, abort.signal), { name: "AbortError" });
  await helper.connect(requirement);
  await vi.advanceTimersByTimeAsync(50_000);
  assert.equal(helper.getSnapshot().authorized, false);
  await assert.rejects(helper.connection.request(input()), /Authorize Gmail/);
  assert.equal(fetcher.mock.calls.length, 0);
  helper.disconnect();
});

test("streaming size and disconnect during body consumption fail closed", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) { stream = controller; },
  })));
  const helper = createGmailReadConnection({ credentialRef: requirement.ref!, authorize: async () => grant(), fetcher });
  await helper.connect(requirement);
  const oversized = helper.connection.request(input());
  await Promise.resolve();
  stream.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
  await assert.rejects(oversized, /size limit/);
  const stale = helper.connection.request(input());
  await Promise.resolve();
  helper.disconnect();
  stream.close();
  await assert.rejects(stale);
});

test("separate read and send grants preserve consent isolation without providing send authority", async () => {
  const sendRequirement = { ...requirement, ref: "google/send", permissions: [gmailScopes.send] };
  const readGrant = grant(), sendGrant = { ...grant(), grantedScopes: [gmailScopes.send] };
  const authorize = vi.fn<(request: GmailAuthorizationRequest) => Promise<GmailReadGrant>>(async () => sendGrant);
  const read = createGmailAuthorizationConnection({ credentialRef: requirement.ref!, authorize: async () => readGrant });
  const send = createGmailAuthorizationConnection({ credentialRef: sendRequirement.ref, authorize });
  try {
    assert.equal(send.inspect(sendRequirement).actions?.[0].id, "gmail.authorize");
    await read.connect(requirement);
    await send.connect(sendRequirement);
    assert.deepEqual(authorize.mock.calls[0][0].permissions, [gmailScopes.send]);
    assert.equal(send.inspect(sendRequirement).state, "ready");
    assert.equal(send.inspect(sendRequirement).actions?.[0].id, "gmail.disconnect");
    assert.equal(send.inspect({ ...sendRequirement, kind: "gmail-send-authority" }).state, "authorization-required");
    assert.equal(send.connection.send, undefined);
    await assert.rejects(send.connection.request(input()), /Authorize Gmail read access/);
    read.disconnect();
    assert.equal(send.getSnapshot().authorized, true);
    assert.equal(vi.mocked(sendGrant.invalidate).mock.calls.length, 0);
    assert.equal(read.inspect(sendRequirement).state, "unavailable");
  } finally { read.disconnect(); send.disconnect(); }
});

test("scope upgrades reject partial grants and propagate authorization errors", async () => {
  const authorize = vi.fn()
    .mockResolvedValueOnce(grant())
    .mockRejectedValueOnce(new Error("Host denied consent"));
  const helper = createGmailAuthorizationConnection({ credentialRef: requirement.ref!, authorize });
  const both = { ...requirement, permissions: [gmailScopes.readonly, gmailScopes.send] };
  await assert.rejects(helper.connect(both), /requested permissions/);
  assert.equal(helper.inspect(both).state, "authorization-required");
  await assert.rejects(helper.connect(requirement), /Host denied consent/);
  assert.equal(helper.getSnapshot().busy, false);
  helper.disconnect();
});
