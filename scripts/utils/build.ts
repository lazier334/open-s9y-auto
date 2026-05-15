import fs from "node:fs";

/**
 * 创建匿名复制函数，会自动把 `第一个.temp` 替换成 `外部传入的文件夹路径或 build` 
 * @param FROM_DIR 
 * @param TO_DIR 
 * @param reMsg 返回的消息，如果不是string类型就会被忽略，可以使用 `${from}` 标记源路径 `${to}` 标记目标路径
 * @returns 
 */
export function createCopy(FROM_DIR: string, TO_DIR: string, reMsg: any = '已复制: ${to}') {
    return (
        /**
         * 匿名复制函数，会自动把 `第一个.temp` 替换成 `外部传入的文件夹路径或 build` 
         * @param BUILD_DIR 构建的文件夹名称
         * @returns 报错或复制结果
         */
        async (BUILD_DIR: string) => {
            TO_DIR = TO_DIR.replace('.temp', BUILD_DIR || 'build');
            if (fs.existsSync(TO_DIR) && !fs.statSync(TO_DIR).isDirectory()) throw new Error("目标不是一个文件夹: " + TO_DIR);
            fs.cpSync(FROM_DIR, TO_DIR, { recursive: true, force: true });
            if (process.env.IGNORE_BUILD_LOGS == 'true') return;
            return typeof reMsg != 'string' ? reMsg : reMsg.replaceAll('${from}', FROM_DIR).replaceAll('${to}', TO_DIR);
        }
    )
}