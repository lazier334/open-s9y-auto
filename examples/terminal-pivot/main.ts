import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { TerminalPivot } from "./terminal-pivot.ts";

const { values } = parseArgs({
  options: {
    "gateway-url": {
      type: "string",
      default: process.env.GATEWAY_URL ?? "ws://localhost:3000",
    },
    "pivot-id": {
      type: "string",
      default: process.env.PIVOT_ID ?? `terminal-${randomUUID().slice(0, 8)}`,
    },
    name: {
      type: "string",
      default: process.env.PIVOT_NAME ?? os.hostname(),
    },
  },
});

const pivot = new TerminalPivot({
  gatewayUrl: values["gateway-url"]!,
  pivotId: values["pivot-id"]!,
  name: values.name,
});

await pivot.connect();
console.log(
  `[TerminalPivot] pivotId=${pivot.options.pivotId} name=${pivot.options.name} gateway=${values["gateway-url"]}`,
);

const shutdown = () => {
  console.log("\n[TerminalPivot] shutting down...");
  pivot.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
