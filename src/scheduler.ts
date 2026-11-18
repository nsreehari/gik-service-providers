import { Cron } from "croner";
import { serviceConfig } from "gik-controlface/services";
import { object, text, keys } from "./values";
import type { DiagnosticServiceKindFactory } from "./diagnostics";
export type { DiagnosticServiceAdapter, DiagnosticServiceKindFactory } from "./diagnostics";

export function createSchedulerServiceKind(): DiagnosticServiceKindFactory {
  return {
    manifest: {
      id: "cron-scheduler", version: "1", title: "Process-local cron",
      configSchema: {
        type: "object", additionalProperties: false, required: ["expression", "timezone"],
        properties: { expression: { type: "string", minLength: 1 }, timezone: { type: "string", minLength: 1 } },
      },
      subjects: ["cell", "substrate-agent", "chat", "task"],
      executionModes: ["immediate"], supports: { observe: true, probe: true, testSmoke: true },
    },
    validate(declaration) {
      try {
        if (declaration.version !== "1") throw new Error("cron-scheduler supports version 1 only");
        if (!Object.keys(declaration.operations).length) throw new Error("Scheduler requires a declared timer operation");
        for (const operation of Object.values(declaration.operations)) {
          if (operation.operation !== "tick" || operation.contract !== "scheduler.cron/v1"
            || operation.mode === "queued" || operation.sense?.kind !== "timer" || !operation.sense.signals.due) {
            throw new Error("Scheduler requires tick/scheduler.cron/v1, immediate timer Sense, and a due signal");
          }
        }
        const config = serviceConfig(declaration);
        const job = new Cron(text(config.expression, "expression"), {
          timezone: text(config.timezone, "timezone"), paused: true,
        });
        try {
          if (!job.nextRun()) throw new Error("Cron expression has no future occurrence");
        } finally { job.stop(); }
        return { ok: true };
      } catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
    },
    create(declaration) {
      const config = serviceConfig(declaration);
      const expression = text(config.expression, "expression");
      const timezone = text(config.timezone, "timezone");
      const provider = { id: "cron-scheduler", version: "1" };
      function nextOccurrence() {
        const job = new Cron(expression, { timezone, paused: true });
        try {
          const nextRun = job.nextRun();
          if (!nextRun) throw new Error("Cron expression has no future occurrence");
          return nextRun.toISOString();
        } finally { job.stop(); }
      }
      return {
        provider,
        discover: async () => ({
          provider, revision: "1", discoveredAt: new Date().toISOString(),
          capabilities: [{
            id: "scheduler.cron/v1", operation: "tick", name: "Cron tick", version: "1",
            inputSchema: { type: "object", additionalProperties: false },
            assurance: "declared-and-locally-validated",
          }],
        }),
        probe(context) {
          context.signal?.throwIfAborted();
          return { ok: true, detail: { check: "schedule", nextRun: nextOccurrence(), timezone } };
        },
        async testSmoke(request, context) {
          keys(object(request.input ?? {}, "scheduler smoke input"), []);
          if (request.operation !== "tick") throw new Error("Unsupported scheduler smoke test");
          context.signal?.throwIfAborted();
          const nextRun = nextOccurrence();
          // A separate one-shot job verifies the timer without firing the application's Sense.
          const firedAt = await new Promise<string>((resolve, reject) => {
            const job = new Cron(new Date(Date.now() + 1000), { timezone, paused: true }, () => {
              cleanup();
              resolve(new Date().toISOString());
            });
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error("Scheduler smoke timer did not fire within 5 seconds"));
            }, 5000);
            const abort = () => {
              cleanup();
              reject(context.signal?.reason ?? new Error("Scheduler smoke test aborted"));
            };
            const cleanup = () => {
              job.stop();
              clearTimeout(timeout);
              context.signal?.removeEventListener("abort", abort);
            };
            context.signal?.addEventListener("abort", abort, { once: true });
            if (context.signal?.aborted) abort();
            else job.resume();
          });
          context.signal?.throwIfAborted();
          return { ok: true, detail: { check: "one-shot-timer", firedAt, timezone, nextRun } };
        },
        execute() { throw new Error("Cron is an observation, not a bounded invocation"); },
        async observe(request, context) {
          keys(object(request.input ?? {}, "scheduler input"), []);
          if (request.operation !== "tick" || context.kind !== "timer") throw new Error("Unsupported scheduler observation");
          if (context.signal?.aborted) throw new Error("Scheduler binding is already aborted");
          let pending = Promise.resolve();
          let stopped = false;
          const job = new Cron(expression, {
            timezone, protect: true,
            catch: (error) => { stop(); context.onError(error); },
          }, () => {
            pending = (async () => {
              if (stopped || context.signal?.aborted) return;
              const firedAt = new Date().toISOString();
              await context.emit({
                id: `${request.id}:${firedAt}`, name: "due", payload: { firedAt, expression, timezone },
              });
            })();
            return pending;
          });
          function stop() {
            stopped = true;
            job.stop();
            context.signal?.removeEventListener("abort", abort);
          }
          const abort = () => { stop(); };
          context.signal?.addEventListener("abort", abort, { once: true });
          return { async close() { stop(); await pending; } };
        },
      };
    },
  };
}
