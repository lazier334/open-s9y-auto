import "./lib/logger.ts";
import { readFileSync, watch } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config.json");

function loadConfig(): void {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config: Record<string, unknown> = JSON.parse(raw);
    let count = 0;
    for (const [key, value] of Object.entries(config)) {
      // env 优先：只在 process.env 中不存在时才从 config.json 填充
      if (!(key in process.env)) {
        process.env[key] = String(value);
        count++;
      }
    }
    console.log(`已从 config.json 补全 ${count} 个配置项到 process.env（env 优先）`);
  } catch (err) {
    console.warn(`无法读取 config.json: ${err instanceof Error ? err.message : err}`);
  }
}

// 启动时加载配置（env 环境变量 > config.json > 代码默认值）
loadConfig();
