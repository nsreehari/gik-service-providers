import { requireServiceDependency, serviceConfig, UnsatisfiedServiceDependencyError } from "gik-controlface/services";
import type { ServiceDependencyRequirement, ServiceKindContext } from "gik-controlface/services";
import type { NativeServiceDeclaration } from "gik-kernel";

export interface ApiCredential {
  key: string;
  signal: AbortSignal;
  check(): void;
}
export const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?![\s\S])/;
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function redactDiagnostic(text: string, key: string) {
  return text.split(key).join("[redacted]")
    .replace(/\bsk-[A-Za-z0-9_.*-]+/g, "[redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 2048);
}
function describeProviderError(value: unknown, key: string) {
  const redact = (text: string) => redactDiagnostic(text, key);
  const error = record(value) && record(value.error) ? value.error : value;
  if (typeof error === "string") return redact(error).slice(0, 2048);
  if (!record(error)) return "";
  const fields: string[] = [];
  for (const name of ["code", "status", "type", "param", "message"])
    if (typeof error[name] === "string" || typeof error[name] === "number") fields.push(`${name}: ${error[name]}`);
  if (record(error.incomplete_details) && typeof error.incomplete_details.reason === "string")
    fields.push(`reason: ${error.incomplete_details.reason}`);
  if (record(error.promptFeedback) && typeof error.promptFeedback.blockReason === "string")
    fields.push(`blockReason: ${error.promptFeedback.blockReason}`);
  return redact(fields.join("; ")).slice(0, 2048);
}
export function credentialRequirement(declaration: NativeServiceDeclaration, label: string): ServiceDependencyRequirement {
  const ref = serviceConfig(declaration).credentialRef;
  if (typeof ref !== "string" || !ref.trim()) throw new Error(`Supply a ${label} credential reference.`);
  return { id: "api-key", title: `${label} API Key`, kind: "credential", ref, scheme: `${declaration.kind}-api-key` };
}
async function boundedBody(response: Response, signal: AbortSignal, label: string) {
  if (!response.body) throw new Error(`${label} returned no response body.`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  const abort = () => { void reader.cancel().catch(error => {
    if (!signal.aborted) throw error;
  }); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error(`${label} exceeded the response size budget.`);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
export function createByokTransport(declaration: NativeServiceDeclaration, context: ServiceKindContext, options: {
  origin: string; label: string; header: "x-goog-api-key" | "authorization"; fetch?: typeof globalThis.fetch;
}) {
  const config = serviceConfig(declaration), { label } = options;
  if (typeof config.model !== "string" || !modelPattern.test(config.model)) throw new Error(`Enter a valid ${label} model ID.`);
  const model = config.model, dependency = credentialRequirement(declaration, label);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    model,
    async request(service: string, path: string, body?: unknown, signal?: AbortSignal, diagnostics = false) {
      signal?.throwIfAborted();
      requireServiceDependency(context, dependency, service);
      const url = new URL(path, options.origin);
      if (url.origin !== options.origin || !await context.authorizeEndpoint?.(declaration.kind, url))
        throw new Error(`The host denied the ${label} API endpoint.`);
      signal?.throwIfAborted();
      requireServiceDependency(context, dependency, service);
      const grant = await context.resolveCredential?.(dependency.ref!);
      if (!record(grant) || typeof grant.key !== "string" || !grant.key || grant.key.length > 4096
        || /[\s\x00-\x1f\x7f]/.test(grant.key) || !(grant.signal instanceof AbortSignal) || typeof grant.check !== "function")
        throw new UnsatisfiedServiceDependencyError(`Enter your ${label} API key.`, dependency);
      const key = grant.key;
      const describeError = (value: unknown) => diagnostics ? describeProviderError(value, key) : "";
      const redact = (text: string) => redactDiagnostic(text, key);
      grant.check();
      const active = AbortSignal.any([grant.signal, ...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
      active.throwIfAborted();
      requireServiceDependency(context, dependency, service);
      let response: Response;
      try {
        response = await fetcher(url.href, {
          method: body === undefined ? "GET" : "POST", credentials: "omit", cache: "no-store",
          redirect: "error", referrerPolicy: "no-referrer", signal: active,
          headers: { [options.header]: options.header === "authorization" ? `Bearer ${grant.key}` : grant.key,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        active.throwIfAborted();
        const detail = diagnostics && error instanceof Error ? redact(error.message) : "";
        throw new Error(`The ${label} API request could not connect.${detail ? ` ${detail}` : " Check your network and browser access."}`);
      }
      try {
        grant.check();
        requireServiceDependency(context, dependency, service);
        active.throwIfAborted();
        if (!response.ok) {
          let detail = "";
          if (diagnostics && response.body) {
            const text = await boundedBody(response, active, label);
            let error: unknown;
            try { error = JSON.parse(text); } catch { error = text; }
            detail = describeError(error);
            grant.check();
            requireServiceDependency(context, dependency, service);
            active.throwIfAborted();
          }
          const hints: Record<number, string> = {
            400: "Check the API key, model and request configuration.", 401: "Check your API key.",
            403: "The key or project is not permitted to use this model.",
            404: "The configured model is unavailable.", 429: "Your quota or rate limit was reached.",
          };
          throw new Error(`${label} returned HTTP ${response.status}. ${detail || hints[response.status] || "The provider request failed; it was not retried."}`);
        }
        let result: string;
        try { result = await boundedBody(response, active, label); }
        catch (error) {
          active.throwIfAborted();
          const detail = error instanceof Error ? redact(error.message) : "";
          throw new Error(`${label} response could not be read.${detail ? ` ${detail}` : ""}`);
        }
        grant.check();
        requireServiceDependency(context, dependency, service);
        active.throwIfAborted();
        return { text: result, describeError, redactDiagnostic: redact };
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    },
  };
}
