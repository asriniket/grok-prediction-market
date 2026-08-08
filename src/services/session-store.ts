import { randomBytes } from "node:crypto";

interface Session {
  userId: string;
  expiresAt: number;
}

/** Local-only session registry for the hackathon demo. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(userId: string): string {
    this.prune();
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { userId, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    return id;
  }

  getUserId(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session.userId;
  }

  private prune(): void {
    const current = Date.now();
    for (const [id, session] of this.sessions) if (session.expiresAt < current) this.sessions.delete(id);
  }
}
