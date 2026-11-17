import type { ServiceDependencyRequirement, ServiceDependencyStatus } from "gik-controlface/services";
import { gmailScopes, type GmailConnection } from "./gmail";

/** Host-created grant. Tokens are read only inside the connection's request port. */
export interface GmailReadGrant {
  expiresAt: number;
  grantedScopes: readonly string[];
  getToken(): string;
  invalidate(): void;
}

export interface GmailReadAuthorizationRequest {
  permissions: readonly string[];
  signal: AbortSignal;
}

export interface GmailReadConnectionOptions {
  credentialRef: string;
  authorize(request: GmailReadAuthorizationRequest): Promise<GmailReadGrant>;
  fetcher?: typeof fetch;
  clock?: () => number;
}

/** Optional host utility; it neither opens OAuth UI nor implements send authority. */
export function createGmailReadConnection({
  credentialRef, authorize, fetcher = globalThis.fetch, clock = Date.now,
}: GmailReadConnectionOptions) {
  if (!credentialRef.trim()) throw new Error("A registered Gmail credential reference is required.");
  let session: GmailReadGrant | undefined;
  let generation = 0;
  let pending: AbortController | undefined;
  let lifetime = new AbortController();
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let snapshot = { authorized: false, busy: false, revision: 0 };
  const subscribers = new Set<() => void>();
  const live = () => !!session && session.expiresAt > clock() + 10_000;
  const publish = () => {
    snapshot = { authorized: live(), busy: !!pending, revision: snapshot.revision + 1 };
    for (const listener of subscribers) listener();
  };
  function disconnect() {
    generation++;
    pending?.abort();
    pending = undefined;
    lifetime.abort();
    lifetime = new AbortController();
    clearTimeout(expiry);
    const previous = session;
    session = undefined;
    publish();
    previous?.invalidate();
  }
  function registered(requirement: ServiceDependencyRequirement) {
    return requirement.kind === "credential" && requirement.scheme === "google-oauth2"
      && requirement.ref === credentialRef;
  }
  function supported(permissions: readonly string[]) {
    return permissions.length > 0 && permissions.every(permission => permission === gmailScopes.readonly);
  }
  function inspect(requirement: ServiceDependencyRequirement): ServiceDependencyStatus {
    if (!registered(requirement)) return {
      state: "unavailable", message: "This credential reference is not registered with the Gmail read connection.",
    };
    const permissions = requirement.permissions ?? [];
    if (!supported(permissions)) return {
      state: "unavailable", message: "This connection supports Gmail read access only; sending requires separate host authority.",
    };
    if (!live()) return { state: "authorization-required", message: "Authorize Gmail read access through the host." };
    if (permissions.some(permission => !session!.grantedScopes.includes(permission))) {
      return { state: "insufficient-permissions", message: "The Gmail grant does not cover the declared read operations." };
    }
    return { state: "ready" };
  }
  const connection: GmailConnection = {
    async request(input) {
      const current = session;
      if (!current || !live() || !current.grantedScopes.includes(gmailScopes.readonly)) {
        throw new Error("Authorize Gmail read access before requesting messages.");
      }
      const url = new URL(input.url);
      if (url.origin !== "https://gmail.googleapis.com" || url.username || url.password || url.hash
        || input.method !== "GET" || input.body !== undefined
        || !/^\/gmail\/v1\/users\/me\/messages(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)
        || [...url.searchParams.keys()].some(key => !["q", "maxResults", "pageToken", "format"].includes(key))) {
        throw new Error("The Gmail request is outside the registered read surface.");
      }
      const version = generation;
      const signal = AbortSignal.any([input.signal, lifetime.signal, AbortSignal.timeout(30_000)]);
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (version !== generation || session !== current || !live()) {
          throw new Error("The Gmail connection changed during the request.");
        }
      };
      assertCurrent();
      const response = await fetcher(url, {
        method: "GET", signal, credentials: "omit", redirect: "error",
        headers: { Authorization: `Bearer ${current.getToken()}` },
      });
      assertCurrent();
      if (response.status === 401) {
        disconnect();
        throw new Error("Gmail authorization expired. Authorize Gmail again.");
      }
      const limit = 8 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw new Error("The Gmail response exceeds its size limit.");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read();
            assertCurrent();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > limit) throw new Error("The Gmail response exceeds its size limit.");
            chunks.push(part.value);
          }
        } catch (error) {
          await reader.cancel();
          throw error;
        } finally {
          reader.releaseLock();
        }
      }
      assertCurrent();
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(response.body ? body : null, {
        status: response.status, statusText: response.statusText,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    },
  };
  return {
    connection,
    inspect,
    disconnect,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    async connect(requirement: ServiceDependencyRequirement, signal?: AbortSignal) {
      if (pending) throw new Error("Gmail authorization is already in progress.");
      if (!registered(requirement) || !supported(requirement.permissions ?? [])) {
        throw new Error("This Gmail read credential requirement is not registered with the host.");
      }
      signal?.throwIfAborted();
      const version = ++generation;
      const controller = new AbortController();
      pending = controller;
      const authorizationSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      publish();
      try {
        const authorized = await authorize({ permissions: [gmailScopes.readonly], signal: authorizationSignal });
        if (version !== generation || authorizationSignal.aborted) {
          authorized.invalidate();
          throw new DOMException("Gmail authorization was cancelled.", "AbortError");
        }
        if (!Number.isFinite(authorized.expiresAt) || authorized.expiresAt <= clock() + 10_000
          || !authorized.grantedScopes.includes(gmailScopes.readonly)) {
          authorized.invalidate();
          throw new Error("The Gmail grant is expired or does not include read permission.");
        }
        const previous = session;
        lifetime.abort();
        lifetime = new AbortController();
        session = authorized;
        clearTimeout(expiry);
        expiry = setTimeout(() => {
          if (session === authorized) disconnect();
        }, Math.min(2_147_483_647, authorized.expiresAt - clock() - 10_000));
        expiry.unref?.();
        if (previous !== authorized) previous?.invalidate();
      } finally {
        if (pending === controller) pending = undefined;
        publish();
      }
    },
  };
}
