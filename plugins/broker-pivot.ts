import type { GatewayServer } from "../src/server.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

// ─── 类型定义 ───

type TaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "failed" | "dead_letter";

interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  data: unknown;
  publisherId: string;
  originalMessage: Message; // 保留原始消息用于重试转发
  workerId?: string;
  failedWorkerIds: Set<string>; // 已失败的执行者，重试时排除
  result?: unknown;
  error?: string;
  progress?: number;
  retryCount: number;
  maxRetries: number;
  timeout: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  timeline: Array<{ status: TaskStatus; timestamp: number; workerId?: string; extra?: string }>;
  timeoutTimer?: NodeJS.Timeout;
}

interface CachedResult {
  result: unknown;
  cachedAt: number;
  ttl: number;
  timer: NodeJS.Timeout;
}

interface PivotSummary {
  pivotId: string;
  type: string;
  name?: string;
  capabilities?: string[];
}

// ─── 环境变量配置 ───

const BROKER_PIVOT_ID = process.env.BROKER_PIVOT_ID ?? "broker-01";
const BROKER_DEFAULT_TIMEOUT = Number(process.env.BROKER_DEFAULT_TIMEOUT) || 30_000;
const BROKER_MAX_RETRIES = Number(process.env.BROKER_MAX_RETRIES) || 3;
const BROKER_RESULT_TTL = Number(process.env.BROKER_RESULT_TTL) || 600_000; // 10分钟

// ─── 执行者合规标记 ───
const COMPLIANCE_CAPABILITY = "broker:progress";

/**
 * Broker Pivot — 任务代理/编排插件
 *
 * 在任务发布者与执行者之间提供中间层服务：
 * - 任务生命周期管理（状态机 + 时间戳追踪）
 * - 容错重试（超时自动重新分配）
 * - 结果缓存（执行者完成后暂存结果，带 TTL）
 * - 执行者合规检测（区分实现了进度上报接口的执行者与普通执行者）
 */
export class BrokerPivot extends BasePivot {
  private gateway: GatewayServer;
  private tasks = new Map<string, TaskRecord>();
  private resultCache = new Map<string, CachedResult>();

  constructor(options: {
    pivotId: string;
    type: "system";
    capabilities: string[];
    gateway: GatewayServer;
  }) {
    super({
      gatewayUrl: "local://internal",
      pivotId: options.pivotId,
      type: options.type,
      capabilities: options.capabilities,
      localMode: true,
    });
    this.gateway = options.gateway;
  }

  async connect(): Promise<void> {
    console.log(`已注册: ${this.options.pivotId}`);
    console.log(
      `配置: timeout=${BROKER_DEFAULT_TIMEOUT}ms maxRetries=${BROKER_MAX_RETRIES} resultTTL=${BROKER_RESULT_TTL}ms`,
    );
  }

