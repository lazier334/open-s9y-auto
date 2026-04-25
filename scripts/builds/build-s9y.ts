import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { zipDir } from "../utils/zip.ts";

const TARGET_REPO = "https://github.com/lazier334/open-s9y.git";
const S9Y_DIR = ".temp/s9y";
var S9Y_BUILD_DIR = S9Y_DIR;

function getGitHash(dir: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function getRemoteHash(): string {
  const output = execSync(`git ls-remote ${TARGET_REPO} HEAD`, {
    encoding: "utf-8",
  }).trim();
  return output.split("\t")[0];
}

function cloneRepo() {
  console.log("正在克隆 open-s9y...");
  if (fs.existsSync(S9Y_DIR)) {
    fs.rmSync(S9Y_DIR, { recursive: true, force: true });
  }
  execSync(`git clone --depth=1 ${TARGET_REPO} ${S9Y_DIR}`, {
    stdio: "inherit",
  });
}

function pullRepo() {
  console.log("正在拉取最新更改...");
  execSync("git pull", {
    cwd: S9Y_DIR,
    stdio: "inherit",
  });
}

function copyToBuild() {
  console.log("正在复制 s9y 到 build...");
  if (fs.existsSync(S9Y_BUILD_DIR)) {
    fs.rmSync(S9Y_BUILD_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(S9Y_BUILD_DIR, { recursive: true });
  fs.cpSync(S9Y_DIR, S9Y_BUILD_DIR, { recursive: true });
}

function extractGateway() {
  console.log("正在提取 s9y...");
  const removeFiles = ['examples', '.gitignore'];
  if (fs.existsSync(S9Y_BUILD_DIR)) {
    fs.readdirSync(S9Y_BUILD_DIR).forEach(name => {
      if (removeFiles.includes(name)) {
        fs.rmSync(path.join(S9Y_BUILD_DIR, name), {
          recursive: true,
          force: true
        });
      }
    })
  }
}

export default async function main(BUILD_DIR: string) {
  S9Y_BUILD_DIR = S9Y_DIR.replace('.temp', BUILD_DIR || 'build');
  console.log("正在检查 open-s9y 的更新...");

  const remoteHash = getRemoteHash();
  console.log(`远程 hash: ${remoteHash}`);

  let localHash: string | null = null;
  if (fs.existsSync(S9Y_DIR)) {
    localHash = getGitHash(S9Y_DIR);
    console.log(`本地 hash:  ${localHash}`);
  }

  if (!localHash) {
    console.log("本地仓库不存在，正在克隆...");
    cloneRepo();
  } else if (localHash !== remoteHash) {
    console.log("检测到更新！");
    pullRepo();
  } else {
    console.log("未检测到更新。");
  }

  copyToBuild();
  extractGateway();
  console.log("构建完成。文件路径:", S9Y_BUILD_DIR);

  const archivePath = `${S9Y_BUILD_DIR}.zip`;
  const result = await zipDir(S9Y_BUILD_DIR, archivePath);
  let msg;
  if (result.success) {
    msg = `open-s9y 打包完成: ${archivePath} (${result.sizeKB} KB)`;
  } else {
    msg = `open-s9y 打包失败: ${result.error}`;
  }

  return `open-s9y 当前版本: ${getGitHash(S9Y_DIR)}\n${msg}`
}