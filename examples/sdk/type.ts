/**
 * 统一消息格式定义
 * 所有传输层协议（HTTP / WebSocket）最终都转换为 Message 在内部流转
 */
export type MessageType = "push" | "pipe" | "register" | "heartbeat" | "pivots";

export type PivotType = "user" | "agent" | "system" | "gateway" | "tool" | "other";

export interface MessagePayload {
    taskId?: string;
    data?: unknown;
    capabilities?: string[];
    error?: string;
    status?: string;
    /** 本次消息消耗的价格（支持动态定价场景） */
    cost?: string;
    // register 消息额外字段
    pivotId?: string;
    name?: string;
    type?: PivotType;
    /** pipe 协议类型（progress / result / status / 自定义） */
    protocol?: string;
    /** 价格表标识 */
    priceTable?: string;
    /** 同步模式：网关等待目标支点响应后直接返回 */
    sync?: boolean;
}

export interface Message {
    /** 发送方支点ID */
    senderId: string;
    /** 目标支点ID（精确匹配，优先级最高） */
    targetId?: string;
    /** 目标支点名称（模糊匹配，优先级次于 targetId） */
    targetName?: string;
    /** 消息类型 */
    type: MessageType;
    /** 载荷 */
    payload: MessagePayload;
    /** 全链路追踪ID */
    traceId: string;
    /** 时间戳 */
    timestamp: number;
}

export interface PivotInfo {
    pivotId: string;
    type: PivotType;
    /** 支点能力标签（注册时声明，可用于路由匹配和筛选） */
    name?: string;
    capabilities?: string[];
    /** 该支点的价格表标识（支持动态定价，仅做标记用） */
    priceTable?: string;
}

export interface Status {
    connectedAt: number;
    lastHeartbeatAt: number;
    load?: number;
}

/**
 * /pivots 接口的 Query 参数类型
 */
export interface PivotsQuery {
    /** 按能力标签筛选（AND 逻辑，逗号分隔），缺省返回全部 */
    capabilities?: string;
}

/**
 * /pipe 接口的 Query 参数类型
 * - GET 和 POST 共用
 * - targetPivotId 仅在 GET 时有效，用于显式指定目标支点、跳过 TaskRouter
 */
export interface PipeQuery {
    taskId: string;
    protocol?: string;
    targetPivotId?: string;
}

/**
 * 网关对外暴露的 API，供插件调用
 */
export interface GatewayAPI {
    /** 向指定支点推送消息 */
    routeTo(pivotId: string, message: Message): Promise<void>;
    /** 向指定支点请求流式进度 */
    openStream(pivotId: string, message: Message): ReadableStream;
    /** 向指定支点请求结果 */
    requestTo(pivotId: string, message: Message): Promise<unknown>;
}
