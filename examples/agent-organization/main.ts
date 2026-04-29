/**
 * s9y Agent Organization — 示例入口
 *
 * 角色：
 *   A1 (售前客服) — 路由转发
 *   A2 (产品经理) — 需求分析 + 计划生成 + 任务派发 + 交付
 *   A3-frontend (前端) — html/ 目录
 *   A3-backend (后端) — api/ 目录
 *   A3-tester (测试) — test/ 目录
 *
 * 运行方式:
 *   # 终端 1: 启动网关
 *   npm run gateway
 *   # 终端 2: 启动本示例
 *   node --experimental-strip-types examples/agent-organization/main.ts
 *   # 终端 3: 提交需求
 *   curl -X POST http://localhost:9000/user -H 'Content-Type: application/json' -d '{"content":"做一个登录页面"}'
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";
import { BasePerson } from "./base-person.ts";
import { BroadcastPivot } from "./broadcast-pivot.ts";
import type { AgentMessage, Plan } from "./types.ts";
import type { ToolDef } from "./base-person.ts";

// ─── 配置 ───

const GATEWAY_PORT = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000;
const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://localhost:${GATEWAY_PORT}`;
const HTTP_PORT = process.env.ORCHESTRA_PORT ? Number(process.env.ORCHESTRA_PORT) : 9000;
const REQUEST_TIMEOUT = 300_000;
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), process.env.WORKSPACE ?? "projects");

// 当前项目上下文（A2 的 generate_plan 设置，worker 工具读取）
let currentWorkspace = WORKSPACE_ROOT;
let currentTraceId = "";

// ─── UserProxy (HTTP → 网关) ───

type Pending = {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
};

class UserProxy extends BasePivot {
    private pending = new Map<string, Pending>();

    constructor(gatewayUrl: string) {
        super({
            gatewayUrl, pivotId: "user-proxy", type: "user",
            name: "用户代理", capabilities: ["user-interface"], useWebSocket: true,
        });
    }

    register(traceId: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(traceId);
                reject(new Error("请求超时"));
            }, REQUEST_TIMEOUT);
            this.pending.set(traceId, { resolve, reject, timer });
        });
    }

    async onTask(message: Message): Promise<unknown> {
        const data = message.payload?.data as AgentMessage | undefined;
        if (message.senderId === "a1" && data?.type === "delivery") {
            const p = this.pending.get(message.traceId);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(message.traceId);
                p.resolve({ type: data.type, content: data.content, traceId: message.traceId });
            }
        }
        return;
    }
}

// ─── 工具：A1（售前客服） ───

function forwardToPM(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "forward_to_pm",
            description: "将用户需求转发给产品经理（A2）处理",
            parameters: {
                type: "object",
                properties: { content: { type: "string", description: "用户原始需求内容" } },
                required: ["content"],
            },
        },
        execute: async (args) => {
            const content = args.content as string;
            const traceId = (agent as any)._pendingTraceId ?? randomUUID();
            await agent.sendTo("a2", { type: "task", content }, traceId);
            return "已转发给产品经理（a2），等待回复。收到 a2 回复后，调用 reply_to_user 转发给用户。";
        },
    };
}

function replyToUser(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "reply_to_user",
            description: "将处理结果回复给用户",
            parameters: {
                type: "object",
                properties: { content: { type: "string", description: "回复内容" } },
                required: ["content"],
            },
        },
        execute: async (args) => {
            const content = args.content as string;
            const traceId = (agent as any)._pendingTraceId ?? randomUUID();
            await agent.sendTo("user-proxy", { type: "delivery", content }, traceId);
            return "已回复用户";
        },
    };
}

// ─── 工具：A2（产品经理） ───

function generatePlan(_a2: BasePerson, workers: BasePerson[], broadcastMap: Map<string, BroadcastPivot>): ToolDef {
    return {
        definition: {
            name: "generate_plan",
            description: "分析需求并生成开发计划。会自动创建项目目录、群聊广播，并向所有 worker 派发任务。",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "项目英文标题，如 'login-page'" },
                    description: { type: "string", description: "需求描述" },
                },
                required: ["title", "description"],
            },
        },
        execute: async (args) => {
            const title = args.title as string;
            const description = args.description as string;
            const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
            const slug = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 30) || "project";
            const traceId = `${ts}-${slug}`;
            const workspace = resolve(WORKSPACE_ROOT, traceId);

            // 更新模块级上下文
            currentWorkspace = workspace;
            currentTraceId = traceId;

            const plan: Plan = {
                traceId, title, description,
                directories: ["html", "api", "test", "logs"],
                agents: [
                    { id: "a3-frontend", role: "前端开发", systemPrompt: "", workDir: "html" },
                    { id: "a3-backend", role: "后端开发", systemPrompt: "", workDir: "api" },
                    { id: "a3-tester", role: "测试工程师", systemPrompt: "", workDir: "test" },
                ],
                milestones: ["plan-created", "development", "done"],
            };

            mkdirSync(workspace, { recursive: true });
            for (const dir of plan.directories) mkdirSync(resolve(workspace, dir), { recursive: true });
            writeFileSync(resolve(workspace, "plan.json"), JSON.stringify(plan, null, 2));

            // 创建群聊广播
            const broadcast = new BroadcastPivot(GATEWAY_URL, `broadcast-${traceId}`, workspace);
            await broadcast.connect();
            broadcast.subscribe("a2");

            // 广播加入所有 worker
            for (const w of workers) {
                broadcast.subscribe(w.options.pivotId);
                w.broadcastId = `broadcast-${traceId}`;
                w.workspace = workspace;
                w.workDir = plan.agents.find(a => a.id === w.options.pivotId)?.workDir ?? "";
            }
            broadcastMap.set(traceId, broadcast);

            console.log(`[A2] 项目已创建: ${workspace}`);
            return [
                `计划已生成。workspace: ${workspace}，broadcast: broadcast-${traceId}`,
                `团队: a3-frontend(html/), a3-backend(api/), a3-tester(test/)`,
                `下一步：先调用 dispatch_task 两次，分别向前端(a3-frontend)和后端(a3-backend)派发任务。`,
                `等前端和后端都 mark_done 后，再 dispatch_task 给测试(a3-tester)。`,
                `task 内容中写明需求细节和 workspace 路径: ${workspace}`,
            ].join("\n");
        },
    };
}

function dispatchTask(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "dispatch_task",
            description: "将开发任务派发给指定的 Worker Agent（前端/后端/测试）",
            parameters: {
                type: "object",
                properties: {
                    workerId: { type: "string", description: "目标 worker 的 pivotId，如 a3-frontend / a3-backend / a3-tester" },
                    task: { type: "string", description: "任务描述，需包含需求细节和 workspace 路径" },
                },
                required: ["workerId", "task"],
            },
        },
        execute: async (args) => {
            const workerId = args.workerId as string;
            const task = args.task as string;
            await agent.sendTo(workerId, { type: "task", content: task });
            return `任务已派发给 ${workerId}。等待该 worker 完成后发来 mark_done 通知，再决定下一步。`;
        },
    };
}

function reportToA1(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "report_to_a1",
            description: "将处理结果汇报给 A1（售前客服），A1 会转发给用户",
            parameters: {
                type: "object",
                properties: { summary: { type: "string", description: "处理结果摘要" } },
                required: ["summary"],
            },
        },
        execute: async (args) => {
            const summary = args.summary as string;
            await agent.sendTo("a1", { type: "delivery", content: summary });
            return "结果已汇报给 a1，a1 会转发给用户。你的任务完成。";
        },
    };
}

// ─── 工具：Worker（前端/后端/测试共用） ───

function writeFile(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "write_file",
            description: `在你的工作目录中写入文件。文件会保存到 ${currentWorkspace}/{你的workDir}/`,
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "文件路径，相对于你的工作目录，如 index.html" },
                    content: { type: "string", description: "文件内容" },
                },
                required: ["path", "content"],
            },
        },
        execute: async (args) => {
            const path = args.path as string;
            const content = args.content as string;
            const dir = agent.workDir ?? "";
            const base = agent.workspace || currentWorkspace;
            const fullPath = resolve(base, dir, path.replace(/^\/+/, ""));
            const parentDir = fullPath.replace(/\/[^/]+$/, "");
            if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
            writeFileSync(fullPath, content, "utf-8");
            console.log(`[${agent.options.name}] 文件已写入: ${fullPath} (${content.length}B)`);
            const nextHint = agent.workDir === "test"
                ? "文件已写入。全部测试文件写完后，调用 run_shell 做语法检查，然后写 MD 文档，最后 mark_done。"
                : `文件已写入: ${path} (${content.length}B)。继续创建其他文件，全部完成后调用 run_shell 做语法检查，然后写 MD 文档，最后 mark_done。`;
            return nextHint;
        },
    };
}

function readFile(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "read_file",
            description: "读取工作区内任意文件，了解其他成员产出或检查代码",
            parameters: {
                type: "object",
                properties: { path: { type: "string", description: "相对路径，如 html/index.html 或 api/app.js" } },
                required: ["path"],
            },
        },
        execute: async (args) => {
            const path = args.path as string;
            const base = agent.workspace || currentWorkspace;
            const fullPath = resolve(base, path.replace(/^\/+/, ""));
            try {
                const content = readFileSync(fullPath, "utf-8");
                const preview = content.length > 3000 ? content.slice(0, 3000) + `\n... (总 ${content.length}B)` : content;
                return preview;
            } catch {
                return `文件不存在或无法读取: ${path}`;
            }
        },
    };
}

function runShell(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "run_shell",
            description: "执行 shell 命令进行语法检查、测试等。命令在工作区内执行。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Shell 命令，如 'node --check api/app.js 2>&1'" },
                },
                required: ["command"],
            },
        },
        execute: async (args) => {
            const command = args.command as string;
            const base = agent.workspace || currentWorkspace;
            try {
                const stdout = execSync(command, {
                    cwd: base,
                    timeout: 30_000,
                    encoding: "utf-8",
                    stdio: ["ignore", "pipe", "pipe"],
                });
                console.log(`[${agent.options.name}] run_shell OK: ${command.slice(0, 80)}`);
                return `exitCode: 0\nstdout:\n${stdout.slice(0, 2000) || "(无输出)"}`;
            } catch (err: any) {
                const stderr = err.stderr || "";
                const stdout = err.stdout || "";
                console.log(`[${agent.options.name}] run_shell FAIL: ${command.slice(0, 80)}`);
                return `exitCode: ${err.status ?? 1}\nstdout:\n${stdout.slice(0, 1000) || "(无)"}\nstderr:\n${stderr.slice(0, 1000) || "(无)"}`;
            }
        },
    };
}

function speak(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "speak",
            description: "向团队群聊发送消息",
            parameters: {
                type: "object",
                properties: { message: { type: "string", description: "消息内容" } },
                required: ["message"],
            },
        },
        execute: async (args) => {
            const message = args.message as string;
            const target = agent.broadcastId ?? "a2";
            await agent.sendTo(target, { type: "chat", content: `[${agent.options.name}] ${message}` });
            return "消息已发送到群聊";
        },
    };
}

function markDone(agent: BasePerson): ToolDef {
    return {
        definition: {
            name: "mark_done",
            description: "声明你的开发工作已完成。调用前请确保：1) 核心代码已完成 2) 已做语法检查 3) 已写 MD 文档",
            parameters: {
                type: "object",
                properties: { summary: { type: "string", description: "产出物摘要" } },
                required: ["summary"],
            },
        },
        execute: async (args) => {
            const summary = args.summary as string;
            // 写入 MD 文档
            const role = agent.workDir ?? agent.options.pivotId;
            const docPath = `logs/${role}-result.md`;
            const myFiles = (() => {
                try {
                    const base = agent.workspace || currentWorkspace;
                    const dir = agent.workDir ? resolve(base, agent.workDir) : base;
                    return readdirSync(dir).join(", ");
                } catch { return "(无法列出)"; }
            })();
            agent.writeFile(docPath, [
                `# ${agent.options.name} 工作总结`,
                ``,
                `- 角色: ${agent.options.name}`,
                `- 工作目录: ${agent.workDir ?? "/"}`,
                `- 完成时间: ${new Date().toISOString()}`,
                ``,
                `## 产出物`,
                summary,
                ``,
                `## 文件清单`,
                myFiles,
                ``,
            ].join("\n"));

            await agent.sendTo("a2", {
                type: "delivery",
                content: `${agent.options.name} 工作已完成。${summary}`,
                metadata: { workerId: agent.options.pivotId, status: "completed" },
            });
            return "已声明完成，MD 文档已写入。等待产品经理确认。";
        },
    };
}

// ─── System Prompts ───

const A1_PROMPT = `你是售前客服（A1）。

你的目标：让用户需求被正确处理并收到回复。

## 上下文
- 你面对的是用户（user-proxy），背后是产品经理（a2）
- 你不能自己回答用户问题，必须由产品经理处理

## 工作方式
- 收到用户需求 → 调用 forward_to_pm
- 收到 a2 的回复 → 调用 reply_to_user
- 每次只判断当前消息该做什么，做完就等下一轮`;

const A2_PROMPT = `你是产品经理（A2）。

你的目标：接收需求、组织开发、交付结果。

## 上下文
- 上游是 a1（售前客服），下游有三个 worker：a3-frontend（前端）、a3-backend（后端）、a3-tester（测试）
- 你的工具：generate_plan / dispatch_task / report_to_a1
- 每个工具执行完你会看到结果，然后决定下一步

## 工作方式
1. 收到新需求 → generate_plan（title 用英文 slug 如 'login-page'）
2. plan 生成完毕 → dispatch_task 给前端和后端（a3-frontend、a3-backend）
   - task 中写明需求细节和 workspace 路径
3. 等待前端和后端两方都发来 mark_done 完成消息后 → dispatch_task 给测试（a3-tester）
   - 注意：必须等前端和后端都完成了才能派发给测试
4. 收到测试的 mark_done 完成消息 → report_to_a1 汇总交付
5. 每次工具执行完，立刻根据返回结果决定下一步
6. 目标未达成就继续，达成就汇报`;

const WORKER_PROMPT = (role: string, workDir: string, teammates: string) => `你是${role}工程师。

你的目标：根据任务要求，产出可用的代码文件并通过语法检查。

## 上下文
- 你的工作目录: ${workDir}/
- 团队成员: ${teammates}
- 你的工具: read_file / write_file / run_shell / speak / mark_done

## 必须遵守的工作流程
1. 收到任务 → 快速了解上下文（看 plan.json、读相关代码）→ 立刻开始写代码
2. 分析需要哪些文件 → write_file 逐个创建
3. 如需了解其他成员的接口/结构 → read_file 读他们的代码文件（不是日志）
4. 核心文件写完后 → run_shell 做语法检查
5. 语法通过 → 写 MD 文档记录产出（可以用 write_file 写到 ../logs/${workDir}-result.md）
6. 最后 → mark_done
7. 如果语法检查报错 → 修复 → 重新检查 → 直到通过

## 规则
- 可以读其他成员的代码了解接口，但不要读 logs/*-llm.jsonl（那是调试日志）
- 了解足够上下文后就动手，不要反复探索同一个文件
- 不越界做其他角色的工作
- 不确定的地方可以用 speak 到群聊问
- 已完成就不要重复创建文件`;

// ─── 主函数 ───

async function main() {
    console.log(`网关: ${GATEWAY_URL} | HTTP: ${HTTP_PORT} | 工作区: ${WORKSPACE_ROOT}`);
    mkdirSync(WORKSPACE_ROOT, { recursive: true });

    // 1. 创建所有 Agent
    const userProxy = new UserProxy(GATEWAY_URL);
    const a1 = new BasePerson({ gatewayUrl: GATEWAY_URL, pivotId: "a1", name: "售前客服", systemPrompt: A1_PROMPT });
    const a2 = new BasePerson({ gatewayUrl: GATEWAY_URL, pivotId: "a2", name: "产品经理", systemPrompt: A2_PROMPT });
    const frontend = new BasePerson({ gatewayUrl: GATEWAY_URL, pivotId: "a3-frontend", name: "前端开发", systemPrompt: WORKER_PROMPT("前端", "html", "a3-backend(api/), a3-tester(test/)") });
    const backend = new BasePerson({ gatewayUrl: GATEWAY_URL, pivotId: "a3-backend", name: "后端开发", systemPrompt: WORKER_PROMPT("后端", "api", "a3-frontend(html/), a3-tester(test/)") });
    const tester = new BasePerson({ gatewayUrl: GATEWAY_URL, pivotId: "a3-tester", name: "测试工程师", systemPrompt: WORKER_PROMPT("测试", "test", "a3-frontend(html/), a3-backend(api/)") });

    const workers = [frontend, backend, tester];
    const broadcastMap = new Map<string, BroadcastPivot>();

    // 2. 绑定工具
    a1.setTools({ forward_to_pm: forwardToPM(a1), reply_to_user: replyToUser(a1) });
    a2.setTools({ generate_plan: generatePlan(a2, workers, broadcastMap), dispatch_task: dispatchTask(a2), report_to_a1: reportToA1(a2) });
    for (const w of workers) {
        w.setTools({ write_file: writeFile(w), read_file: readFile(w), run_shell: runShell(w), speak: speak(w), mark_done: markDone(w) });
    }

    // 3. 连接网关
    await userProxy.connect();
    console.log("[Main] user-proxy 已连接");
    await a1.connect();
    console.log("[Main] A1 (售前客服) 已连接");
    await a2.connect();
    console.log("[Main] A2 (产品经理) 已连接");
    for (const w of workers) {
        await w.connect();
        console.log(`[Main] ${w.options.pivotId} (${w.options.name}) 已连接`);
    }

    // ── HTTP 服务 ──

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

        if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

        if (req.method === "POST" && req.url === "/user") {
            try {
                const body = await readBody(req);
                const { content } = JSON.parse(body);
                if (!content?.trim()) { res.writeHead(400); res.end(JSON.stringify({ error: "需求不能为空" })); return; }

                const traceId = randomUUID();
                console.log(`\n[Main] === 新需求 traceId=${traceId}: ${content} ===\n`);

                (a1 as any)._pendingTraceId = traceId;
                const responsePromise = userProxy.register(traceId);

                await userProxy.push({
                    senderId: "user-proxy", targetId: "a1", type: "push",
                    payload: { data: { type: "task", content: content.trim(), metadata: { from: "user" } } },
                    traceId, timestamp: Date.now(),
                });

                const result = await responsePromise;
                console.log(`[Main] === 需求完成 traceId=${traceId} ===\n`);
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("[Main] 处理失败:", msg);
                res.writeHead(500);
                res.end(JSON.stringify({ error: msg }));
            }
            return;
        }

        if (req.method === "GET" && req.url === "/") {
            res.writeHead(200);
            res.end(JSON.stringify({ status: "ok", gateway: GATEWAY_URL }));
            return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not Found" }));
    });

    server.listen(HTTP_PORT, () => {
        console.log(`\n========================================`);
        console.log(`  s9y Agent Organization`);
        console.log(`  HTTP: http://localhost:${HTTP_PORT}`);
        console.log(`  网关: ${GATEWAY_URL}`);
        console.log(`========================================\n`);
    });

    const shutdown = () => {
        console.log("\n[Main] 关闭中...");
        userProxy.disconnect();
        a1.disconnect();
        a2.disconnect();
        for (const w of workers) w.disconnect();
        server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

main().catch((err) => { console.error("启动失败:", err); process.exit(1); });
