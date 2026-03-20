/**
 * SQLite 兼容层：Bun 用 bun:sqlite，Node.js 用 better-sqlite3
 *
 * 两者 API 几乎一致（prepare/run/get/all/exec/transaction），
 * 唯一差异是 import 路径和 pragma() 方法（Bun 无此方法，用 exec 替代）。
 */

const isBun = typeof (globalThis as any).Bun !== 'undefined';

let DatabaseConstructor: new (path: string) => any;

if (isBun) {
  // 动态字符串阻止 tsc 尝试解析 bun:sqlite 模块
  const modName = 'bun:sqlite';
  const mod = await import(modName);
  DatabaseConstructor = mod.Database;
} else {
  const mod = await import('better-sqlite3');
  DatabaseConstructor = mod.default;
}

export default DatabaseConstructor;
