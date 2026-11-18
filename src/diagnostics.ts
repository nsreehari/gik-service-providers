import type {
  ServiceAdapter, ServiceAdapterContext, ServiceKindContext, ServiceKindFactory,
  ServiceKindManifest, ServiceProbeResult, ServiceRequest,
} from "gik-controlface/services";
import type { NativeServiceDeclaration } from "gik-kernel";

/** Structural extension usable with published ControlFace versions predating testSmoke. */
export interface DiagnosticServiceAdapter extends ServiceAdapter {
  probe(context: ServiceAdapterContext & { serviceId?: string }): ServiceProbeResult | Promise<ServiceProbeResult>;
  testSmoke(request: ServiceRequest, context: ServiceAdapterContext): ServiceProbeResult | Promise<ServiceProbeResult>;
}

export interface DiagnosticServiceKindFactory extends ServiceKindFactory {
  readonly manifest: ServiceKindManifest & { supports: { probe: true; testSmoke: true; observe?: boolean } };
  create(declaration: NativeServiceDeclaration, context: ServiceKindContext): DiagnosticServiceAdapter;
}
