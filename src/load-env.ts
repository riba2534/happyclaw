// 在任何其它模块读取 process.env 之前，把项目根目录的 .env 加载进环境变量。
// 自托管部署用 .env 配置 CORS_ALLOWED_ORIGINS（公网域名白名单）、自定义 env 等。
// 必须作为 index.ts 的第一个 import，确保 config.ts / web.ts 在求值时已能读到这些值。
// 缺少 .env 文件属正常情况（所有 env 均有默认值），静默忽略。
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

try {
  // process.loadEnvFile() 读取 cwd 下的 .env（Node 20.12+ / 21.7+ 起稳定）。
  process.loadEnvFile();
} catch {
  /* 无 .env 文件，跳过 */
}

// 让后端的 Node 全局 fetch（undici）走系统代理。
// undici 默认【不读】HTTP_PROXY/HTTPS_PROXY 环境变量，导致 server-side fetch
// （如官方 Claude OAuth 交换 https://api.anthropic.com/v1/oauth/token、连通性测试）
// 用裸出口 IP 直连。在大陆裸 IP 会被 Anthropic 以 403 {"type":"forbidden",
// "message":"Request not allowed"} 拒绝。这里在最早时机设置一次全局 dispatcher，
// EnvHttpProxyAgent 会读取 HTTP_PROXY/HTTPS_PROXY 并遵守 NO_PROXY（localhost 等不走代理）。
// 仅当配置了代理时启用，未配置则保持默认行为（no-op）。失败不阻断启动。
const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy;
if (proxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // logger 尚未初始化（本模块是最早的 import），用 console 输出一行启动提示。
    console.log(
      `[load-env] 全局 fetch 已启用代理: ${proxy}（NO_PROXY=${process.env.NO_PROXY || process.env.no_proxy || '(默认)'}）`,
    );
  } catch (err) {
    console.warn(
      '[load-env] 设置全局 fetch 代理失败，server-side fetch 将直连:',
      err instanceof Error ? err.message : err,
    );
  }
}
