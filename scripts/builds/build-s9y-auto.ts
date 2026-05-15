import { zipDir } from "../utils/zip.ts";
import { createCopy } from "../utils/build.ts";
import path from "node:path";
import fs from "node:fs";

const FROM_DIR = './';
const TARGET_DIR = ".temp/open-s9y-auto";
const selectFiles = ['examples', 'gateway', 'scripts',
    'LICENSE', 'package.json', 'package-lock.json', 'README.md'];

export default async function main(BUILD_DIR: string) {
    const funs = fs.readdirSync(FROM_DIR).filter(name => selectFiles.includes(name))
        .map(name => createCopy(path.join(FROM_DIR, name), path.join(TARGET_DIR, name), `open-s9y-auto 的 ${name} 已复制到 \${to}`));
    const re: string[] = [];
    for (const fun of funs) re.push(await fun(BUILD_DIR));

    const archivePath = TARGET_DIR.replace('.temp', BUILD_DIR || 'build') + '.zip';
    const result = await zipDir(archivePath.slice(0, archivePath.length - '.zip'.length), archivePath);
    if (result.success) re.push(`open-s9y-auto 打包完成: ${archivePath} (${result.sizeKB} KB)`);
    else re.push(`open-s9y-auto 打包失败: ${result.error}`);

    return re.join('\n');
}