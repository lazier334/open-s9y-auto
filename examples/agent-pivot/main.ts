import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { resolve } from "node:path";
import { AgentPivot } from "./agent-pivot.ts";

const { values } = parseArgs({
  options: {
    "gateway-url": {
      type: "string",
      default: process.env.GATEWAY_URL ?? "ws://localhost:3000",
    },
    "pivot-id": {
      type: "string",
      default: process.env.PIVOT_ID ?? `agent-pivot-${randomUUID().slice(0, 8)}`,
    },
    name: {
      type: "string",
      default: process.env.PIVOT_NAME ?? "程序员Agent",
    },
    "terminal-pivot-id": {
      type: "string",
      default: process.env.TERMINAL_PIVOT_ID ?? "",
    },
  },
});

const workspaceRoot = resolve(process.env.WORKSPACE_ROOT ?? ".cache");

const agent = new AgentPivot({
  gatewayUrl: values["gateway-url"]!,
  pivotId: values["pivot-id"]!,
  name: values.name!,
  terminalPivotId: values["terminal-pivot-id"]!,
  workspaceRoot,
});

await agent.connect();

console.log(
  `[AgentPivot] 已启动\n` +
  `  pivotId    = ${agent.options.pivotId}\n` +
  `  name       = ${agent.options.name}\n` +
  `  gateway    = ${values["gateway-url"]}\n` +
  `  terminal   = ${values["terminal-pivot-id"] || "(自动发现)"}\n` +
  `  workspace  = ${workspaceRoot}`,
);

const shutdown = () => {
  console.log("\n[AgentPivot] shutting down...");
  agent.disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
