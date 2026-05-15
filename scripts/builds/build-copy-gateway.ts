import { createCopy } from "../utils/build.ts";
import { join } from "node:path";

const FROM_DIR = '.temp/open-s9y';
const TARGET_DIR = 'gateway';
const selectFiles = ['src', 'sdk']

export default async function main(BUILD_DIR: string) {
  const funs = selectFiles.map(name => createCopy(join(FROM_DIR, name), join(TARGET_DIR, name), `open-s9y 的 ${name} 已复制到 \${to}`));
  const re = [];
  for (const fun of funs) re.push(await fun(BUILD_DIR));

  return re.join('\n');
}