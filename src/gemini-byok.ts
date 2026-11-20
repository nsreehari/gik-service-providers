import type {
  ServiceAdapter, ServiceAdapterContext, ServiceDependencyRequirement, ServiceKindContext,
  ServiceKindFactory, ServiceProbeResult, ServiceRequest,
} from "gik-controlface/services";
import type { Json, NativeServiceDeclaration } from "gik-kernel";
import { createByokTransport, credentialRequirement, modelPattern, record } from "./byok/transport";
import type { ModelDiscovery, ByokModel } from "./byok/models";
export type { ApiCredential as GeminiCredential } from "./byok/transport";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args: Record<string, Json> };
  functionResponse?: { id?: string; name: string; response: Record<string, Json> };
}
export interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }
export interface GeminiGeneration {
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: Array<{
    name: string; description?: string; parameters: Record<string, Json>;
  }> }>;
}
export interface GeminiModelReply { parts: GeminiPart[]; finishReason: string }
export function isGeminiPart(value: unknown): value is GeminiPart {
  return record(value) && json(value)
    && (value.text === undefined || typeof value.text === "string")
    && (value.thought === undefined || typeof value.thought === "boolean")
    && (value.thoughtSignature === undefined || typeof value.thoughtSignature === "string")
    && (value.functionCall === undefined || record(value.functionCall) && typeof value.functionCall.name === "string"
      && record(value.functionCall.args) && json(value.functionCall.args)
      && (value.functionCall.id === undefined || typeof value.functionCall.id === "string"));
}
export interface GeminiByokAdapter extends ServiceAdapter, ModelDiscovery {
  testSmoke(request: ServiceRequest, context: ServiceAdapterContext): Promise<ServiceProbeResult>;
}
export interface GeminiByokFactory extends ServiceKindFactory {
  readonly manifest: ServiceKindFactory["manifest"] & { supports: { probe: true; testSmoke: true; cancel: true; stream: true } };
  create(declaration: NativeServiceDeclaration, context: ServiceKindContext): GeminiByokAdapter;
}
function json(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return record(value) && Object.values(value).every(json);
}
function requirement(declaration: NativeServiceDeclaration): ServiceDependencyRequirement {
  return credentialRequirement(declaration, "Gemini");
}

