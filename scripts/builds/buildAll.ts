import fs from "node:fs";
import path from "node:path";

const BUILD_DIR = 'build';
// 打包成功后的其他提示信息
const manualProcessingItems: string[] = [
    // '需要手动去修改的其他项'
];

// 使用的打包插件列表
const moduleList = [
    "build-s9y.ts",
    "build-copy-sdk.ts",
    "build-copy-gateway.ts",
    "build-s9y-auto.ts",
];

(async function (mList) {
    let procedure = 1;
    let README = [];
    console.log(`\n\x1b[34m\x1b[47m----- 正在清理旧资源 -----\x1b[0m`);
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    console.log(`\n\x1b[34m\x1b[47m----- 开始打包 -----\x1b[0m`);
    for (const filename of mList) {
        if (filename) {
            console.log(`\n\x1b[34m\x1b[47m----- 第${procedure++}步运行 ${filename} -----\x1b[0m`);
            let fun = (await import("./" + filename));
            fun = fun.default || fun;
            if (typeof fun == "function") fun = await fun(BUILD_DIR);
            console.log('fun', fun)
            if (typeof fun == 'string') {
                README.push(fun);
            }
        }
    }
    const README_INFO = `打包完成！
打包时间: ${new Date().toLocaleString('zh-CN')}
打包项目: ${fs.readdirSync(BUILD_DIR).filter(name => fs.statSync(path.join(BUILD_DIR, name)).isFile()).length}/${mList.length} (正常值: 2/4, 打包结果总数/脚本总数)
当前open-s9y的版本号: ${readS9yVersion()}

${README.map(e => e.trim()).filter(e => e != '').join('\n')}`;
    fs.writeFileSync(path.join(BUILD_DIR, 'README.md'), README_INFO);

    console.log(`\n\x1b[34m\x1b[47m----- 打包结束${manualProcessingItems.length < 1 ? '' : `，请手动处理剩余的${manualProcessingItems.length}项`} -----\x1b[0m`);
    console.info(README_INFO);
    console.log('');
    console.info(manualProcessingItems.map((v, i) => `${i + 1}. ${v}`).join('\n'));
    console.log('');
    process.exit(0);
})(moduleList)


function readS9yVersion() {
    let re = '-';
    try {
        let packageJson = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'open-s9y/package.json'), { encoding: 'utf8' }));
        re = packageJson.version;
    } catch (err) {
        console.error('读取open-s9y的版本失败!');
        console.log(err);
    }
    return re;
}