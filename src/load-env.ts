// 在任何其它模块读取 process.env 之前，把项目根目录的 .env 加载进环境变量。
// 自托管部署用 .env 配置 CORS_ALLOWED_ORIGINS（公网域名白名单）、自定义 env 等。
// 必须作为 index.ts 的第一个 import，确保 config.ts / web.ts 在求值时已能读到这些值。
// 缺少 .env 文件属正常情况（所有 env 均有默认值），静默忽略。
try {
  // process.loadEnvFile() 读取 cwd 下的 .env（Node 20.12+ / 21.7+ 起稳定）。
  process.loadEnvFile();
} catch {
  /* 无 .env 文件，跳过 */
}
