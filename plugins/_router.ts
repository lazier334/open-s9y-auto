import type { FastifyRequest, FastifyReply } from "fastify";
import type { Message } from "../sdk/type.ts";
import type { GatewayServer } from "../src/server.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config.json");

// ─── /pipe 管道辅助函数 ───

function pipeWaiterKey(protocol: string, taskId: string): string {
    return `${taskId}:${protocol}`;
}

function setPipeWaiter(server: GatewayServer, protocol: string, taskId: string, reply: FastifyReply): void {
    const key = pipeWaiterKey(protocol, taskId);
    const timer = setTimeout(() => {
        server.pipeWaiters.delete(key);
        if (!reply.sent) {
            reply.code(504).send({ error: "超时" });
        }
    }, server.requestTimeout);

    reply.raw.on("close", () => {
        clearTimeout(timer);
        server.pipeWaiters.delete(key);
    });

    server.pipeWaiters.set(key, { reply, timer });
}

async function resolvePipeWaiter(
    server: GatewayServer,
    protocol: string,
    taskId: string,
    request: FastifyRequest
): Promise<boolean> {
    const key = pipeWaiterKey(protocol, taskId);
    const waiter = server.pipeWaiters.get(key);

    if (!waiter) {
        console.log("无等待者:", key);
        return false;
    }

    const targetRaw = waiter.reply.raw;
    const sourceRaw = request.raw;

    if (targetRaw.writableEnded || targetRaw.destroyed) {
        console.log("目标连接已关闭");
        server.pipeWaiters.delete(key);
        return false;
    }

    const statusCode =
        parseInt(request.headers["x-pipe-status"] as string) || 200;
    let headers: Record<string, string> = {};
    try {
        const headerStr = request.headers["x-pipe-headers"] as string;
        if (headerStr) {
            headers = JSON.parse(headerStr);
        }
    } catch (e) {
        console.warn("解析 headers 失败:", e);
    }

    waiter.reply.hijack();
    targetRaw.writeHead(statusCode, {
        ...headers,
        "Transfer-Encoding": "chunked",
        "X-Pipe-Protocol": protocol,
        "X-Accel-Buffering": "no",
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = (success: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(waiter.timer);
            server.pipeWaiters.delete(key);
            success ? resolve(true) : reject(new Error("Stream failed"));
        };

        sourceRaw.pipe(targetRaw);

        sourceRaw.on("end", () => {
            targetRaw.end();
            cleanup(true);
        });

        sourceRaw.on("error", (err) => {
            console.error("源流错误:", err.message);
            targetRaw.destroy();
            cleanup(false);
        });

        targetRaw.on("error", (err) => {
            console.error("目标流错误:", err.message);
            sourceRaw.destroy();
            cleanup(false);
        });

        targetRaw.on("close", () => {
            console.log("目标关闭（客户端断开）");
            sourceRaw.destroy();
            cleanup(false);
        });

        waiter.timer = setTimeout(() => {
            console.error("管道传输超时");
            sourceRaw.destroy();
            targetRaw.destroy();
            cleanup(false);
        }, server.requestTimeout * 10);
    });
}

// ─── 主入口 ───

