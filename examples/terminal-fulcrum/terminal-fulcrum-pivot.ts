import { BasePivot, type BasePivotOptions } from "../sdk/base-pivot-sdk.ts";
import { SessionManager } from "./session-manager.ts";
import type { TerminalPayload } from "./types.ts";
import type { Message } from "../sdk/type.ts";

export class TerminalFulcrumPivot extends BasePivot {
  private sessionManager: SessionManager;

  constructor(options: BasePivotOptions) {
    options.type = "tool";
    // options.useWebSocket = false;
    if (!Array.isArray(options.capabilities)) options.capabilities = ["terminal", "pty"];
    if (typeof options.headers != 'object') options.headers = { cookie: "s9y-key=tool" };
    super(options);

    this.sessionManager = new SessionManager(
      (sessionId, data, ownerId) => this._sendOutput(sessionId, data, ownerId),
      (sessionId, exitCode, ownerId) => this._sendClosed(sessionId, exitCode, ownerId),
    );
  }

  async onTask(message: Message): Promise<unknown> {
    const data = message.payload?.data as TerminalPayload | undefined;
    if (!data?.type || !data.sessionId) return;

    const senderId = message.senderId;
    const { sessionId, type } = data;

    switch (type) {
      case "terminal:create": {
        const cols = data.cols ?? 80;
        const rows = data.rows ?? 24;
        try {
          this.sessionManager.create(sessionId, senderId, cols, rows, data.cwd);
          return { type: "terminal:created", sessionId };
        } catch (err) {
          return {
            type: "terminal:error",
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      case "terminal:input": {
        this.sessionManager.write(sessionId, data.data ?? "");
        return;
      }

      case "terminal:resize": {
        this.sessionManager.resize(sessionId, data.cols ?? 80, data.rows ?? 24);
        return;
      }

      case "terminal:close": {
        this.sessionManager.close(sessionId);
        return { type: "terminal:closed", sessionId };
      }

      case "terminal:list": {
        return { type: "terminal:list", sessions: this.sessionManager.list() };
      }

      default:
        return;
    }
  }

  dispose(): void {
    this.sessionManager.dispose();
    this.disconnect();
  }

  private _sendOutput(sessionId: string, data: string, ownerId: string): void {
    this.push({
      senderId: this.options.pivotId,
      targetId: ownerId,
      type: "push",
      payload: {
        data: { type: "terminal:output", sessionId, data } as TerminalPayload,
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    }).catch(() => { });
  }

  private _sendClosed(sessionId: string, exitCode: number, ownerId: string): void {
    this.push({
      senderId: this.options.pivotId,
      targetId: ownerId,
      type: "push",
      payload: {
        data: {
          type: "terminal:closed",
          sessionId,
          error: `Process exited with code ${exitCode}`,
        } as TerminalPayload,
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    }).catch(() => { });
  }
}
