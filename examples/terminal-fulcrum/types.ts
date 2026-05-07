export type TerminalMessageType =
  | "terminal:create"
  | "terminal:input"
  | "terminal:resize"
  | "terminal:close"
  | "terminal:output"
  | "terminal:created"
  | "terminal:closed"
  | "terminal:list"
  | "terminal:error";

export interface TerminalPayload {
  type: TerminalMessageType;
  sessionId: string;
  data?: string;
  cols?: number;
  rows?: number;
  error?: string;
  sessions?: SessionInfo[];
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface SessionInfo {
  sessionId: string;
  ownerId: string;
  cols: number;
  rows: number;
  createdAt: number;
  shell: string;
  alive: boolean;
}
