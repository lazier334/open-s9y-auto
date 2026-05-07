import fs from "node:fs";

const S9Y_DIR = ".temp/s9y/sdk";
var S9Y_SDK_DIR = S9Y_DIR;
const TARGET_DIR = "examples/sdk";

export default async function main(BUILD_DIR: string) {
  S9Y_SDK_DIR = S9Y_DIR.replace('.temp', BUILD_DIR || 'build');

  if (!fs.existsSync(S9Y_SDK_DIR)) console.log("sdk 不存在", S9Y_SDK_DIR);
  if (!fs.statSync(S9Y_SDK_DIR).isDirectory()) console.log("sdk 不是一个文件夹", S9Y_SDK_DIR);
  fs.cpSync(S9Y_SDK_DIR, TARGET_DIR, { recursive: true, overwrite: true });

  console.log("复制完成。文件路径:", S9Y_SDK_DIR);
  return `open-s9y 的 sdk 已复制到 ${S9Y_SDK_DIR}`
}