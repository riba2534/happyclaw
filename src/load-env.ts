/**
 * .env 预加载器
 *
 * 通过 --import 标志在主模块加载前执行，确保 .env 中的变量在所有模块初始化时可用。
 * 在原生 ESM 中，静态 import 声明会被提升，模块体代码在所有导入模块求值完毕后才运行，
 * 因此不能在主模块内用普通代码加载 .env——必须通过 --import 预加载。
 *
 * 用法：
 *   node --import ./dist/load-env.js dist/index.js     # 生产环境
 *   tsx  --import ./src/load-env.ts  src/index.ts      # 开发环境
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dotenvPath = resolve(process.cwd(), '.env');

if (existsSync(dotenvPath)) {
  for (const line of readFileSync(dotenvPath, 'utf-8').split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 支持 `export KEY=VALUE` 格式
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7);
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 剥除外层引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 不覆盖已有环境变量（显式传入的环境变量优先级更高）
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
