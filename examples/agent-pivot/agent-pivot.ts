import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BasePerson, WAIT_FOR_EVENT, type ToolDef } from "./base-person.ts";
import type { Message } from "../sdk/type.ts";
import type { AgentState, AgentMessage } from "./types.ts";
import type { TerminalPayload } from "../terminal-fulcrum/types.ts";
import { ScreenBuffer } from "./screen-buffer.ts";
import { buildDetectors, ScreenStabilityDetector, type OutputDetector } from "./detectors.ts";

export interface AgentPivotOptions {
  gatewayUrl: string;
  pivotId: string;
  name: string;
  terminalPivotId: string;
  workspaceRoot: string;
  idleTimeoutMs?: number;
}

export class AgentPivot extends BasePerson {
  state: AgentState = "idle";
  private terminalPivotId: string;
  private workspaceRoot: string;
  private projectDir: string | null = null;
  private sessionId: string | null = null;
  private currentUserId: string | null = null;
  private screen: ScreenBuffer | null = null;
  private detectors: OutputDetector[];
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  // 稳定性轮询：每秒 tick 一次，屏幕持续 N 秒不变则唤醒 LLM
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _stabilityDetector: ScreenStabilityDetector | null = null;

  constructor(options: AgentPivotOptions) {
    super({
      gatewayUrl: options.gatewayUrl,
      pivotId: options.pivotId,
      name: options.name,
      workspace: options.workspaceRoot,
      systemPrompt: buildSystemPrompt(options.workspaceRoot),
    });

    this.terminalPivotId = options.terminalPivotId;
    this.workspaceRoot = options.workspaceRoot;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;

    this.detectors = buildDetectors();
    this.setTools(this._buildTools());
  }

  async connect(): Promise<void> {
    await super.connect();
    if (!this.terminalPivotId) {
      await this._discoverTerminalPivot();
    }
  }

