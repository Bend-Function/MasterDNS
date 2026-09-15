import { describe, expect, it } from "vitest";
import type { User } from "./types";
import { createRequestGeneration, createSessionManager } from "./session-state";

const user = (id: string, role: User["role"] = "user"): User => ({ id, username: id, email: null, role, status: "active" });

describe("session lifecycle", () => {
  it("moves from an unauthenticated check through login to the protected session without a stale check overwriting it", async () => {
    let resolveInitial: (value: User) => void = () => undefined;
    const initial = new Promise<User>((resolve) => { resolveInitial = resolve; });
    const session = createSessionManager(null, true);
    const refresh = session.refresh(() => initial);

    session.setUser(user("admin", "admin"));
    resolveInitial(user("stale-user"));
    await refresh;

    expect(session.getSnapshot()).toEqual({ user: user("admin", "admin"), checking: false });
  });

  it("clears logout state before accepting a different user's login", () => {
    const session = createSessionManager(user("admin", "admin"), false);

    session.clear();
    expect(session.getSnapshot()).toEqual({ user: null, checking: false });
    session.setUser(user("operator"));

    expect(session.getSnapshot().user).toEqual(user("operator"));
  });
});

describe("request generation", () => {
  it("invalidates address responses that started before inventory refresh", () => {
    const generation = createRequestGeneration();
    const oldRequest = generation.current();

    generation.invalidate();

    expect(generation.isCurrent(oldRequest)).toBe(false);
    expect(generation.isCurrent(generation.current())).toBe(true);
  });
});
