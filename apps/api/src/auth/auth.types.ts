export type AuthUser = {
  id: string;
  username: string;
  email: string | null;
  role: "admin" | "user";
  sessionId: string;
};
