/**
 * s9y Agent Organization — 共享类型
 */

/** Agent 间消息体 */
export interface AgentMessage {
  type: "task" | "chat" | "system" | "delivery" | "query";
  content: string;
  metadata?: Record<string, unknown>;
}

/** 项目计划 */
export interface Plan {
  traceId: string;
  title: string;
  description: string;
  directories: string[];
  agents: AgentConfig[];
  milestones: string[];
}

/** 单个 Agent 配置 */
export interface AgentConfig {
  id: string;
  role: string;
  systemPrompt: string;
  workDir: string;
}

/** 工作上下文（传给 worker） */
export interface ProjectContext {
  traceId: string;
  workspace: string;
  plan: Plan;
}
