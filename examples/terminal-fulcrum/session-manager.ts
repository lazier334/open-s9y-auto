import { TerminalSession } from "./terminal-session.ts";
import type { TerminalSessionCallbacks } from "./terminal-session.ts";
import type { SessionInfo } from "./types.ts";

export class SessionManager {
  private sessions = new Map<string, TerminalSession>();
  private maxSessions: number;
  private onOutput: (sessionId: string, data: string, ownerId: string) => void;
  private onExit: (sessionId: string, exitCode: number, ownerId: string) => void;

  constructor(
    onOutput: (sessionId: string, data: string, ownerId: string) => void,
    onExit: (sessionId: string, exitCode: number, ownerId: string) => void,
    maxSessions?: number,
  ) {
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.maxSessions = maxSessions ?? 20;
  }

  create(sessionId: string, ownerId: string, cols: number, rows: number): TerminalSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Max sessions reached (${this.maxSessions})`);
    }
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const callbacks: TerminalSessionCallbacks = {
      onData: (data: string) => this.onOutput(sessionId, data, ownerId),
      onExit: (exitCode: number) => {
        this.onExit(sessionId, exitCode, ownerId);
        setTimeout(() => {
          this.sessions.delete(sessionId);
        }, 5000);
      },
    };

    const session = new TerminalSession(sessionId, ownerId, callbacks, { cols, rows });
    this.sessions.set(sessionId, session);
    return session;
  }

  write(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.resize(cols, rows);
    return true;
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.kill();
    this.sessions.delete(sessionId);
    return true;
  }

  get(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info());
  }

  dispose(): void {
    for (const [id, session] of this.sessions) {
      try {
        session.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}
