/**
 * 交互式命令启动器
 * - 手动定义选项及对应命令
 * - 支持单选或一键启动全部
 *
 * 运行方式：
 *   npm run demo
 *   node --experimental-strip-types examples/runner.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

interface MenuItem {
    name: string;
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
}

const items: MenuItem[] = [
    {
        name: "terminal-pivot",
        cmd: "node",
        args: ["--env-file=.env", "--experimental-strip-types", "examples/terminal-pivot/main.ts"],
        env: {},
    },
    {
        name: "agent-organization",
        cmd: "node",
        args: ["--env-file=.env", "--experimental-strip-types", "examples/agent-organization/main.ts"],
        env: {},
    },
    {
        name: "agent-pivot",
        cmd: "node",
        args: ["--env-file=.env", "--experimental-strip-types", "examples/agent-pivot/main.ts"],
        env: {},
    },
];

if (items.length === 0) {
    console.log("[Runner] 未配置任何菜单项");
    process.exit(0);
}

console.log("=================================");
console.log("  可用选项：");
console.log("=================================");
items.forEach((item, i) => {
    console.log(`  [${String(i + 1).padStart(2)}] ${item.name}`);
});
console.log("  [ a] 启动全部");
console.log("  [ q] 退出");
console.log("=================================");

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question("\n请输入编号: ", (answer) => {
    const input = answer.trim().toLowerCase();

    if (input === "q") {
        console.log("[Runner] 已取消");
        rl.close();
        process.exit(0);
    }

    let toRun: MenuItem[];
    if (input === "a") {
        toRun = items;
    } else {
        const idx = parseInt(input, 10) - 1;
        if (idx >= 0 && idx < items.length) {
            toRun = [items[idx]];
        } else {
            console.log("[Runner] 无效输入");
            rl.close();
            process.exit(1);
        }
    }

    rl.close();

    for (const item of toRun) {
        const env = { ...process.env, ...item.env };
        console.log(`[Runner] 启动 ${item.name}${item.env ? ` (env: ${JSON.stringify(item.env)})` : ""}`);

        const child = spawn(item.cmd, item.args ?? [], {
            stdio: ["ignore", "inherit", "inherit"],
            env,
        });

        child.on("error", (err) => {
            console.error(`[Runner] ${item.name} 启动失败:`, err);
        });

        child.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[Runner] ${item.name} 退出码: ${code}`);
            }
        });
    }
});
