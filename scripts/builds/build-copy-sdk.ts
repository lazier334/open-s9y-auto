import { createCopy } from "../utils/build.ts";

const FROM_DIR = '.temp/open-s9y/sdk';
const TARGET_DIR = 'examples/sdk';

export default createCopy(FROM_DIR, TARGET_DIR, 'open-s9y 的 sdk 已复制到 ${to}')