export function createPivot(server: GatewayServer): void {
    let fastify = server.fastify;
    // ── 第1层：网络级 cookie 认证 ──
    // 身份验证函数
    let authenticateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
        if (!await server.connections.authenticateRequest(request)) {
            return reply.code(401).send({ error: '身份验证失败' });
        }
    };
    if (process.env.API_ADMIN == 'true') {
        const authenticateRequestOrigin = authenticateRequest;
        authenticateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
            const path = (request.url ?? "").split('?').shift() ?? "";
            // 首页页面跳过认证
            if (path === '/') return reply.redirect('/index.html');
            if (path === "/index.html") return;
            // 进行验证
            return await authenticateRequestOrigin(request, reply);
        }
    }
    fastify.addHook('preHandler', authenticateRequest);

    // ── GET /shutdown ──（仅 API_SHUTDOWN 环境变量为真时注册）
    if (process.env.API_SHUTDOWN == 'true') {
        fastify.get("/shutdown", async (_request, reply) => {
            reply.code(202).send({ status: "正在关机中" });
            console.log('系统正在关机中...');
            server.close().catch(() => process.exit(0));
        });
        fastify.post("/restart", async (_request, reply) => {
            reply.code(202).send({ status: "正在重启中" });
            console.log('系统正在重启...');
            const cmd = (process.env.GATEWAY_CMD ?? "npm run gateway").trim();
            const [bin, ...args] = cmd.split(/\s+/);
            const child = spawn(bin, args, {
                detached: true,
                stdio: "inherit",
                env: process.env,
                cwd: process.cwd(),
            });
            child.unref();
            server.close().catch(() => { });
            // 给新进程一点时间启动，然后退出旧进程
            setTimeout(() => process.exit(0), 500);
        });
    }

    // ── 管理面板（仅 API_ADMIN 环境变量为真时注册）──
    if (process.env.API_ADMIN == 'true') {
        let htmlCache = readIndexFile();
        function readIndexFile() {
            const htmlPath = join(__dirname, "index.html");
            try {
                return readFileSync(htmlPath, "utf-8");
            } catch (err) {
                console.warn("无法读取 index.html，管理面板不可用");
                return String(err);
            }
        }

        ['/', '/index.html'].forEach(p => fastify.get(p, async (_request, reply) => {
            reply.header("Set-Cookie", `${process.env.AUDIT_KEY_NAME ?? "s9y-key"}=user; Path=/; SameSite=Lax`);
            return reply.type("text/html; charset=utf-8").send(readIndexFile());
        }));

        fastify.get("/admin/api/status", async (_request, reply) => {
            const broker = server.connections.getLocal("broker-01");
            const tasks = broker && typeof (broker as any).getTasksSummary === "function"
                ? (broker as any).getTasksSummary() : [];
            const terminal = broker && typeof (broker as any).getTerminalTasksSummary === "function"
                ? (broker as any).getTerminalTasksSummary() : [];
            const cached = broker && typeof (broker as any).getCachedResultsSummary === "function"
                ? (broker as any).getCachedResultsSummary() : [];

            const all = server.getAllPivots();
            const pivots = all.map((p) => {
                const conn = server.connections.get(p.pivotId);
                return {
                    pivotId: p.pivotId,
                    type: p.type,
                    name: p.name,
                    capabilities: p.capabilities,
                    adapterType: conn?.socket ? "ws" : conn?.reply ? "http" : "fun",
                    status: conn?.status ?? null,
                };
            });
            return reply.code(200).send({ pivots, tasks, terminal, cached });
        });

        // ── 配置读写 API ──
        fastify.get("/admin/api/config", async (_request, reply) => {
            try {
                const raw = readFileSync(CONFIG_PATH, "utf-8");
                const config = JSON.parse(raw);
                if (config.API_CONFIG) {
                    return reply.code(200).send(config);
                }
                // 不允许修改配置时，仅返回开关状态
                return reply.code(200).send({
                    API_CONFIG: config.API_CONFIG ?? false,
                    API_SHUTDOWN: config.API_SHUTDOWN ?? false,
                });
            } catch (err) {
                return reply.code(500).send({ error: "无法读取配置文件" });
            }
        });

        fastify.post("/admin/api/config", async (request, reply) => {
            try {
                if (!process.env.API_CONFIG) return reply.code(500).send({ error: "已禁止修改配置文件" });
                const body = request.body as Record<string, unknown>;
                if (!body || typeof body !== "object") {
                    return reply.code(400).send({ error: "无效的配置数据" });
                }
                // 基于原配置合并变更，防止空对象/部分字段覆盖导致配置丢失
                let existing: Record<string, unknown> = {};
                try {
                    const raw = readFileSync(CONFIG_PATH, "utf-8");
                    existing = JSON.parse(raw);
                    if (!existing.API_CONFIG) return reply.code(500).send({ error: "已禁止修改配置文件" });
                    // 清理多余的内容
                    Object.keys(body).forEach(k => !Object.hasOwn(existing, k) && delete body[k])
                } catch {
                    // 配置文件不存在时从零创建
                }
                const merged = { ...existing, ...body };
                const json = JSON.stringify(merged, null, 2);
                writeFileSync(CONFIG_PATH, json + "\n", "utf-8");
                // 实时更新 process.env（运行时生效，重启后 .env 中的值优先）
                for (const [key, value] of Object.entries(merged)) {
                    process.env[key] = String(value);
                }
                console.log(`配置已更新 (合并后共 ${Object.keys(merged).length} 项)`);
                return reply.code(200).send({ ok: true, total: Object.keys(merged).length });
            } catch (err) {
                return reply.code(500).send({ error: "无法保存配置文件" });
            }
        });
    }

    // ── GET /pipe ── 管道消费端（挂起等待流数据）
    fastify.get("/pipe", async (request: FastifyRequest, reply: FastifyReply) => {
        const q = request.query as Record<string, string>;
        const protocol = q.protocol ?? "result";
        const taskId = q.taskId;
        let targetPivotId = q.targetPivotId;

        if (!targetPivotId) {
            targetPivotId = server.connections.getPivotId(taskId);
        }

        if (!targetPivotId) {
            return reply.code(404).send({ error: "目标支点未找到" });
        }
        if (!server.connections.has(targetPivotId)) {
            return reply.code(503).send({ error: "支点离线" });
        }

        setPipeWaiter(server, protocol, taskId, reply);

        const msg: Message = {
            senderId: "gateway",
            targetId: targetPivotId,
            type: "pipe",
            payload: { taskId, protocol },
            traceId: randomUUID(),
            timestamp: Date.now(),
        };

        try {
            await server.routeTo(targetPivotId, msg);
            reply.hijack();
        } catch (err) {
            const key = pipeWaiterKey(protocol, taskId);
            const waiter = server.pipeWaiters.get(key);
            if (waiter) {
                clearTimeout(waiter.timer);
                server.pipeWaiters.delete(key);
                if (!reply.sent) {
                    reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
                }
            }
        }
    });

    // ── POST /pipe ── 管道生产端（推送流数据给消费端）
    fastify.post("/pipe", {
        config: { rawBody: true },
        bodyLimit: 1024 ** 3,
        preParsing: async (request, _reply, payload) => {
            request.headers["content-type"] = "application/octet-stream";
            return payload;
        },
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const q = request.query as Record<string, string>;
        const protocol = q.protocol ?? "result";
        const taskId = q.taskId;

        if (!taskId) {
            return reply.code(400).send({ error: "Missing taskId" });
        }

        const resolved = await resolvePipeWaiter(server, protocol, taskId, request);
        if (!resolved) {
            return reply.code(409).send({ error: "消费方不存在" });
        }

        return { status: "delivered" };
    });
}
