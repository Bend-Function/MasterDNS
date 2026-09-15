import type { User } from "./types";

export type SessionSnapshot = { user: User | null; checking: boolean };

export function createSessionManager(initialUser: User | null, initialChecking: boolean) {
  let snapshot: SessionSnapshot = { user: initialUser, checking: initialChecking };
  let revision = 0;
  const listeners = new Set<() => void>();
  const update = (next: SessionSnapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async refresh(request: () => Promise<User>) {
      const requestRevision = ++revision;
      update({ ...snapshot, checking: true });
      try {
        const user = await request();
        if (revision === requestRevision) update({ user, checking: false });
      } catch {
        if (revision === requestRevision) update({ user: null, checking: false });
      }
    },
    setUser(user: User) { revision += 1; update({ user, checking: false }); },
    clear() { revision += 1; update({ user: null, checking: false }); },
  };
}

export function createRequestGeneration() {
  let generation = 0;
  return {
    current: () => generation,
    invalidate: () => { generation += 1; return generation; },
    isCurrent: (value: number) => value === generation,
  };
}