  /** 获取所有活跃任务的摘要（供管理页面使用，不含终态） */
  getTasksSummary(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "dead_letter") continue;
      result.push({
        taskId: task.taskId,
        status: task.status,
        publisherId: task.publisherId,
        workerId: task.workerId,
        progress: task.progress,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
        timeout: task.timeout,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        timeline: task.timeline,
        hasResult: task.result != null,
      });
    }
    return result;
  }

  /** 获取所有已完成/死信任务的摘要（供管理页面使用） */
  getTerminalTasksSummary(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "completed" && task.status !== "dead_letter") continue;
      result.push({
        taskId: task.taskId,
        status: task.status,
        publisherId: task.publisherId,
        workerId: task.workerId,
        progress: task.progress,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
        timeout: task.timeout,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        timeline: task.timeline,
        hasResult: task.result != null,
      });
    }
    return result;
  }

  /** 获取缓存结果的摘要（供管理页面使用） */
  getCachedResultsSummary(): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    for (const [taskId, cached] of this.resultCache) {
      result.push({
        taskId,
        cachedAt: cached.cachedAt,
        ttl: cached.ttl,
        expiresAt: cached.cachedAt + cached.ttl,
      });
    }
    return result;
  }

  // ─── 消息入口 ───

  async onTask(message: Message): Promise<unknown> {
    const protocol = message.payload?.protocol;

    switch (protocol) {
      case "broker:submit":
        return this._handleSubmit(message);
      case "broker:query":
        return this._handleQuery(message);
      case "broker:progress":
        return this._handleProgress(message);
      default:
        throw new Error(`未知协议: ${protocol ?? "(无)"}`);
    }
  }

  // ─── 提交任务 (C1, C2) ───

  private async _handleSubmit(message: Message): Promise<unknown> {
    const { taskId, data, workerId, capabilities, timeout, maxRetries } = message.payload ?? {};

    if (!taskId) throw new Error("submit 缺少 taskId");

    // 幂等：已存在的任务直接返回当前状态
    const existing = this.tasks.get(taskId);
    if (existing && existing.status !== "dead_letter") {
      return {
        taskId,
        status: existing.status,
        progress: existing.progress,
        result: existing.result,
        workerId: existing.workerId,
        message: "任务已存在，返回当前状态",
      };
    }

    const task: TaskRecord = {
      taskId,
      status: "pending",
      data: data ?? message.payload,
      publisherId: message.senderId,
      originalMessage: message,
      failedWorkerIds: new Set(),
      retryCount: 0,
      maxRetries: maxRetries ?? BROKER_MAX_RETRIES,
      timeout: timeout ?? BROKER_DEFAULT_TIMEOUT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timeline: [{ status: "pending", timestamp: Date.now() }],
    };

    this.tasks.set(taskId, task);
    console.log(`task=${taskId} 状态: (new) → pending`);

    // 查找目标执行者
    let targetWorkerId: string;
    if (workerId) {
      targetWorkerId = workerId;
    } else if (capabilities?.length) {
      const found = this._findWorkerByCapabilities(capabilities, task.failedWorkerIds);
      if (!found) throw new Error(`task=${taskId} 无可用执行者支持能力: ${capabilities.join(",")}`);
      targetWorkerId = found;
    } else {
      throw new Error("submit 需要指定 workerId 或 capabilities");
    }

    task.workerId = targetWorkerId;
    this._transitionStatus(task, "assigned", targetWorkerId);

    // 检测执行者合规性，决定转发策略
    const isCompliant = this._isCompliantWorker(targetWorkerId);

    if (isCompliant) {
      // 合规执行者：异步转发 + 启动超时
      console.log(`task=${taskId} 执行者=${targetWorkerId} 合规 (支持进度上报)`);
      await this._forwardToWorker(task, targetWorkerId, message);
      this._startTimeout(taskId);
    } else {
      // 非合规执行者：同步等待结果
      console.log(`task=${taskId} 执行者=${targetWorkerId} 非合规 (同步模式)`);
      this._startTimeout(taskId);
      this._forwardNonCompliant(taskId, targetWorkerId, message);
    }

    // 如果发布者要求同步返回
    if (message.payload?.sync) {
      // 非合规模式下 _forwardNonCompliant 会直接等待并返回
      // 合规模式下返回 accepted 状态
      if (isCompliant) {
        return {
          taskId,
          status: task.status,
          workerId: task.workerId,
          message: "任务已分配，请通过 broker:query 查询进度",
        };
      }
      // 如果 _forwardNonCompliant 是同步的，需要等待其结果
    }

    return {
      taskId,
      status: task.status,
      workerId: task.workerId,
      message: "任务已接受",
    };
  }

  // ─── 查询任务 (C3) ───

  private async _handleQuery(message: Message): Promise<unknown> {
    const { taskId, peek } = message.payload ?? {};
    if (!taskId) throw new Error("query 缺少 taskId");

    const task = this.tasks.get(taskId);
    if (!task) {
      // 查看缓存中是否有历史结果
      const cached = this.resultCache.get(taskId);
      if (cached) {
        // peek 模式下不消费缓存
        const result = peek ? cached.result : this._consumeCache(taskId);
        return {
          taskId,
          status: "completed" as TaskStatus,
          result,
          cachedAt: cached.cachedAt,
          source: peek ? "cache" : "cache",
        };
      }
      return { taskId, status: "not_found", message: "任务不存在（可能已过期）" };
    }

    let result: unknown = task.result;
    let source = "tasks";

    if (task.status === "completed") {
      if (peek) {
        const cached = this.resultCache.get(taskId);
        if (cached) {
          result = cached.result;
          source = "cache";
        }
      } else {
        const consumed = this._consumeCache(taskId);
        if (consumed != null) {
          result = consumed;
          source = "cache";
        }
      }
    }

    return {
      taskId: task.taskId,
      status: task.status,
      source,
      progress: task.progress,
      workerId: task.workerId,
      result,
      error: task.error,
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      timeline: task.timeline,
    };
  }

  /** 取出并删除缓存中的结果（发布者已取走） */
  private _consumeCache(taskId: string): unknown {
    const cached = this.resultCache.get(taskId);
    if (cached) {
      clearTimeout(cached.timer);
      this.resultCache.delete(taskId);
      console.log(`task=${taskId} 结果已被发布者取走，缓存已清理`);
      return cached.result;
    }
    return null;
  }

  // ─── 执行者进度上报 (E2) ───

  private async _handleProgress(message: Message): Promise<unknown> {
    const { taskId, status, progress, result, error } = message.payload ?? {};
    if (!taskId) throw new Error("progress 缺少 taskId");

    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`task=${taskId} 收到进度上报但任务不存在（可能已过期）`);
      return { acknowledged: false, reason: "任务不存在" };
    }

    // 只接受处于合法状态的任务的进度更新
    if (task.status === "completed" || task.status === "dead_letter") {
      console.warn(`task=${taskId} 已是终态(${task.status})，忽略进度上报`);
      return { acknowledged: false, reason: `任务已是终态: ${task.status}` };
    }

    if (status === "in_progress") {
      this._transitionStatus(task, "in_progress", undefined, progress != null ? `progress=${progress}%` : undefined);
      task.progress = progress;
      // 重置超时（执行者正在工作）
      this._resetTimeout(taskId);
    } else if (status === "completed") {
      this._completeTask(taskId, result ?? message.payload?.data);
    } else if (status === "failed") {
      this._handleWorkerFailure(taskId, error ?? "执行者上报失败");
    } else {
      throw new Error(`progress 不支持的状态: ${status}`);
    }

    return { acknowledged: true, taskId, status: task.status };
  }

  // ─── 执行者查找 (E8 部分) ───

  /** 获取所有在线 pivot 的摘要信息 */
  private _getAllPivots(): PivotSummary[] {
    return this.gateway.getAllPivots();
  }

  /** 按能力匹配查找可用执行者 */
  private _findWorkerByCapabilities(capabilities: string[], excludeIds: Set<string>): string | null {
    const all = this._getAllPivots();
    for (const pivot of all) {
      if (excludeIds.has(pivot.pivotId)) continue;
      if (pivot.pivotId === this.options.pivotId) continue; // 排除自身
      const caps = pivot.capabilities ?? [];
      if (capabilities.some((c) => caps.includes(c))) {
        return pivot.pivotId;
      }
    }
    return null;
  }

  /** 查找替代执行者（排除已失败的） */
  private _findAlternativeWorker(task: TaskRecord): string | null {
    const caps = task.originalMessage.payload?.capabilities;
    if (caps?.length) {
      return this._findWorkerByCapabilities(caps, task.failedWorkerIds);
    }
    // 如果原始消息通过 workerId 指定，尝试找同能力其他执行者
    if (task.workerId) {
      const currentWorker = this._getAllPivots().find((p) => p.pivotId === task.workerId);
      const workerCaps = currentWorker?.capabilities ?? [];
      if (workerCaps.length > 0) {
        return this._findWorkerByCapabilities(workerCaps, task.failedWorkerIds);
      }
    }
    return null;
  }

  /** 检测执行者是否合规（实现了进度上报接口） */
  private _isCompliantWorker(workerId: string): boolean {
    const all = this._getAllPivots();
    const worker = all.find((p) => p.pivotId === workerId);
    return worker?.capabilities?.includes(COMPLIANCE_CAPABILITY) ?? false;
  }

  // ─── 任务转发 ───

  /** 转发任务给合规执行者（异步） */
  private async _forwardToWorker(task: TaskRecord, workerId: string, _message: Message): Promise<void> {
    const forwardMsg: Message = {
      senderId: this.options.pivotId,
      targetId: workerId,
      type: "push",
      payload: {
        taskId: task.taskId,
        data: task.data,
        _brokerTaskId: task.taskId,
        _brokerId: this.options.pivotId,
      },
      traceId: task.originalMessage.traceId,
      timestamp: Date.now(),
    };

    await this.gateway.routeTo(workerId, forwardMsg);
    console.log(`task=${task.taskId} 已转发给执行者: ${workerId}`);
  }

  /** 转发任务给非合规执行者（同步等待） */
  private _forwardNonCompliant(taskId: string, workerId: string, message: Message): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const forwardMsg: Message = {
      senderId: this.options.pivotId,
      targetId: workerId,
      type: "push",
      payload: {
        taskId: task.taskId,
        data: task.data,
        sync: true,
        _brokerTaskId: task.taskId,
        _brokerId: this.options.pivotId,
      },
      traceId: message.traceId,
      timestamp: Date.now(),
    };

    this.gateway
      .requestTo(workerId, forwardMsg)
      .then((result) => {
        // 清除超时计时器
        this._clearTimeout(taskId);
        if (this.tasks.has(taskId)) {
          this._completeTask(taskId, result);
        } else {
          // 任务可能在超时后被移除，重新缓存结果
          this._cacheResult(taskId, result);
          console.log(`task=${taskId} 非合规执行者返回结果（任务已清理，仅缓存）`);
        }
      })
      .catch((err) => {
        this._clearTimeout(taskId);
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (this.tasks.has(taskId)) {
          this._handleWorkerFailure(taskId, errorMsg);
        } else {
          console.warn(`task=${taskId} 非合规执行者失败（任务已清理）: ${errorMsg}`);
        }
      });
  }

  // ─── 超时处理 (E1) ───

  private _startTimeout(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status === "completed" || task.status === "dead_letter") return;

    this._clearTimeout(taskId);

    task.timeoutTimer = setTimeout(() => {
      this._handleTimeout(taskId);
    }, task.timeout);
  }

  private _resetTimeout(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status === "completed" || task.status === "dead_letter") return;

    this._clearTimeout(taskId);
    task.timeoutTimer = setTimeout(() => {
      this._handleTimeout(taskId);
    }, task.timeout);
  }

  private _clearTimeout(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task?.timeoutTimer) {
      clearTimeout(task.timeoutTimer);
      task.timeoutTimer = undefined;
    }
  }

  private _handleTimeout(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === "completed" || task.status === "dead_letter") return;

    console.log(`task=${taskId} 超时 (retry ${task.retryCount + 1}/${task.maxRetries})`);

    // 标记当前执行者失败
    if (task.workerId) {
      task.failedWorkerIds.add(task.workerId);
    }

    task.retryCount++;

    if (task.retryCount < task.maxRetries) {
      this._retryTask(task);
    } else {
      this._transitionStatus(task, "dead_letter", undefined, `重试耗尽 (${task.retryCount}/${task.maxRetries})`);
      console.log(`task=${taskId} 重试耗尽，进入死信队列`);
    }
  }

  // ─── 容错重试 (E1) ───

  private _retryTask(task: TaskRecord): void {
    const alternative = this._findAlternativeWorker(task);
    if (!alternative) {
      this._transitionStatus(task, "dead_letter", undefined, "无可用的替代执行者");
      console.log(`task=${task.taskId} 无可用的替代执行者，进入死信队列`);
      return;
    }

    const previousWorker = task.workerId;
    task.workerId = alternative;

    this._transitionStatus(task, "pending", alternative, `retry ${task.retryCount}/${task.maxRetries} (was: ${previousWorker})`);
    this._transitionStatus(task, "assigned", alternative);

    const isCompliant = this._isCompliantWorker(alternative);
    if (isCompliant) {
      this._forwardToWorker(task, alternative, task.originalMessage);
      this._startTimeout(task.taskId);
    } else {
      this._startTimeout(task.taskId);
      this._forwardNonCompliant(task.taskId, alternative, task.originalMessage);
    }
  }

  /** 执行者上报失败 */
  private _handleWorkerFailure(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === "completed" || task.status === "dead_letter") return;

    if (task.workerId) {
      task.failedWorkerIds.add(task.workerId);
    }

    task.retryCount++;

    if (task.retryCount < task.maxRetries) {
      console.log(`task=${taskId} 执行者上报失败: ${error} (retry ${task.retryCount}/${task.maxRetries})`);
      this._retryTask(task);
    } else {
      this._transitionStatus(task, "dead_letter", undefined, `最终失败: ${error}`);
      console.log(`task=${taskId} 重试耗尽，进入死信队列: ${error}`);
    }
  }

  // ─── 任务完成与缓存 (C4) ───

  private _completeTask(taskId: string, result: unknown): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      this._cacheResult(taskId, result);
      return;
    }

    this._clearTimeout(taskId);
    this._transitionStatus(task, "completed");
    task.result = result;
    task.completedAt = Date.now();
    this._cacheResult(taskId, result);

    console.log(`task=${taskId} 完成，结果已缓存等待发布者取走`);
  }

  private _cacheResult(taskId: string, result: unknown): void {
    // 清除旧缓存
    const old = this.resultCache.get(taskId);
    if (old?.timer) clearTimeout(old.timer);

    const timer = setTimeout(() => {
      this.resultCache.delete(taskId);
      console.log(`task=${taskId} 缓存已过期`);
    }, BROKER_RESULT_TTL);

    this.resultCache.set(taskId, {
      result,
      cachedAt: Date.now(),
      ttl: BROKER_RESULT_TTL,
      timer,
    });
  }

  // ─── 状态转换 (C1) ───

  private _transitionStatus(
    task: TaskRecord,
    newStatus: TaskStatus,
    workerId?: string,
    extra?: string,
  ): void {
    const oldStatus = task.status;
    task.status = newStatus;
    task.updatedAt = Date.now();
    if (workerId !== undefined) task.workerId = workerId;

    task.timeline.push({
      status: newStatus,
      timestamp: Date.now(),
      workerId: task.workerId,
      extra,
    });

    console.log(
      `task=${task.taskId} 状态: ${oldStatus} → ${newStatus}` +
      (task.workerId ? ` (worker=${task.workerId})` : "") +
      (extra ? ` [${extra}]` : ""),
    );

    // 进入死信时清超时、记录错误
    if (newStatus === "dead_letter") {
      this._clearTimeout(task.taskId);
      task.error = extra ?? task.error;
    }
  }
}

/** fun-adapter 工厂函数 */
export function createPivot(server: GatewayServer): BrokerPivot {
  return new BrokerPivot({
    pivotId: BROKER_PIVOT_ID,
    type: "system",
    capabilities: ["broker", COMPLIANCE_CAPABILITY],
    gateway: server,
  });
}
