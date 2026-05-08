/**
 * BroadcastPivot — 群聊中继
 *
 * 每个项目一个实例，订阅者之间互相转发消息。
 * 所有消息持久化到 logs/chat.log。
 */
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export class BroadcastPivot extends BasePivot {
  private subscribers = new Set<string>();
  private chatLogPath: string;

  constructor(gatewayUrl: string, pivotId: string, workspace: string) {
    super({
      gatewayUrl,
      pivotId,
      type: "system",
      headers: { cookie: 's9y-key=system' },
      name: pivotId,
      capabilities: ["broadcast"],
      useWebSocket: true,
    });
    this.chatLogPath = resolve(workspace, "logs", "chat.log");
  }

  subscribe(agentId: string): void {
    this.subscribers.add(agentId);
  }

  async onTask(message: Message): Promise<void> {
    const data = message.payload?.data as Record<string, unknown> | undefined;
    if (!data?.type) return;

    // 持久化
    try {
      mkdirSync(resolve(this.chatLogPath, ".."), { recursive: true });
      appendFileSync(this.chatLogPath, JSON.stringify({
        ts: new Date().toISOString(),
        sender: message.senderId,
        type: data.type,
        content: data.content,
      }) + "\n", "utf-8");
    } catch { /* ignore */ }

    // 转发给所有订阅者（排除发送者）
    for (const subId of this.subscribers) {
      if (subId === message.senderId) continue;
      this.push({
        senderId: this.options.pivotId,
        targetId: subId,
        type: "push",
        payload: message.payload,
        traceId: message.traceId,
        timestamp: Date.now(),
      }).catch(() => { });
    }
  }
}
