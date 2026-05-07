import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { TerminalFulcrumPivot } from "./terminal-fulcrum-pivot.ts";

const { values } = parseArgs({
  options: {
    "gateway-url": {
      type: "string",
      default: process.env.GATEWAY_URL ?? "ws://localhost:5000",
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

const fulcrum = new TerminalFulcrumPivot({
  gatewayUrl: values["gateway-url"]!,
  pivotId: values["pivot-id"]!,
  name: values.name,
});

await fulcrum.connect();
console.log(
  `[TerminalFulcrum] pivotId=${fulcrum.options.pivotId} name=${fulcrum.options.name} gateway=${values["gateway-url"]}`,
);

const shutdown = () => {
  console.log("\n[TerminalFulcrum] shutting down...");
  fulcrum.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
