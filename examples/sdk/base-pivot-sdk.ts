import { WebSocket } from "ws";
import type { Message, PivotType } from "./type.ts";

export interface BasePivotOptions {
    gatewayUrl: string;
    pivotId: string;
    type: PivotType;
    /** 支点自定义名称（可用于路由匹配） */
    name?: string;
    capabilities?: string[];
    /** 该支点的价格表标识（支持动态定价，仅做标记用） */
    priceTable?: string;
    heartbeatInterval?: number;
    /** 使用 WebSocket 长连接，否则使用 HTTP 短连接 */
    useWebSocket?: boolean;
    /** 本地模式：不建立网络连接，供同一进程内网关直接调用 */
    localMode?: boolean;
}

/**
 * 支点 SDK 基类
 * - 支持 HTTP 和 WebSocket 双模式
 * - 自动发送 register 和心跳（WS 模式下）
 * - HTTP 模式下通过 /register 长轮询接收网关消息
 * - 统一接口：push / pipe / status
 * - WS 模式下会额外启动一个 HTTP /register 副线程，用于接收 pipe 查询通知
 */
export abstract class BasePivot {
    options: BasePivotOptions;
    protected ws?: WebSocket;
    protected heartbeatTimer?: NodeJS.Timeout;
    protected pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    protected registerAbort?: AbortController;
    constructor(options: BasePivotOptions) {
        this.options = {
            heartbeatInterval: 30_000,
            useWebSocket: true,
            ...options,
        };
    }

    /**
     * 建立与网关的连接
     * - WS 模式：建立 WebSocket 并自动注册、启用心跳
     * - HTTP 模式：启动 /register 长轮询循环
     */
    async connect(): Promise<void> {
        if (this.options.localMode) return;
        if (this.options.useWebSocket) {
            return this._connectWs();
        }
        this._startRegisterLoop();
    }

    /**
     * 断开与网关的连接
     */
    disconnect(): void {
        if (this.options.localMode) return;
        this._stopHeartbeat();
        this.ws?.close();
        this.registerAbort?.abort();
    }