export function createGeminiByokServiceKind(options: { fetch?: typeof globalThis.fetch } = {}): GeminiByokFactory {
  const provider = { id: "gemini-byok", version: "1" };
  return {
    manifest: {
      ...provider, title: "Gemini - Your API Key",
      subjects: ["cell", "chat", "task"], executionModes: ["immediate"],
      supports: { probe: true, cancel: true, stream: true, testSmoke: true },
      operationConstraints: { generate: { queueable: false, retryable: false } },
      configSchema: {
        type: "object", additionalProperties: false, required: ["model", "credentialRef"],
        properties: {
          model: { type: "string", pattern: modelPattern.source },
          credentialRef: { type: "string", minLength: 1 },
        },
      },
    },
    describeDependencies: declaration => [requirement(declaration)],
    validate(declaration, context) {
      const supported = declaration.version === "1" && !!context.resolveCredential && !!context.authorizeEndpoint
        && Object.values(declaration.operations).length > 0
        && Object.values(declaration.operations).every(operation => operation.operation === "generate"
          && operation.contract === "gemini.generate/v1" && operation.mode !== "queued" && !operation.sense
          && !["retry", "correction-prompt"].includes(operation.onViolation?.action ?? ""));
      return supported ? { ok: true } : { ok: false, errors: ["Gemini BYOK requires an immediate generate/gemini.generate/v1 operation, host credentials and endpoint admission without automatic retries."] };
    },
    create(declaration, context) {
      const { model, request: transport } = createByokTransport(declaration, context, {
        ...options, origin: "https://generativelanguage.googleapis.com", label: "Gemini", header: "x-goog-api-key",
      });
      async function generate(request: ServiceRequest, execution: ServiceAdapterContext, diagnostics = false) {
        if (request.operation !== "generate") throw new Error("Unsupported Gemini operation.");
        const input = request.input;
        if (!record(input) || !Array.isArray(input.contents) || !input.contents.length || !json(input)
          || Object.keys(input).some(key => !["contents", "tools"].includes(key))) throw new Error("Supply Gemini contents and optional tools.");
        const body = { ...input, generationConfig: { maxOutputTokens: 8192 },
          ...(input.tools ? { toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}) };
        if (new TextEncoder().encode(JSON.stringify(body)).length > 16 * 1024 * 1024) throw new Error("The Gemini request exceeds its size budget.");
        const stream = await transport(request.service, `/v1beta/models/${model}:streamGenerateContent?alt=sse`, body, execution.signal, diagnostics);
        const parts: GeminiPart[] = [];
        let finishReason = "";
        for (const event of stream.text.replace(/\r\n/g, "\n").split("\n\n")) {
          const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let chunk: unknown;
          try { chunk = JSON.parse(data); } catch { throw new Error("Gemini returned malformed streaming JSON."); }
          if (!record(chunk) || !json(chunk)) throw new Error("Gemini returned invalid response data.");
          if (chunk.error || record(chunk.promptFeedback) && chunk.promptFeedback.blockReason) {
            const detail = stream.describeError(chunk);
            throw new Error(`Gemini rejected or blocked this request.${detail ? ` ${detail}` : ""}`);
          }
          if (!Array.isArray(chunk.candidates) || !chunk.candidates.length) continue;
          if (chunk.candidates.length !== 1 || !record(chunk.candidates[0])) throw new Error("Gemini returned an ambiguous response.");
          const candidate = chunk.candidates[0];
          if (typeof candidate.finishReason === "string") finishReason = candidate.finishReason;
          if (record(candidate.content) && Array.isArray(candidate.content.parts)) {
            for (const part of candidate.content.parts) {
              if (!isGeminiPart(part)) throw new Error("Gemini returned an invalid content part.");
              if (part.functionCall && (!record(part.functionCall) || typeof part.functionCall.name !== "string"
                || !record(part.functionCall.args) || !json(part.functionCall.args)
                || part.functionCall.id !== undefined && typeof part.functionCall.id !== "string"))
                throw new Error("Gemini returned an invalid function call.");
              parts.push(part);
            }
          }
        }
        if (finishReason !== "STOP") throw new Error(`Gemini did not complete the response (${stream.redactDiagnostic(finishReason) || "interrupted stream"}). No tools were executed from this response.`);
        if (!parts.length) throw new Error("Gemini returned an empty response.");
        return { parts, finishReason, redactDiagnostic: stream.redactDiagnostic };
      }
      return {
        provider,
        async listModels(execution) {
          if (!context.identity?.serviceId) throw new Error("Model discovery requires a service identity.");
          const models = new Map<string, ByokModel>(), tokens = new Set<string>();
          let token = "";
          for (let page = 0; page < 20; page++) {
            const raw = await transport(context.identity.serviceId,
              `/v1beta/models?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, undefined, execution.signal);
            let result: unknown;
            try { result = JSON.parse(raw.text); } catch { throw new Error("Gemini returned invalid model discovery JSON."); }
            if (!record(result) || !Array.isArray(result.models)) throw new Error("Gemini returned invalid model discovery data.");
            for (const model of result.models) {
              if (!record(model) || typeof model.name !== "string" || !Array.isArray(model.supportedGenerationMethods))
                throw new Error("Gemini returned invalid model metadata.");
              const id = model.name.replace(/^models\//, "");
              if (modelPattern.test(id) && model.supportedGenerationMethods.includes("generateContent"))
                models.set(id, { id, label: typeof model.displayName === "string" && model.displayName.trim() ? model.displayName : id });
              if (models.size > 999) throw new Error("Gemini model discovery exceeded its model budget.");
            }
            if (result.nextPageToken === undefined || result.nextPageToken === "")
              return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
            if (typeof result.nextPageToken !== "string" || tokens.has(result.nextPageToken))
              throw new Error("Gemini returned an invalid model discovery cursor.");
            token = result.nextPageToken; tokens.add(token);
          }
          throw new Error("Gemini model discovery exceeded its page budget.");
        },
        discover: async () => ({ provider, revision: "1", discoveredAt: new Date().toISOString(),
          capabilities: [{ id: "gemini.generate/v1", operation: "generate", version: "1",
            inputSchema: { type: "object", required: ["contents"], properties: { contents: { type: "array", minItems: 1 }, tools: { type: "array" } }, additionalProperties: false },
            assurance: "declared-and-locally-validated" }] }),
        async probe(execution) {
          const serviceId = context.identity?.serviceId;
          if (!serviceId) throw new Error("The Gemini probe requires a service identity.");
          const raw = await transport(serviceId, `/v1beta/models/${model}`, undefined, execution.signal);
          let metadata: unknown;
          try { metadata = JSON.parse(raw.text); } catch { throw new Error("Gemini returned invalid model metadata."); }
          if (!record(metadata) || metadata.name !== `models/${model}`) throw new Error("Gemini did not confirm the configured model.");
          return { ok: true, detail: { check: "model-access", model } };
        },
        async testSmoke(request, execution) {
          const result = await generate({ ...request, operation: "generate", input: {
            contents: [{ role: "user", parts: [{ text: "Reply with OK. This is a connection test." }] }],
          } }, execution, true);
          const response = result.parts.filter(part => !part.thought).map(part => part.text ?? "").join("");
          if (!response.trim())
            throw new Error("Gemini did not return a smoke-test response.");
          return { ok: true, detail: { check: "model-response", model, response: result.redactDiagnostic(response) } };
        },
        async execute(request, execution) {
          const reply = await generate(request, execution);
          return { output: { parts: reply.parts.map(part => ({ ...part })), finishReason: reply.finishReason } };
        },
      };
    },
  };
}
