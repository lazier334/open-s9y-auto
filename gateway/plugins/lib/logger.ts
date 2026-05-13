import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 读取命令行配置  
 * 如果是使用npm启动, 可以这样携带 `npm run start -- AA=123 BB=参数BB`  
 * 如果是使用node启动, 可以这样携带 `node src/agent.ts AA=123 BB=参数BB`  
 * @returns 
 */
function readCmdConf() {
    const config: { [key: string]: any } = {};
    process.argv.slice(2).forEach(arg => {
        const [k, v] = arg.split('=');
        config[k] = v;
    });
    return config;
}

/** 解析日志路径：CLI LOG_PATH > 环境变量 GATEWAY_LOG_PATH > logs/<时间戳>.log */
function resolveLogPath(): string {
    const cmd = readCmdConf();
    if (cmd.LOG_PATH) return cmd.LOG_PATH;
    if (process.env.GATEWAY_LOG_PATH) return process.env.GATEWAY_LOG_PATH;
    const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    return `logs/${ts}.log`;
}

const LOG_PATH = resolveLogPath();

/** 格式化参数为单行字符串 */
function format(...args: unknown[]): string {
    const ts = new Date().toLocaleString("zh-CN");
    const body = args
        .map((e) => {
            if (e instanceof Error) {
                return e.stack?.includes(e.message) ? e.stack : `${e.message}\n${e.stack}`;
            }
            if (typeof e === "object" && e !== null) {
                try { return JSON.stringify(e); } catch { return String(e); }
            }
            return String(e);
        })
        .join(" ");
    return `[${ts}] ${body}\n`;
}

/**
 * 初始化日志代理 — 将 console.* 的输出同时写入日志文件
 *
 * 环境变量 GATEWAY_LOG_PATH 指定日志文件路径（缺省不写文件）
 * 原始 console 方法保存在 console.org 下
 */
export function initLogger(): void {
    const c = console as unknown as Record<string, unknown>;
    // 避免重复初始化
    if (c.org) return;

    const org = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug.bind(console),
    };

    let stream: ReturnType<typeof createWriteStream> | undefined;
    if (LOG_PATH) {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        stream = createWriteStream(LOG_PATH, { flags: "a" });
        const cleanup = () => { stream?.end(); };
        process.once("beforeExit", cleanup);
        process.once("exit", cleanup);
        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
    }

    const write = (level: string, args: unknown[]) => {
        const line = `[${level.toUpperCase()}] ${format(...args)}`;
        stream?.write(line);
        // 终端输出用原始方法
        org.log(line.trimEnd());
    };

    console.log = (...args: unknown[]) => write("info", args);
    console.info = (...args: unknown[]) => write("info", args);
    console.warn = (...args: unknown[]) => write("warn", args);
    console.error = (...args: unknown[]) => write("error", args);
    console.debug = (...args: unknown[]) => write("debug", args);

    (console as unknown as Record<string, unknown>).org = org;
}

initLogger();
