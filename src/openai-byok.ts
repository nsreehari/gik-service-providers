import type { ServiceAdapter, ServiceAdapterContext, ServiceKindContext, ServiceKindFactory, ServiceProbeResult, ServiceRequest } from "gik-controlface/services";
import type { Json, NativeServiceDeclaration } from "gik-kernel";
import { createByokTransport, credentialRequirement, modelPattern, record } from "./byok/transport";
import type { ModelDiscovery } from "./byok/models";

export interface OpenAiByokAdapter extends ServiceAdapter, ModelDiscovery {
  testSmoke(request: ServiceRequest, context: ServiceAdapterContext): Promise<ServiceProbeResult>;
}
export interface OpenAiByokFactory extends ServiceKindFactory {
  readonly manifest: ServiceKindFactory["manifest"] & { supports: { probe: true; testSmoke: true; cancel: true; stream: true } };
  create(declaration: NativeServiceDeclaration, context: ServiceKindContext): OpenAiByokAdapter;
}
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return record(value) && Object.values(value).every(isJson);
}
function responseFailure(actual: string) {
  return new Error(actual ? `OpenAI: ${actual}`
    : "OpenAI did not complete the response. No tools were executed from this response.");
}
export function createOpenAiByokServiceKind(options: { fetch?: typeof globalThis.fetch } = {}): OpenAiByokFactory {
  const provider = { id: "openai-byok", version: "1" };
  return {
    manifest: {
      ...provider, title: "OpenAI - Your API Key", subjects: ["cell", "chat", "task"], executionModes: ["immediate"],
      supports: { probe: true, cancel: true, stream: true, testSmoke: true },
      operationConstraints: { generate: { queueable: false, retryable: false } },
      configSchema: { type: "object", additionalProperties: false, required: ["model", "credentialRef"],
        properties: { model: { type: "string", pattern: modelPattern.source }, credentialRef: { type: "string", minLength: 1 } } },
    },
    describeDependencies: declaration => [credentialRequirement(declaration, "OpenAI")],
    validate(declaration, context) {
      const supported = declaration.version === "1" && !!context.resolveCredential && !!context.authorizeEndpoint
        && Object.values(declaration.operations).length > 0
        && Object.values(declaration.operations).every(operation => operation.operation === "generate"
          && operation.contract === "openai.generate/v1" && operation.mode !== "queued" && !operation.sense
          && !["retry", "correction-prompt"].includes(operation.onViolation?.action ?? ""));
      return supported ? { ok: true } : { ok: false, errors: [
        "OpenAI BYOK requires immediate generate/openai.generate/v1, host credentials and endpoint admission without automatic retries.",
      ] };
    },
    create(declaration, context) {
      const transport = createByokTransport(declaration, context, {
        ...options, origin: "https://api.openai.com", label: "OpenAI", header: "authorization",
      });
      async function generate(request: ServiceRequest, execution: ServiceAdapterContext, diagnostics = false) {
        if (request.operation !== "generate") throw new Error("Unsupported OpenAI operation.");
        const input = request.input;
        if (!record(input) || !Array.isArray(input.input) || !input.input.length || !isJson(input)
          || Object.keys(input).some(key => !["input", "tools"].includes(key)))
          throw new Error("Supply OpenAI input items and optional tools.");
        const body = { ...input, model: transport.model, stream: true, store: false,
          include: ["reasoning.encrypted_content"], max_output_tokens: 8192 };
        if (new TextEncoder().encode(JSON.stringify(body)).length > 16 * 1024 * 1024)
          throw new Error("The OpenAI request exceeds its size budget.");
        const stream = await transport.request(request.service, "/v1/responses", body, execution.signal, diagnostics);
        let completed: Record<string, unknown> | undefined;
        for (const event of stream.text.replace(/\r\n/g, "\n").split("\n\n")) {
          const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          let chunk: unknown;
          try { chunk = JSON.parse(data); } catch { throw new Error("OpenAI returned malformed streaming JSON."); }
          if (!record(chunk) || !isJson(chunk)) throw new Error("OpenAI returned invalid response data.");
          if (["error", "response.failed", "response.incomplete"].includes(String(chunk.type))) {
            const failure = record(chunk.response) ? chunk.response : chunk;
            throw responseFailure(stream.describeError(failure));
          }
          if (chunk.type === "response.completed") {
            if (completed || !record(chunk.response)) throw new Error("OpenAI returned an ambiguous response.");
            completed = chunk.response;
          }
        }
        if (!completed || completed.status !== "completed" || completed.error || !Array.isArray(completed.output)
          || !completed.output.length || !isJson(completed.output))
          throw responseFailure(stream.describeError(completed));
        for (const item of completed.output) {
          if (!record(item)) throw new Error("OpenAI returned an invalid output item.");
          if (item.type === "function_call") {
            if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string"
              || typeof item.arguments !== "string" || item.status && item.status !== "completed")
              throw new Error("OpenAI returned an invalid function call.");
          } else if (item.type === "message") {
            if (item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)
              || !item.content.every(part => record(part) && part.type === "output_text" && typeof part.text === "string"))
              throw new Error("OpenAI returned a refused or invalid assistant response.");
          } else if (item.type !== "reasoning") throw new Error("OpenAI returned an unsupported output item.");
        }
        return { output: completed.output, redactDiagnostic: stream.redactDiagnostic };
      }
      return {
        provider,
        async listModels(execution) {
          if (!context.identity?.serviceId) throw new Error("Model discovery requires a service identity.");
          const raw = await transport.request(context.identity.serviceId, "/v1/models", undefined, execution.signal);
          let result: unknown;
          try { result = JSON.parse(raw.text); } catch { throw new Error("OpenAI returned invalid model discovery JSON."); }
          if (!record(result) || !Array.isArray(result.data)) throw new Error("OpenAI returned invalid model discovery data.");
          const models = new Map<string, { id: string; label: string }>();
          for (const model of result.data) {
            if (!record(model) || typeof model.id !== "string") throw new Error("OpenAI returned invalid model metadata.");
            const id = model.id;
            // The Models API has no capability metadata. Admit known text/tool families only.
            if (modelPattern.test(id) && /^(?:gpt-(?:4|5)(?:[.\w-]|$)|o[134](?:-|$)|chatgpt-)/.test(id)
              && !/(?:audio|realtime|transcri|tts|image|search|computer|deep-research|codex)/i.test(id))
              models.set(id, { id, label: id });
            if (models.size > 999) throw new Error("OpenAI model discovery exceeded its model budget.");
          }
          return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
        },
        discover: async () => ({ provider, revision: "1", discoveredAt: new Date().toISOString(),
          capabilities: [{ id: "openai.generate/v1", operation: "generate", version: "1",
            inputSchema: { type: "object", required: ["input"], properties: { input: { type: "array", minItems: 1 }, tools: { type: "array" } }, additionalProperties: false },
            assurance: "declared-and-locally-validated" }] }),
        async probe(execution) {
          const serviceId = context.identity?.serviceId;
          if (!serviceId) throw new Error("The OpenAI probe requires a service identity.");
          const raw = await transport.request(serviceId, `/v1/models/${transport.model}`, undefined, execution.signal);
          let metadata: unknown;
          try { metadata = JSON.parse(raw.text); } catch { throw new Error("OpenAI returned invalid model metadata."); }
          if (!record(metadata) || metadata.id !== transport.model) throw new Error("OpenAI did not confirm the configured model.");
          return { ok: true, detail: { check: "model-access", model: transport.model } };
        },
        async testSmoke(request, execution) {
          const result = await generate({ ...request, operation: "generate", input: {
            input: [{ role: "user", content: "Reply with OK. This is a connection test." }],
          } }, execution, true);
          const response = result.output.flatMap(item => record(item) && item.type === "message" && Array.isArray(item.content)
            ? item.content.flatMap(part => record(part) && typeof part.text === "string" ? [part.text] : []) : []).join("");
          if (!response.trim())
            throw new Error("OpenAI did not return a smoke-test response.");
          return { ok: true, detail: { check: "model-response", model: transport.model, response: result.redactDiagnostic(response) } };
        },
        async execute(request, execution) { return { output: { items: (await generate(request, execution)).output } }; },
      };
    },
  };
}
