import type { GatewayServer } from "../src/server.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

interface PivotRecord {
  pivotId: string;
  assignedCount: number;
}

/**
 * 路由插件 Pivot（本地模式）
 * - 继承 BasePivot，localMode=true
 * - 直接通过 gateway.connections 获取在线支点
 * - 实现能力匹配 + 最小负载均衡
 */
export class RouterPivot extends BasePivot {
  private gateway: GatewayServer;
  private assignedCounts = new Map<string, number>();

  constructor(options: {
    pivotId: string;
    type: "system";
    capabilities?: string[];
    gateway: GatewayServer;
  }) {
    super({
      gatewayUrl: "local://internal",
      pivotId: options.pivotId,
      type: options.type,
      capabilities: options.capabilities,
      localMode: true,
    });
    this.gateway = options.gateway;
  }

  async connect(): Promise<void> {
    // localMode，无需网络连接
    return Promise.resolve();
  }

  /**
   * 任务分发决策
   * - 从 message.payload.capabilities 提取所需能力
   * - 通过 gateway.connections 获取实时在线支点
   * - 选择 assignedCount 最小的支点
   */
  async onTask(message: Message): Promise<string> {
    const requiredCaps = message.payload?.capabilities ?? [];
    const all = this.gateway.getAllPivots();
    const candidates: PivotRecord[] = [];

    for (const pivot of all) {
      const caps = pivot.capabilities ?? [];
      if (requiredCaps.length === 0 || requiredCaps.some((c) => caps.includes(c))) {
        candidates.push({
          pivotId: pivot.pivotId,
          assignedCount: this.assignedCounts.get(pivot.pivotId) ?? 0,
        });
      }
    }

    if (candidates.length === 0) {
      throw new Error(`没有可用支点支持该能力: ${requiredCaps.join(",")}`);
    }

    // 同能力下有同名匹配的优先，否则退化到纯能力匹配
    if (message.targetName) {
      const nameMap = new Map(all.map((p) => [p.pivotId, p.name]));
      const byName = candidates.filter((c) => nameMap.get(c.pivotId) === message.targetName);
      if (byName.length > 0) {
        const selected = byName.sort((a, b) => a.assignedCount - b.assignedCount)[0];
        this.assignedCounts.set(selected.pivotId, selected.assignedCount + 1);
        return selected.pivotId;
      }
    }

    const selected = candidates.sort((a, b) => a.assignedCount - b.assignedCount)[0];
    this.assignedCounts.set(selected.pivotId, selected.assignedCount + 1);
    return selected.pivotId;
  }
}

/** fun-adapter 工厂函数 */
export function createPivot(server: GatewayServer): RouterPivot {
  const pluginPivotId = process.env.PLUGIN_PIVOT_ID ?? "router-01";
  return new RouterPivot({
    pivotId: pluginPivotId,
    type: "system",
    capabilities: ["routing"],
    gateway: server,
  });
}
