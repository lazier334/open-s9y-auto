import type { Connection } from "../src/connection.ts";
import type { GatewayServer } from "../src/server.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { IncomingMessage } from "node:http";
import type { FastifyRequest } from "fastify";
import type { Message, PivotType } from "../sdk/type.ts";

const KEY_NAME = process.env.AUDIT_KEY_NAME ?? "s9y-key";
const AUTH_KEYS = (process.env.AUDIT_AUTH_KEYS ?? "user,agent,system,gateway,tool,other")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function getCookie(headers: Record<string, string | string[] | undefined>, name: string) {
    const raw = headers["cookie"];
    if (!raw) return undefined;
    const str = Array.isArray(raw) ? raw.join("; ") : raw;
    const match = str.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1];
}

export class AuditPivot extends BasePivot {

    constructor(options: {
        pivotId: string;
        type: "system";
        capabilities: string[];
    }) {
        super({
            gatewayUrl: "local://internal",
            pivotId: options.pivotId,
            type: options.type,
            capabilities: options.capabilities,
            localMode: true,
        });
    }

    async onTask(message: Message): Promise<unknown> {
        const { connection, request } = (message.payload?.data ?? {}) as {
            connection?: Connection;
            request?: FastifyRequest | IncomingMessage;
        };

        if (!request) throw new Error("Audit: 缺少 request");
        const search = new URLSearchParams(request.url?.substring(request.url.indexOf('?')) ?? '');
        const session = search.get(KEY_NAME) || getCookie(request.headers, KEY_NAME) || '';

        if (message.type == 'authenticateRequest') {
            return this.authenticate(session);
        } else {
            if (!connection) throw new Error("Audit: 缺少 connection");

            // 注册授权
            const identity = session ? await this.authenticate(session) : null;
            if (!identity) {
                throw new Error(`Audit拒绝 ${connection.pivotInfo.pivotId}: 无法验证身份`);
            }

            const authorized = await this.authorize(identity, connection);
            if (!authorized) {
                throw new Error(`Audit拒绝 ${connection.pivotInfo.pivotId}: 无权限注册此支点`);
            }

            console.info(`Audit通过: ${connection.pivotInfo.pivotId} identity=${JSON.stringify(identity)}`);
            return { authorized: true };
        }
    }

    /**
     * 验证 session 并返回身份信息
     * 返回 null 表示认证失败
     */
    async authenticate(session: string): Promise<{ subject: PivotType } & Record<string, unknown> | null> {
        // TODO 生产环境请使用真正的验证
        if (AUTH_KEYS.includes(session)) return { subject: session as PivotType };
        return null;
    }

    /**
     * 检查此身份是否有权限注册该 pivot
     * 返回 true 表示授权通过
     */
    protected async authorize(
        identity: { subject: PivotType } & Record<string, unknown>,
        connection: Connection
    ): Promise<boolean> {
        // TODO 生产环境请使用真正的验证
        return connection.pivotInfo.type == identity.subject;
    }
}

export function createPivot(_server: GatewayServer): AuditPivot {
    const pluginPivotId = process.env.AUDIT_PIVOT_ID ?? "audit-01";
    return new AuditPivot({
        pivotId: pluginPivotId,
        type: "system",
        capabilities: ["audit"],
    });
}
