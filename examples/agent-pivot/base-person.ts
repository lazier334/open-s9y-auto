/**
 * BasePerson — 极简 Agent 基类（ReAct + 事件驱动混合模式）
 *
 * "会思考的人"：
 *   收到消息 → OpenAI function calling (ReAct 循环) → 工具调用 → 最终回复
 *
 * 事件驱动扩展：
 *   工具返回 __WAIT_FOR_EVENT__ → ReAct 暂停 → 外部事件到来 → resumeThinking() 恢复
 *
 * 只依赖 openai 原生 SDK，不做任何抽象。
 */

import OpenAI from "openai";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";
import type { AgentMessage } from "./types.ts";

// ─── 常量 ───

export const WAIT_FOR_EVENT = "__WAIT_FOR_EVENT__";

// ─── OpenAI 客户端 ───

const client = new OpenAI({
  apiKey: process.env.API_KEY ?? "",
  baseURL: process.env.BASE_URL ?? "https://api.deepseek.com/v1",
});

const defaultModel = process.env.MODEL ?? "deepseek-chat";

function sliceLog(num: number = 100, msg: string) {
  if (num < msg?.length) msg = msg.slice(0, num) + '...\n';
  return console.log(msg);
}

// ─── 类型 ───

export interface ToolDef {
  definition: OpenAI.Chat.Completions.ChatCompletionFunctionTool["function"];
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface PersonOptions {
  gatewayUrl: string;
  pivotId: string;
  name: string;
  systemPrompt: string;
  tools?: Record<string, ToolDef>;
  temperature?: number;
  workspace?: string;
}

// ─── BasePerson ───

export class BasePerson extends BasePivot {
  private systemPrompt: string;
  private tools: Record<string, ToolDef>;
  private temperature: number;
  protected history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  workspace: string;
  broadcastId?: string;
  workDir?: string;

  private _waiting = false;
  private _thinkingPromise: Promise<string> | null = null;
  private _resumeResolve: ((value: string) => void) | null = null;

  constructor(options: PersonOptions) {
    super({
      gatewayUrl: options.gatewayUrl,
      pivotId: options.pivotId,
      type: "agent",
      headers: { cookie: 's9y-key=agent' },
      name: options.name,
      capabilities: [options.name],
      useWebSocket: true,
    });
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? {};
    this.temperature = options.temperature ?? 0.4;
    this.workspace = options.workspace ?? ".";
  }

  get isWaiting(): boolean {
    return this._waiting;
  }

  /** 子类可重写：进入事件等待模式时的回调 */
  protected _onWaitEnter(): void {}

  // ─── 对外接口 ───

  async onTask(message: Message): Promise<unknown> {
    const data = message.payload?.data as AgentMessage | undefined;
    if (!data?.content) return;

    const speaker = message.senderId;

    if (speaker.startsWith("broadcast-")) {
      const text = data.content ?? "";
      const myId = this.options.pivotId;
      const myName = this.options.name;
      if (!text.includes(myId) && !text.includes(myName)) return;
    }

    const text = `[${speaker}]: ${data.content}`;
    sliceLog(120, `[${this.options.name}] 收到消息: ${text}`);

    if (this._waiting) {
      return this.resumeThinking(text);
    }

    this.history.push({ role: "user", content: text });
    return this._think();
  }

  async thinkAbout(content: string): Promise<string> {
    if (this._waiting) {
      return this.resumeThinking(content);
    }
    this.history.push({ role: "user", content });
    return this._think();
  }

  async resumeThinking(eventContext: string): Promise<string> {
    this._waiting = false;
    this.history.push({ role: "user", content: eventContext });
    console.log(`[${this.options.name}] 事件唤醒: ${eventContext.slice(0, 80)}...`);
    return this._think();
  }

  // ─── ReAct 循环（支持暂停/恢复） ───