  private async _discoverTerminalPivot(): Promise<void> {
    const httpUrl = this.options.gatewayUrl.replace(/^ws/, "http");
    const pivotsUrl = httpUrl + (httpUrl.endsWith("/") ? "" : "/") + "pivots";

    for (let i = 0; i < 15; i++) {
      try {
        const res = await fetch(pivotsUrl, {
          headers: { cookie: "s9y-key=agent" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { pivots?: Array<{ pivotId: string; capabilities?: string[] }> };
        const terminal = (data.pivots ?? []).find((p) =>
          (p.capabilities ?? []).some((c) => c === "terminal" || c === "pty")
        );
        if (terminal) {
          this.terminalPivotId = terminal.pivotId;
          console.log(`[${this.options.name}] 自动发现终端支点: ${terminal.pivotId}`);
          return;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("未找到终端支点，请确保 terminal-fulcrum 已启动并设置了 TERMINAL_PIVOT_ID");
  }

  // ─── 消息入口 ───

  protected get logDir(): string {
    const base = this.projectDir ?? this.workspaceRoot;
    const dir = resolve(base, "logs");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async onTask(message: Message): Promise<unknown> {
    const data = message.payload?.data as TerminalPayload | AgentMessage | undefined;
    if (!data) return;

    // 终端消息 → 缓冲 + 检测
    if (isTerminalPayload(data)) {
      this._handleTerminalMessage(data);
      return;
    }

    // 用户消息
    const content = (data as AgentMessage).content;
    if (!content) return;

    this.currentUserId = message.senderId;
    this._logChat("user", message.senderId, content);

    if (this.state === "idle" || this.state === "delivered") {
      if (this.state === "delivered") this.resetHistory();
      this.state = "evaluating";
    }

    if (this.isWaiting) {
      return this.resumeThinking(`[用户消息] ${content}`);
    }

    return super.onTask(message);
  }

  // ─── 终端消息处理 ───

  private async _handleTerminalMessage(data: TerminalPayload): Promise<void> {
    if (data.type === "terminal:output" && data.data) {
      console.log(`[${this.options.name}] 终端输出 arrived len=${data.data.length}`);
      // 喂给虚拟屏幕渲染（处理 ANSI 动画、光标移动等）
      if (this.screen) await this.screen.write(data.data);
      this._resetIdleTimer();
      this._runDetectors();
    }

    if (data.type === "terminal:closed") {
      this.screen?.dispose();
      this.screen = null;
      this.sessionId = null;
      this._clearIdleTimer();
      if (this.isWaiting) {
        this.resumeThinking("[系统事件] 终端会话已关闭");
      }
    }
  }

  // ─── 正则检测器执行（终端输出到达时立即运行） ───

  private _runDetectors(): void {
    if (!this.isWaiting || this.state === "idle" || !this.screen) return;

    const buffer = this.screen.getText();
    if (!buffer) return;

    for (const detector of this.detectors) {
      const result = detector.detect(buffer);
      if (result) {
        console.log(`[${this.options.name}] 检测器 [${detector.name}] 命中: ${result.slice(0, 80)}`);
        this.resumeThinking(`[终端检测:${detector.name}] ${result}`);
        return;
      }
    }

    const tail = this.screen.getTail(5);
    console.log(`[${this.options.name}] 检测器未匹配，屏幕尾部(5行): ${JSON.stringify(tail)}`);
  }

  // ─── 稳定性轮询（每秒 tick，屏幕持续 N 秒不变则唤醒 LLM） ───

  private _startPolling(): void {
    if (this._pollTimer) return;
    this._stabilityDetector = new ScreenStabilityDetector({ stableDurationMs: 10_000 });
    this._pollTimer = setInterval(() => this._pollTick(), 1000);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._stabilityDetector = null;
  }

  private _pollTick(): void {
    if (!this.isWaiting || !this.screen || !this._stabilityDetector) return;
    const result = this._stabilityDetector.tick(this.screen);
    if (result) {
      console.log(`[${this.options.name}] 稳定性检测触发`);
      this.resumeThinking(result);
    }
  }

  protected _onWaitEnter(): void {
    this._resetIdleTimer();
    this._runDetectors();
  }

  private _resetIdleTimer(): void {
    this._clearIdleTimer();
    if (this.state !== "coding") return;

    this.idleTimer = setTimeout(() => {
      if (!this.isWaiting) return;
      const screenText = this.screen?.getTail(40) ?? "";
      console.log(`[${this.options.name}] 空闲超时触发 (${this.idleTimeoutMs}ms)`);
      this.resumeThinking(
        `[终端检测:idle_timeout] 终端已 ${Math.round(this.idleTimeoutMs / 1000)} 秒无新输出。` +
        (screenText ? `\n当前屏幕尾部:\n${screenText}` : "")
      );
    }, this.idleTimeoutMs);
  }

  private _clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ─── 工具定义 ───

  private _buildTools(): Record<string, ToolDef> {
    return {
      ask_user: {
        definition: {
          name: "ask_user",
          description: "向用户发送消息（反问、确认、进度通知、交付结果等）。用户会在 IM 聊天界面看到这条消息。",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "发送给用户的消息内容" },
            },
            required: ["message"],
          },
        },
        execute: async (args) => {
          const msg = args.message as string;
          if (!this.currentUserId) return "错误: 没有活跃的用户会话";
          await this.sendTo(this.currentUserId, { type: "chat", content: msg });
          this._logChat("agent", this.options.pivotId, msg);
          return "已发送给用户";
        },
      },

      init_project: {
        definition: {
          name: "init_project",
          description: [
            "为当前任务初始化项目目录。目录名格式为「日期-标题」。",
            "调用后会在 workspace 下创建对应文件夹，后续 create_terminal 会自动在此目录下启动终端。",
            "标题由你根据用户需求总结，最长 20 个字。",
          ].join("\n"),
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "项目标题，对用户需求的简短总结（最长 20 个字）" },
            },
            required: ["title"],
          },
        },
        execute: async (args) => {
          const title = (args.title as string).slice(0, 20);
          const datePrefix = new Date().toLocaleString("zh")
            .replaceAll("/", "").replaceAll(":", "").replaceAll(" ", "-");
          const dirName = `${datePrefix}-${title}`;
          const fullPath = resolve(this.workspaceRoot, dirName);

          try {
            mkdirSync(fullPath, { recursive: true });
            this.projectDir = fullPath;
            this._logTerminal("init_project", fullPath);
            return `项目目录已创建: ${fullPath}`;
          } catch (err) {
            return `创建项目目录失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },

      create_terminal: {
        definition: {
          name: "create_terminal",
          description: "在终端支点上创建一个新的 PTY 终端会话。终端默认启动在项目目录下（如已通过 init_project 初始化）。创建后可以通过 send_command 发送命令。",
          parameters: {
            type: "object",
            properties: {},
          },
        },
        execute: async () => {
          if (this.sessionId) return `终端已存在，sessionId=${this.sessionId}`;

          const sessionId = `pty-${crypto.randomUUID().slice(0, 8)}`;
          const payload: TerminalPayload = {
            type: "terminal:create",
            sessionId,
            cols: 200,
            rows: 50,
            cwd: this.projectDir ?? this.workspaceRoot,
          };

          try {
            await this.push({
              senderId: this.options.pivotId,
              targetId: this.terminalPivotId,
              type: "push",
              payload: { data: payload },
              traceId: crypto.randomUUID(),
              timestamp: Date.now(),
            });
            this.sessionId = sessionId;
            this.screen = new ScreenBuffer(200, 50);
            this._startPolling();
            this.state = "coding";
            this._logTerminal("create", sessionId);
            return `终端已创建，sessionId=${sessionId}`;
          } catch (err) {
            return `创建终端失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },

      send_command: {
        definition: {
          name: "send_command",
          description: [
            "向终端发送命令或文本输入。发送后立即返回，终端输出会通过事件系统异步通知你。",
            "用途：启动 claude CLI、向 claude 发送任务描述、回答权限询问(y/n)、输入其他交互内容等。",
          ].join("\n"),
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "要发送到终端的命令或文本" },
            },
            required: ["command"],
          },
        },
        execute: async (args) => {
          if (!this.sessionId) return "错误: 没有活跃的终端会话，请先调用 create_terminal";

          let command = args.command as string;
          // 将字面量 \n 文本转为实际换行（防止 LLM 发送文本 "\n" 而非换行符）
          command = command.replace(/\\n/g, "\r");
          // 将所有换行转为 \r（PTY 中回车键发送的是 CR 而非 LF）
          command = command.replace(/\n/g, "\r");
          // 确保末尾有回车
          if (!command.endsWith("\r")) command += "\r";

          const payload: TerminalPayload = {
            type: "terminal:input",
            sessionId: this.sessionId,
            data: command,
          };

          this._logTerminal("input", command);

          try {
            await this.push({
              senderId: this.options.pivotId,
              targetId: this.terminalPivotId,
              type: "push",
              payload: { data: payload },
              traceId: crypto.randomUUID(),
              timestamp: Date.now(),
            });
          } catch (err) {
            return `发送命令失败: ${err instanceof Error ? err.message : String(err)}`;
          }

          this._resetIdleTimer();
          return WAIT_FOR_EVENT;
        },
      },

      close_terminal: {
        definition: {
          name: "close_terminal",
          description: "关闭当前终端会话。在任务完成或需要重新开始时使用。",
          parameters: {
            type: "object",
            properties: {},
          },
        },
        execute: async () => {
          if (!this.sessionId) return "没有活跃的终端会话";

          const payload: TerminalPayload = {
            type: "terminal:close",
            sessionId: this.sessionId,
          };

          this._logTerminal("close", this.sessionId);
          this._clearIdleTimer();

          try {
            await this.push({
              senderId: this.options.pivotId,
              targetId: this.terminalPivotId,
              type: "push",
              payload: { data: payload },
              traceId: crypto.randomUUID(),
              timestamp: Date.now(),
            });
            this.sessionId = null;
            this.screen?.dispose();
            this.screen = null;
            this._stopPolling();
            this.state = "idle";
            return "终端已关闭";
          } catch (err) {
            return `关闭终端失败: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },

      set_state: {
        definition: {
          name: "set_state",
          description: "更新当前工作状态。状态包括: evaluating(评估需求), coding(编码中), reviewing(审查结果), delivered(已交付)",
          parameters: {
            type: "object",
            properties: {
              state: {
                type: "string",
                enum: ["evaluating", "coding", "reviewing", "delivered"],
                description: "新的状态",
              },
            },
            required: ["state"],
          },
        },
        execute: async (args) => {
          const newState = args.state as AgentState;
          const oldState = this.state;
          this.state = newState;
          if (newState === "delivered") {
            this._clearIdleTimer();
            this._stopPolling();
            this.screen?.dispose();
            this.screen = null;
          }
          if (newState === "idle" || newState === "delivered") {
            this.currentUserId = null;
          }
          return `状态已从 ${oldState} 更新为 ${newState}`;
        },
      },
    };
  }

  // ─── 日志 ───

  private _logChat(role: "user" | "agent", senderId: string, content: string): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), role, senderId, content }) + "\n";
      appendFileSync(resolve(this.logDir, "agent-pivot-chat.jsonl"), line, "utf-8");
    } catch { /* 静默 */ }
  }

  private _logTerminal(action: string, data: string): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), action, data: data.slice(0, 2000) }) + "\n";
      appendFileSync(resolve(this.logDir, "agent-pivot-terminal.jsonl"), line, "utf-8");
    } catch { /* 静默 */ }
  }
}

// ─── 辅助 ───

function isTerminalPayload(data: unknown): data is TerminalPayload {
  return typeof data === "object" && data !== null && "type" in data &&
    typeof (data as any).type === "string" && (data as any).type.startsWith("terminal:");
}

function buildSystemPrompt(workspaceRoot: string): string {
  return `你是一个专业的程序员 Agent，你的名字叫 agent-pivot。
你通过操作终端里的 Claude Code CLI 来完成编程任务。

## 核心机制

你工作在**事件驱动模式**下：
- 当你调用 send_command 后，系统会自动暂停，等待终端响应
- 终端有输出时，系统会通过事件通知你，告诉你检测到了什么
- 你不需要主动轮询或等待，只需根据事件做出反应

事件类型：
- [终端检测:permission] — Claude 请求权限，你需要决定是否授权
- [终端检测:error] — 检测到异常（额度不足、命令错误等），你需要处理
- [终端检测:completion] — 可能已完成，你需要判断并决定下一步
- [终端检测:smart_poll] — 终端屏幕持续 10 秒无变化，你需根据屏幕内容判断当前状态（权限询问/已完成/出错/工作中）
- [终端检测:idle_timeout] — 终端长时间无输出，你需要判断是否卡住
- [用户消息] — 用户发来新消息

## 你的职责

1. **需求评估**：收到用户的编程任务后，先分析需求，评估可行性。如果需求不明确或有疑问，通过 ask_user 工具向用户提问。
2. **项目初始化**：评估通过后，为项目取一个简短标题（20字以内），调用 init_project 创建项目目录。目录名格式为\`日期-标题\`。
3. **启动 Claude**：创建终端（会自动在项目目录下启动），启动 claude CLI 进行编码。
4. **监督执行**：根据事件通知处理权限请求、异常、完成等情况。
5. **交付结果**：完成后告知用户项目存放路径和完成内容。

## 工作流程

### 第一步：评估需求
- 调用 set_state 设置状态为 evaluating
- 分析用户需求，确认你理解了要做什么
- 如果有不清楚的地方，用 ask_user 向用户提问并等待回复
- 为项目取一个简短标题（20字以内）

### 第二步：初始化项目
- 调用 set_state 设置状态为 coding
- 调用 init_project，传入总结好的标题
- 系统会自动创建 \`${workspaceRoot}/日期-标题/\` 目录

### 第三步：创建终端并启动 Claude
- 调用 create_terminal 创建终端（终端会自动在项目目录下启动，无需 cd）
- 进入项目目录：send_command("pwd\\n") 确认当前位置
- 启动 Claude CLI：send_command("claude\\n")
- 等待事件通知 Claude 启动完成
- 向 Claude 发送任务描述

### 第四步：响应事件
- 收到 [终端检测:permission] → 根据安全规则授权(y)或拒绝(n)
- 收到 [终端检测:error] → 分析错误，尝试纠正或通知用户
- 收到 [终端检测:idle_timeout] → 判断是否卡住，尝试输入或检查状态
- 收到 [终端检测:completion] → 进入第五步

### 第五步：交付
- 调用 set_state 设置状态为 reviewing
- 确认 Claude 已完成任务
- 调用 ask_user 告知用户：任务完成情况、项目路径、主要产出文件
- 调用 close_terminal 关闭终端
- 调用 set_state 设置状态为 delivered

## 安全规则

- Claude 只能在当前项目目录下操作
- 允许 Claude 读写文件、运行测试
- 禁止 Claude 执行危险命令（rm -rf /、格式化磁盘等）
- 如果 Claude 尝试操作工作区外的文件，拒绝并纠正

## 注意事项

- 你是一个"人"，不是简单的消息桥。要主动思考和判断，而不是把所有信息都转发给用户。
- 技术问题尽量自己解决，只在确实无法判断时才问用户。
- 发送到终端的命令末尾需要加换行符来模拟回车键。
- 每次收到事件后仔细阅读内容，判断 Claude 的状态和需求。
- 不要急于行动，先理解事件内容再决定下一步。`;
}