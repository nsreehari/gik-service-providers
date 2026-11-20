export interface CredentialStore {
  read(reference: string): Promise<string | undefined>;
  write(reference: string, value: string): Promise<void>;
  remove(reference: string): Promise<void>;
}

export function createMemoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    async read(reference) { return values.get(reference); },
    async write(reference, value) { values.set(reference, value); },
    async remove(reference) { values.delete(reference); },
  };
}

/** The host supplies storage; this module never accesses browser storage. */
export function createCredentialAccess(store: CredentialStore, reference: string) {
  if (!reference.trim()) throw new Error("Supply a credential reference.");
  let generation = 0;
  let available = false;
  let lifetime = new AbortController();
  let mutation = Promise.resolve();
  let blocked = false;
  const listeners = new Set<() => void>();
  let snapshot = { generation, available };
  const changed = () => {
    lifetime.abort();
    lifetime = new AbortController();
    snapshot = { generation: ++generation, available };
    for (const listener of listeners) listener();
  };
  // Serialize host-store writes so a slow save cannot resurrect a cleared key.
  const mutate = (action: () => Promise<void>) => {
    const result = mutation.then(action);
    mutation = result.catch(() => {});
    return result;
  };
  return {
    reference,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async save(value: string) {
      const key = value.trim();
      if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error("Enter a valid API key.");
      available = false;
      blocked = true;
      changed();
      const current = generation;
      await mutate(() => store.write(reference, key));
      if (current === generation) {
        blocked = false;
        available = true;
        snapshot = { generation, available };
        for (const listener of listeners) listener();
      }
    },
    async clear() {
      available = false;
      blocked = true;
      changed();
      await mutate(() => store.remove(reference));
    },
    async resolve() {
      const current = generation;
      const signal = lifetime.signal;
      await mutation;
      if (blocked) throw new Error("Configure the API key for this session.");
      const key = await store.read(reference);
      if (current !== generation) throw new DOMException("Credential access changed.", "AbortError");
      if (!key) throw new Error("Configure the API key for this session.");
      return { key, signal, check() {
        signal.throwIfAborted();
        if (current !== generation) throw new DOMException("Credential access changed.", "AbortError");
      } };
    },
  };
}