  private async _think(): Promise<string> {
    if (this.history.length > 40) {
      this.history = this.history.slice(-40);
    }

    let finalReply = "";
    let step = 0;
    const maxSteps = parseInt(process.env.MAX_TURNS ?? "100", 10);

    while (true) {
      if (step >= maxSteps) {
        console.error(`[${this.options.name}] 达到安全上限 ${maxSteps} 步，强制终止`);
        finalReply = finalReply || "(达到步数上限)";
        break;
      }
      step++;

      console.log(`[${this.options.name}] 思考中... (step ${step})`);

      try {
        const reqMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: this.systemPrompt },
          ...this.history,
        ];
        this._logLLM(reqMessages);

        const response = await client.chat.completions.create({
          model: defaultModel,
          temperature: this.temperature,
          messages: reqMessages,
          tools: Object.entries(this.tools).map(([name, t]) => ({
            type: "function" as const,
            function: { name, description: t.definition.description ?? "", parameters: t.definition.parameters ?? {} },
          })),
        });

        const choice = response.choices[0];
        if (!choice) throw new Error("LLM 返回为空");

        const msg = choice.message;
        const reasoning = (msg as any).reasoning_content as string | undefined;

        if (msg.tool_calls?.length) {
          finalReply = msg.content ?? "";

          type FnToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;
          const fns: Array<{ id: string; name: string; args: string }> = [];
          for (const tc of msg.tool_calls) {
            const fn = (tc as FnToolCall).function;
            if (fn) fns.push({ id: tc.id, name: fn.name, args: fn.arguments });
          }

          this.history.push({
            role: "assistant",
            content: msg.content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            tool_calls: fns.map((f) => ({
              id: f.id,
              type: "function" as const,
              function: { name: f.name, arguments: f.args },
            })),
          } as any);

          let shouldWait = false;

          for (const f of fns) {
            const tool = this.tools[f.name];
            if (!tool) {
              this.history.push({
                role: "tool",
                tool_call_id: f.id,
                content: `未知工具: ${f.name}`,
              });
              continue;
            }

            let args: Record<string, unknown> = {};
            try { args = JSON.parse(f.args); } catch { /* ignore */ }

            const result = await tool.execute(args);
            sliceLog(100, `[${this.options.name}] 工具 ${f.name} → ${result}`);

            if (result.includes(WAIT_FOR_EVENT)) {
              shouldWait = true;
              this.history.push({
                role: "tool",
                tool_call_id: f.id,
                content: "已发送，等待终端响应...",
              });
            } else {
              this.history.push({
                role: "tool",
                tool_call_id: f.id,
                content: result,
              });
            }
          }

          if (shouldWait) {
            this._waiting = true;
            console.log(`[${this.options.name}] 进入事件等待模式`);
            this._onWaitEnter();
            return finalReply || "(等待事件)";
          }

          if (/已(完成|交付|汇报|回复)|COMPLETE|DONE/.test(finalReply)) {
            break;
          }

          continue;
        }

        finalReply = msg.content ?? "";
        this.history.push({ role: "assistant", content: finalReply, ...(reasoning ? { reasoning_content: reasoning } : {}) } as any);
        sliceLog(200, `[${this.options.name}] 回复: ${finalReply}`);
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.options.name}] 思考失败:`, errMsg);
        console.error(`错误细节:`, err);
        return `思考出错: ${errMsg}`;
      }
    }

    return finalReply;
  }

  // ─── 配置 ───

  setTools(tools: Record<string, ToolDef>): void {
    this.tools = tools;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  // ─── 便利方法 ───

  async sendTo(
    targetId: string,
    data: AgentMessage,
    traceId?: string,
  ): Promise<void> {
    await this.push({
      senderId: this.options.pivotId,
      targetId,
      type: "push",
      payload: { data },
      traceId: traceId ?? crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  resetHistory(): void {
    this.history = [];
    this._waiting = false;
  }

  writeFile(relPath: string, content: string): void {
    const full = resolve(this.workspace, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  /** 子类可重写：日志目录 */
  protected get logDir(): string {
    return resolve(this.workspace, "logs");
  }

  // ─── LLM 日志 ───

  private _logLLM(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
    try {
      const dir = this.logDir;
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        messages: messages.map((m) => {
          const c = (m as any).content;
          const short = typeof c === "string" && c.length > 2000 ? c.slice(0, 2000) + "..." : c;
          return { role: m.role, content: short };
        }),
      }) + "\n";
      appendFileSync(resolve(dir, `${this.options.pivotId}-llm.jsonl`), line, "utf-8");
    } catch { /* 静默失败，不影响主流程 */ }
  }
}
