export interface ByokModel { id: string; label: string }
export interface ModelDiscovery {
  listModels(context: { signal?: AbortSignal }): Promise<ByokModel[]>;
}