    /**
     * 向网关推送消息（统一接口 1/3）
     */
    async push(message: Message): Promise<void> {
        if (this.options.useWebSocket && this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(message));
            return;
        }
        const res = await fetch(`${this.options.gatewayUrl}/push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
        });
        if (!res.ok) throw new Error(`推送失败: ${res.status}`);
    }

    /**
     * 获取任务进度（统一接口 2/3）
     * - 消费者直接 GET /pipe?taskId=...&protocol=progress 挂起等待
     */
    async progress(taskId: string): Promise<ReadableStream<Uint8Array>> {
        const res = await fetch(`${this.options.gatewayUrl}/pipe?taskId=${taskId}&protocol=progress`);
        if (!res.ok) throw new Error(`获取进度失败: ${res.status}`);
        return res.body as ReadableStream<Uint8Array>;
    }

    /**
     * 获取任务结果（统一接口 3/3）
     */
    async result(taskId: string): Promise<unknown> {
        const res = await fetch(`${this.options.gatewayUrl}/pipe?taskId=${taskId}&protocol=result`);
        if (!res.ok) throw new Error(`获取结果失败: ${res.status}`);
        const json = (await res.json()) as { data?: unknown; error?: string };
        if (json.error) throw new Error(json.error);
        return json.data;
    }

    /**
     * 获取任务状态
     */
    async status(taskId: string): Promise<unknown> {
        const res = await fetch(`${this.options.gatewayUrl}/pipe?taskId=${taskId}&protocol=status`);
        if (!res.ok) throw new Error(`获取状态失败: ${res.status}`);
        const json = (await res.json()) as { data?: unknown; error?: string };
        if (json.error) throw new Error(json.error);
        return json.data;
    }

    // ─── WebSocket 内部方法 ───

    private _connectWs(): Promise<void> {
        console.log('正在使用WS模式注册支点');
        return new Promise((resolve, reject) => {
            const wsUrl = this.options.gatewayUrl.replace(/^http/, "ws");
            this.ws = new WebSocket(wsUrl);

            this.ws.once("open", () => {
                this._sendRegister();
                this._startHeartbeat();
                resolve();
            });

            this.ws.once("error", reject);
            this.ws.on("message", (raw: Buffer) => this._onMessage(raw));
            this.ws.on("close", () => this._stopHeartbeat());
        });
    }

    private _sendRegister(): void {
        const registerMsg: Message = {
            senderId: this.options.pivotId,
            type: "register",
            payload: {
                pivotId: this.options.pivotId,
                name: this.options.name,
                type: this.options.type,
                capabilities: this.options.capabilities,
                priceTable: this.options.priceTable,
            },
            traceId: crypto.randomUUID(),
            timestamp: Date.now(),
        };
        this.ws?.send(JSON.stringify(registerMsg));
    }

    private _startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            const hb: Message = {
                senderId: this.options.pivotId,
                type: "heartbeat",
                payload: {},
                traceId: crypto.randomUUID(),
                timestamp: Date.now(),
            };
            this.ws?.send(JSON.stringify(hb));
        }, this.options.heartbeatInterval);
    }

    private _stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private _onMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
        try {
            const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : raw.toString();
            const msg = JSON.parse(text) as Message;

            // 请求响应匹配
            const pendingReq = this.pendingRequests.get(msg.traceId);
            if (pendingReq) {
                this.pendingRequests.delete(msg.traceId);
                if (msg.payload?.error) pendingReq.reject(new Error(String(msg.payload.error)));
                else pendingReq.resolve(msg.payload?.data ?? msg.payload);
                return;
            }

            // 普通任务推送：由子类处理，结果自动回传
            if (msg.type === "push") {
                this._handleTaskWithReply(msg).catch(() => {
                    // ignore
                });
            }
        } catch {
            // ignore invalid message
        }
    }

    // ─── HTTP 内部方法 ───

    private _startRegisterLoop(): void {
        console.log('正在使用HTTP模式注册支点');
        const loop = async () => {
            while (true) {
                if (this.registerAbort?.signal.aborted) break;
                try {
                    const body = {
                        pivotId: this.options.pivotId,
                        type: this.options.type,
                        capabilities: this.options.capabilities,
                        priceTable: this.options.priceTable,
                    };

                    const res = await fetch(`${this.options.gatewayUrl}/register`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                        signal: this.registerAbort?.signal,
                    });

                    if (res.status === 409) {
                        console.warn(`[BasePivot] 注册冲突，2秒后重试...`);
                        await this._delay(2000);
                        continue;
                    }

                    if (!res.ok) {
                        console.error(`[BasePivot] 注册失败:`, res.status);
                        await this._delay(5000);
                        continue;
                    }

                    const text = await res.text();
                    // 为什么不直接使用 res.json() 读取数据？
                    // 因为如果消息内容不是json格式会报JSON序列化错误，而且没有可靠的调用栈信息
                    // 这样做是为了更容易定位错误位置
                    const msg = (JSON.parse(text)) as Message;
                    if ((msg as unknown as { type: string }).type === "noop") {
                        continue;
                    }

                    await this._handleServerMessage(msg);
                } catch (err: unknown) {
                    if ((err as Error).name === "AbortError") break;
                    console.error(`[BasePivot] 注册轮询异常:`, err);
                    await this._delay(5000);
                }
            }
        };

        this.registerAbort = new AbortController();
        loop().catch(() => { });
    }

    private async _handleServerMessage(msg: Message): Promise<void> {
        if (msg.type === "push") {
            await this._handleTaskWithReply(msg).catch(() => { });
            return;
        }

        if (msg.type === "pipe") {
            const protocol = msg.payload?.protocol as string;
            const taskId = msg.payload?.taskId as string;

            if (protocol === "progress") {
                const stream = this.onProgressRequest?.(taskId);
                if (stream) {
                    return await this._postPipeBinaryStream("progress", taskId, stream);
                } else {
                    await this._postPipe("progress", taskId, { data: null });
                }
                return;
            }

            if (protocol === "result") {
                return await this._handlePipeProtocol("result", taskId, () => this.onResultRequest?.(taskId));
            }

            if (protocol === "status") {
                return await this._handlePipeProtocol("status", taskId, () => this.onStatusRequest?.(taskId));
            }

            return await this._handlePipeProtocol(protocol, taskId, () => this.onPipeRequest?.(protocol, taskId));
        }
    }

    private async _handlePipeProtocol(
        protocol: string,
        taskId: string,
        handler: () => unknown | Promise<unknown>
    ): Promise<void> {
        try {
            const data = await Promise.resolve(handler());
            await this._postPipe(protocol, taskId, { data });
        } catch (err: unknown) {
            await this._postPipe(protocol, taskId, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private async _postPipe(protocol: string, taskId: string, body: { data?: unknown; error?: string }): Promise<void> {
        const res = await fetch(`${this.options.gatewayUrl}/pipe?taskId=${taskId}&protocol=${protocol}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`[BasePivot] taskId=${taskId}&protocol=${protocol} 回传失败:`, res.status);
        }
    }

    private async _postPipeBinaryStream(
        protocol: string,
        taskId: string,
        stream: ReadableStream<Uint8Array>
    ): Promise<void> {
        const res = await fetch(
            `${this.options.gatewayUrl}/pipe?taskId=${taskId}&protocol=${protocol}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                },
                body: stream,
                // Node.js 18+ 必需
                duplex: "half",
            }
        );

        if (!res.ok) {
            console.error(`[BasePivot] taskId=${taskId}&protocol=${protocol} 流式回传失败:`, res.status);
        }
    }


    private async _handleTaskWithReply(msg: Message): Promise<void> {
        try {
            const result = await this.onTask(msg);
            if (msg.traceId && result !== undefined) {
                const reply: Message = {
                    senderId: this.options.pivotId,
                    targetId: msg.senderId,
                    type: "push",
                    payload: { data: result },
                    traceId: msg.traceId,
                    timestamp: Date.now(),
                };
                await this.push(reply);
            }
        } catch (err) {
            if (msg.traceId) {
                const reply: Message = {
                    senderId: this.options.pivotId,
                    targetId: msg.senderId,
                    type: "push",
                    payload: { error: err instanceof Error ? err.message : String(err) },
                    traceId: msg.traceId,
                    timestamp: Date.now(),
                };
                await this.push(reply);
            }
        }
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 通过 WebSocket 主动向网关发送消息
     */
    send(message: Message): void {
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(message));
        } else {
            throw new Error("WebSocket 未连接");
        }
    }

    /**
     * 子类可选实现：处理网关发来的进度查询请求
     */
    onProgressRequest?(taskId: string): ReadableStream<unknown> | undefined;

    /**
     * 子类可选实现：处理网关发来的结果查询请求
     */
    onResultRequest?(taskId: string): unknown | Promise<unknown>;

    /**
     * 子类可选实现：处理网关发来的状态查询请求
     */
    onStatusRequest?(taskId: string): unknown | Promise<unknown>;

    /**
     * 子类可选实现：处理自定义 pipe 协议查询
     */
    onPipeRequest?(protocol: string, taskId: string): unknown | Promise<unknown>;

    /**
     * 子类必须实现：处理网关推送过来的任务
     * 若返回非 undefined 值，SDK 会自动通过相同 traceId 回传响应
     */
    abstract onTask(message: Message): Promise<unknown>;
}
