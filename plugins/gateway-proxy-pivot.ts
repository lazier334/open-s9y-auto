import type { GatewayServer } from "../src/server.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

interface UpstreamConfig {
  url: string;
  enabled: boolean;
  pivotId: string;
  capabilities?: string[];
}

/**
 * 网关代理 Pivot
 * - 作为本地 pivot 注册到本地网关
 * - 同时维护多个到上游网关的 HTTP 连接
 * - 收到本地任务后，转发给上游网关处理
 *
 * 配置直接修改 CONFIG 数组
 */
export class GatewayProxyPivot extends BasePivot {
  private upstreams: { url: string; pivotId: string }[] = [];

  /**
   * 上游网关配置列表
   * - 直接修改此数组来增删改目标网关
   * - enabled 控制是否连接
   */
  static readonly CONFIG: UpstreamConfig[] = [
    // 示例配置（取消注释并修改即可启用）
    // { url: "http://localhost:3010", enabled: process.env.GATEWAY_PORT != "3010", pivotId: "proxy-to-a", capabilities: ["calc"] },
    { url: "http://localhost:3000", enabled: false, pivotId: "proxy-to-a", capabilities: ["calc"] },
  ];

  constructor(options: { pivotId: string; capabilities: string[] }) {
    super({
      gatewayUrl: "local://internal",
      pivotId: options.pivotId,
      type: "gateway",
      capabilities: options.capabilities,
      localMode: true,
    });
  }

  async connect(): Promise<void> {
    for (const cfg of GatewayProxyPivot.CONFIG) {
      if (!cfg.enabled) continue;
      this.upstreams.push({ url: cfg.url, pivotId: cfg.pivotId });
      console.log(`已配置上游网关: ${cfg.url} (pivotId=${cfg.pivotId})`);
    }

    if (this.upstreams.length === 0) {
      console.log("无启用的上游网关连接");
    }
  }

  /**
   * 收到本地网关转发的任务，转发给第一个可用的上游网关
   */
  async onTask(message: Message): Promise<unknown> {
    if (this.upstreams.length === 0) {
      throw new Error("无可用上游网关");
    }

    const upstream = this.upstreams[0];

    // 重新构造消息，移除本地网关注入的 targetId，让上游网关重新路由
    const forwarded: Message = {
      senderId: message.senderId,
      type: "push",
      payload: message.payload,
      traceId: message.traceId,
      timestamp: Date.now(),
    };

    const res = await fetch(`${upstream.url}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwarded),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`上游网关调用失败: ${res.status} ${text}`);
    }

    return res.json();
  }
}

/** fun-adapter 工厂函数 */
export function createPivot(_server: GatewayServer): GatewayProxyPivot {
  const proxyCaps = GatewayProxyPivot.CONFIG
    .filter((c) => c.enabled)
    .flatMap((c) => c.capabilities ?? []);

  return new GatewayProxyPivot({
    pivotId: "gateway-proxy",
    capabilities: proxyCaps.length > 0 ? [...new Set(proxyCaps)] : ["gatewayProxy"],
  });
}
