/**
 * ScreenBuffer — 基于 @xterm/headless 的无头终端模拟器
 *
 * 接收原始 PTY 输出（含 ANSI 转义码），内部维护一个字符网格，
 * 提供当前屏幕的纯文本渲染结果。
 *
 * spinner、progress bar、光标移动等动画效果会被正确"渲染"到网格中，
 * 读出的文本是稳定画面，不会有乱码或残影。
 *
 * 注意：@xterm/headless 只提供 CJS 入口，需用 createRequire 加载。
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export class ScreenBuffer {
  private term: Terminal;
  private cols: number;
  private rows: number;

  constructor(cols = 200, rows = 50) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: false,
    });
  }

  /** 写入原始 ANSI 数据（异步，等待终端解析完成） */
  async write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.term.write(data, () => resolve());
    });
  }

  /** 获取当前屏幕的纯文本内容 */
  getText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    // 去除尾部空行
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  /** 获取最近 N 行 */
  getTail(n: number): string {
    const text = this.getText();
    const lines = text.split("\n");
    return lines.slice(-n).join("\n");
  }

  /** 调整大小 */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
  }

  /** 清理 */
  dispose(): void {
    this.term.dispose();
  }
}
