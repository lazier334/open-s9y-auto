/**
 * detectors.ts — 终端输出检测器
 *
 * 两类检测机制：
 * 1. 正则检测器（fast path）：terminal 输出到达时立即执行，匹配权限询问/错误/完成等明确模式
 * 2. 屏幕稳定性检测器（兜底）：每秒 tick，屏幕持续 N 秒不变则唤醒 LLM 自行判断
 */

import type { ScreenBuffer } from "./screen-buffer.ts";

// ─── 类型 ───

export interface OutputDetector {
  name: string;
  detect(buffer: string): string | null;
}

// ─── 正则检测器 ───

export function buildDetectors(): OutputDetector[] {
  return [
    {
      name: "permission",
      detect(buffer) {
        const patterns = [
          /(?:Allow|Deny|allow this|deny this|approve|reject).*\?/i,
          /\(Y\/n\)/i,
          /\(y\/N\)/i,
          /\[Y\/n\]/i,
          /\[y\/N\]/i,
          /Do you want to proceed/i,
          /Press Enter to continue/i,
          /Would you like to/i,
        ];
        for (const p of patterns) {
          const match = buffer.match(p);
          if (match) {
            const start = Math.max(0, (match.index ?? 0) - 200);
            return buffer.slice(start, (match.index ?? 0) + match[0].length + 100).trim();
          }
        }
        return null;
      },
    },
    // {
    //   name: "error",
    //   detect(buffer) {
    //     const patterns = [
    //       /(?:额度不足|quota exceeded|rate limit|billing|payment required)/i,
    //       /(?:ENOENT|EACCES|EPERM|ENOSPC):/,
    //       /(?:command not found|No such file or directory)/,
    //       /(?:fatal error|panic|segmentation fault)/i,
    //       /Error:.*(?:API|token|key|auth|credential)/i,
    //     ];
    //     for (const p of patterns) {
    //       const match = buffer.match(p);
    //       if (match) {
    //         const start = Math.max(0, (match.index ?? 0) - 200);
    //         return buffer.slice(start, (match.index ?? 0) + match[0].length + 200).trim();
    //       }
    //     }
    //     return null;
    //   },
    // },
    {
      name: "completion",
      detect(buffer) {
        const clean = stripAnsi(buffer);
        const lines = clean.split(/\r?\n/).filter(l => l.trim());
        if (lines.length === 0) return null;

        const lastLines = lines.slice(-5).join("\n");
        const patterns = [
          /(?:Task completed|All done|已完成|Done!)/i,
          /\$\s*$/m,
          /❯\s*$/m,
          /#\s*$/m,
        ];
        for (const p of patterns) {
          if (p.test(lastLines)) {
            return `终端输出可能表示完成:\n${lastLines.slice(-500)}`;
          }
        }
        return null;
      },
    },
  ];
}

// ─── 屏幕稳定性检测器 ───

export class ScreenStabilityDetector {
  private lastHash = "";
  private stableSince = 0;
  private stableDurationMs: number;

  constructor(options: { stableDurationMs?: number } = {}) {
    this.stableDurationMs = options.stableDurationMs ?? 10_000;
  }

  /** 每秒 tick 一次，返回 null 表示未触发，返回字符串则表示检测到稳定状态 */
  tick(screen: ScreenBuffer): string | null {
    const snapshot = screen.getTail(20);
    const hash = simpleHash(snapshot);
    const now = Date.now();

    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.stableSince = now;
      return null;
    }

    const stableDuration = now - this.stableSince;
    if (stableDuration >= this.stableDurationMs) {
      // 重置内部状态，避免重复触发
      this.lastHash = "";
      this.stableSince = 0;

      const text = screen.getText();
      return `[终端检测:smart_poll] 终端屏幕已 ${Math.round(stableDuration / 1000)} 秒无变化。请根据当前终端输出判断发生了什么：\n` +
        `- 是 Claude 在请求某项权限（y/n 询问）？\n` +
        `- 是任务已完成，需要交付？\n` +
        `- 是命令执行出错，需要介入？\n` +
        `- 还是 Claude 仍在工作中（有 spinner/进度条等动态内容），只是恰好暂停了？\n\n` +
        `当前终端屏幕内容:\n${text.slice(-3000)}`;
    }

    return null;
  }

  /** 重置内部状态（终端关闭/新任务开始时调用） */
  reset(): void {
    this.lastHash = "";
    this.stableSince = 0;
  }
}

// ─── 辅助函数 ───

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")   // CSI 序列
    .replace(/\x1b\][^\x07]*\x07/g, "")         // OSC 序列
    .replace(/\x1b[()][A-Za-z0-9]/g, "")         // 字符集选择
    .replace(/\r/g, "");
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}
