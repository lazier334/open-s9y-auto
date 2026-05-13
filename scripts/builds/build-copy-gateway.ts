import fs from "node:fs";

const S9Y_DIR = ".temp/s9y/src";
const TARGET_DIR = "src";
var S9Y_SRC_DIR = S9Y_DIR;

export default async function main(BUILD_DIR: string) {
  S9Y_SRC_DIR = S9Y_DIR.replace('.temp', BUILD_DIR || 'build');

  if (!fs.existsSync(S9Y_SRC_DIR)) console.log("src 不存在", S9Y_SRC_DIR);
  if (!fs.statSync(S9Y_SRC_DIR).isDirectory()) console.log("src 不是一个文件夹", S9Y_SRC_DIR);
  fs.cpSync(S9Y_SRC_DIR, TARGET_DIR, { recursive: true, overwrite: true });

  console.log("复制完成。文件路径:", S9Y_SRC_DIR);
  return `open-s9y 的 src 已复制到 ${S9Y_SRC_DIR}`
}