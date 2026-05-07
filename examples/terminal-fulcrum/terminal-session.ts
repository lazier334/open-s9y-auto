import { createRequire } from "node:module";
import type { IPty } from "@lydell/node-pty";
import type { TerminalSize, SessionInfo } from "./types.ts";

const require = createRequire(import.meta.url);
const { spawn } = require("@lydell/node-pty") as typeof import("@lydell/node-pty");

export interface TerminalSessionCallbacks {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

export class TerminalSession {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly createdAt: number;
  private pty: IPty;
  private callbacks: TerminalSessionCallbacks;
  private cols: number;
  private rows: number;
  private shell: string;
  private outputBuffer = "";
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL = 16;

  constructor(
    sessionId: string,
    ownerId: string,
    callbacks: TerminalSessionCallbacks,
    size: TerminalSize,
    shell?: string,
  ) {
    this.sessionId = sessionId;
    this.ownerId = ownerId;
    this.createdAt = Date.now();
    this.callbacks = callbacks;
    this.cols = size.cols;
    this.rows = size.rows;
    this.shell = shell ?? TerminalSession.defaultShell();
    this.pty = this._spawn(this.shell, size.cols, size.rows);

    this.pty.onData((data: string) => {
      this.outputBuffer += data;
      if (!this.outputTimer) {
        this.outputTimer = setTimeout(() => {
          const chunk = this.outputBuffer;
          this.outputBuffer = "";
          this.outputTimer = null;
          this.callbacks.onData(chunk);
        }, TerminalSession.FLUSH_INTERVAL);
      }
    });

    this.pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (this.outputTimer) {
        clearTimeout(this.outputTimer);
        if (this.outputBuffer) {
          this.callbacks.onData(this.outputBuffer);
          this.outputBuffer = "";
        }
        this.outputTimer = null;
      }
      this.callbacks.onExit(exitCode);
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  kill(): void {
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
    try {
      this.pty.kill();
    } catch {
      // process already dead
    }
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      ownerId: this.ownerId,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      shell: this.shell,
      alive: this._isAlive(),
    };
  }

  private _spawn(shellPath: string, cols: number, rows: number): IPty {
    return spawn(shellPath, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    });
  }

  private _isAlive(): boolean {
    try {
      // node-pty doesn't expose pid directly; use a heuristic
      return this.pty.pid > 0;
    } catch {
      return false;
    }
  }

  static defaultShell(): string {
    if (process.platform === "win32") return "powershell.exe";
    return process.env.SHELL ?? "/bin/bash";
  }
}
