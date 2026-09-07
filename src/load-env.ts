import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

// --- Release Root Bootstrap ---
// 在加载任何业务逻辑前，识别并锚定不可变版本根，防止老进程因符号链接切换而混版
try {
  const currentFilePath = fs.realpathSync(fileURLToPath(import.meta.url));
  let dir = path.dirname(currentFilePath);
  let releaseRoot: string | null = null;
  let commitSha: string | null = null;

  for (let i = 0; i < 5; i++) {
    const vFile = path.join(dir, 'version.json');
    if (fs.existsSync(vFile)) {
      try {
        const v = JSON.parse(fs.readFileSync(vFile, 'utf8'));
        if (v.commitSha) {
          releaseRoot = dir;
          commitSha = v.commitSha;
          break;
        }
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (releaseRoot && commitSha) {
    process.env.HAPPYCLAW_BOOTSTRAP_SHA = commitSha;
    process.env.HAPPYCLAW_RELEASE_ROOT = releaseRoot;
    if (path.resolve(process.cwd()) !== path.resolve(releaseRoot)) {
      process.chdir(releaseRoot);
    }
  }
} catch {
  // 非版本化运行模式（如直接本地开发），保持默认当前工作目录
}

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
// 仅检 HTTP(S)_PROXY：EnvHttpProxyAgent 只读 HTTP_PROXY/HTTPS_PROXY（及 NO_PROXY），
// 不读 ALL_PROXY，且 undici 不支持 SOCKS。若把 ALL_PROXY 纳入守卫，仅配 ALL_PROXY 的
// 用户会构造出不做任何代理的 no-op agent，却打印「已启用代理」造成误导排障。
const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (proxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // logger 尚未初始化（本模块是最早的 import），用 console 输出一行启动提示。
    // 对代理串脱敏：去掉 userinfo（http://user:pass@host → http://***@host），避免凭据进日志。
    const safeProxy = proxy.replace(/\/\/[^/@]*@/, '//***@');
    console.log(
      `[load-env] 全局 fetch 已启用代理: ${safeProxy}（NO_PROXY=${process.env.NO_PROXY || process.env.no_proxy || '(默认)'}）`,
    );
  } catch (err) {
    console.warn(
      '[load-env] 设置全局 fetch 代理失败，server-side fetch 将直连:',
      err instanceof Error ? err.message : err,
    );
  }
}
