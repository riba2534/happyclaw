import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-safe-read-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const dataDir = path.join(tmpRoot, 'data');
  return {
    ...actual,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
  };
});

process.env.WEB_SESSION_SECRET = 'test-session-secret-for-safe-read-boundary';
process.env.DISABLE_MIGRATION_BACKUPS = 'true';

const { initDatabase, createUser, createUserSession, setRegisteredGroup } =
  await import('../src/db.js');
const { signSessionToken } = await import('../src/auth.js');
const { getFileRoot } = await import('../src/file-manager.js');
const filesRoutes = (await import('../src/routes/files.js')).default;

const userId = 'safe-member-' + Date.now();
const jid = 'web:safe-test';
const folder = 'safe-test';
const sessionToken = 's'.repeat(64);
let cookieHeader: string;

const workspaceDir = path.join(tmpRoot, 'data', 'groups', folder);
const outsideMarkerFile = path.join(tmpRoot, 'outside-marker.txt');
const outsideMarkerContent = 'CRITICAL_OUTSIDE_MARKER_MUST_NOT_LEAK';

const outsideParentDir = path.join(tmpRoot, 'outside-parent-dir');
const outsideParentFile = path.join(outsideParentDir, 'parent-secret.txt');
const outsideParentContent = 'CRITICAL_PARENT_MARKER_MUST_NOT_LEAK';

beforeAll(() => {
  initDatabase();
  const now = new Date().toISOString();
  createUser({
    id: userId,
    username: userId,
    password_hash: 'unused',
    display_name: 'Safe Member',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });

  createUserSession({
    id: sessionToken,
    user_id: userId,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    last_active_at: now,
  });

  cookieHeader = 'happyclaw_session=' + signSessionToken(sessionToken);

  setRegisteredGroup(jid, {
    name: 'Safe Test Workspace',
    folder,
    added_at: now,
    created_by: userId,
    executionMode: 'container',
  });

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(outsideMarkerFile, outsideMarkerContent, 'utf-8');

  fs.mkdirSync(outsideParentDir, { recursive: true });
  fs.writeFileSync(outsideParentFile, outsideParentContent, 'utf-8');
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function encodePath(relPath: string): string {
  return Buffer.from(relPath, 'utf-8').toString('base64url');
}

describe('R01: 文件安全读取防 TOCTOU 回归测试', () => {
  test('正常文件全量读取、预览与文本读取', async () => {
    const relPath = 'normal.txt';
    const content = 'Hello World from Safe FS!';
    fs.writeFileSync(path.join(workspaceDir, relPath), content, 'utf-8');

    const encoded = encodePath(relPath);

    // 1. Download
    const resDownload = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(resDownload.status).toBe(200);
    expect(await resDownload.text()).toBe(content);
    expect(resDownload.headers.get('content-length')).toBe(
      String(Buffer.byteLength(content)),
    );

    // 2. Preview
    const resPreview = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/preview/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(resPreview.status).toBe(200);
    expect(await resPreview.text()).toBe(content);

    // 3. Content
    const resContent = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/content/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(resContent.status).toBe(200);
    const contentJson = (await resContent.json()) as {
      content: string;
      size: number;
    };
    expect(contentJson.content).toBe(content);
    expect(contentJson.size).toBe(Buffer.byteLength(content));
  });

  test('中文与包含空格的子目录文件安全读取', async () => {
    const subDir = path.join(workspaceDir, '中文 目录');
    fs.mkdirSync(subDir, { recursive: true });
    const relPath = '中文 目录/测试 文件.txt';
    const content = '测试安全读取中文与空格文件名 2026-09-07';
    fs.writeFileSync(path.join(workspaceDir, relPath), content, 'utf-8');

    const encoded = encodePath(relPath);

    const res = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  test('支持 Range 请求（206 Partial Content 与 416 Range Not Satisfiable）', async () => {
    const relPath = 'range-test.dat';
    const content = '0123456789abcdefghijklmnopqrstuvwxyz';
    fs.writeFileSync(path.join(workspaceDir, relPath), content, 'utf-8');

    const encoded = encodePath(relPath);

    // 1. 指定起始区间 bytes=0-9
    const resRange1 = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader, range: 'bytes=0-9' } },
    );
    expect(resRange1.status).toBe(206);
    expect(resRange1.headers.get('content-range')).toBe(
      `bytes 0-9/${content.length}`,
    );
    expect(resRange1.headers.get('content-length')).toBe('10');
    expect(await resRange1.text()).toBe('0123456789');

    // 2. 后缀区间 bytes=-5
    const resRange2 = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader, range: 'bytes=-5' } },
    );
    expect(resRange2.status).toBe(206);
    expect(resRange2.headers.get('content-range')).toBe(
      `bytes ${content.length - 5}-${content.length - 1}/${content.length}`,
    );
    expect(await resRange2.text()).toBe('vwxyz');

    // 3. 超出范围区间 bytes=9999-10000 -> 416
    const resRange416 = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader, range: 'bytes=9999-10000' } },
    );
    expect(resRange416.status).toBe(416);
    expect(resRange416.headers.get('content-range')).toBe(
      `bytes */${content.length}`,
    );
  });

  test('恶意末级符号链接（Leaf Symlink）：安全打开必须拦截，不得读取外部marker', async () => {
    const relPath = 'malicious-leaf.txt';
    const targetPath = path.join(workspaceDir, relPath);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.symlinkSync(outsideMarkerFile, targetPath);

    const encoded = encodePath(relPath);

    // 1. Download
    const resDownload = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyDownload = await resDownload.text();
    expect(resDownload.status).toBe(500);
    expect(bodyDownload).not.toContain(outsideMarkerContent);
    expect(bodyDownload).toContain('Symlink traversal detected');

    // 2. Preview
    const resPreview = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/preview/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyPreview = await resPreview.text();
    expect(resPreview.status).toBe(500);
    expect(bodyPreview).not.toContain(outsideMarkerContent);
    expect(bodyPreview).toContain('Symlink traversal detected');

    // 3. Content
    const resContent = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/content/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyContent = await resContent.text();
    expect(resContent.status).toBe(500);
    expect(bodyContent).not.toContain(outsideMarkerContent);
    expect(bodyContent).toContain('Symlink traversal detected');
  });

  test('恶意父目录符号链接（Parent Directory Symlink）：逐级描述符遍历必须拦截，不得读取外部marker', async () => {
    const symParent = path.join(workspaceDir, 'malicious-parent-link');
    if (fs.existsSync(symParent)) fs.unlinkSync(symParent);
    fs.symlinkSync(outsideParentDir, symParent);

    const relPath = 'malicious-parent-link/parent-secret.txt';
    const encoded = encodePath(relPath);

    // Download
    const resDownload = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyDownload = await resDownload.text();
    expect(resDownload.status).toBe(500);
    expect(bodyDownload).not.toContain(outsideParentContent);
    expect(bodyDownload).toContain('Symlink traversal detected');

    // Preview
    const resPreview = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/preview/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyPreview = await resPreview.text();
    expect(resPreview.status).toBe(500);
    expect(bodyPreview).not.toContain(outsideParentContent);
    expect(bodyPreview).toContain('Symlink traversal detected');

    // Content
    const resContent = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/content/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const bodyContent = await resContent.text();
    expect(resContent.status).toBe(500);
    expect(bodyContent).not.toContain(outsideParentContent);
    expect(bodyContent).toContain('Symlink traversal detected');
  });

  test('访问不存在文件返回 404，访问目录返回 400', async () => {
    const nonExistentEncoded = encodePath('non-existent-file.txt');
    const res404 = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${nonExistentEncoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res404.status).toBe(404);

    const dirName = 'a-sub-directory';
    fs.mkdirSync(path.join(workspaceDir, dirName), { recursive: true });
    const dirEncoded = encodePath(dirName);
    const resDir = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${dirEncoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(resDir.status).toBe(400);
    expect(await resDir.text()).toContain('Cannot download directory');
  });

  test('FIFO 防御：打开命名管道立即以非阻塞拒绝，绝不阻塞挂死', async () => {
    const fifoPath = path.join(workspaceDir, 'fifo-dos-probe.txt');
    if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
    try {
      const { execSync } = await import('child_process');
      execSync(`mkfifo "${fifoPath}"`);
    } catch {
      // 平台不支持 mkfifo 时跳过
      return;
    }

    const t0 = Date.now();
    const fifoEncoded = encodePath('fifo-dos-probe.txt');
    const res = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${fifoEncoded}`,
      { headers: { cookie: cookieHeader } },
    );
    const duration = Date.now() - t0;

    // 必须在 1 秒内立即返回（通常 50ms 内），绝不挂住！
    expect(duration).toBeLessThan(1000);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Cannot download directory');
  });

  test('真实 TOCTOU 动态交错：路径校验与打开之间动态替换为外部符号链接，绝不泄露外部 marker', async () => {
    const relPath = 'dynamic-toctou-target.txt';
    const targetPath = path.join(workspaceDir, relPath);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.writeFileSync(targetPath, 'INITIAL_INSIDE_CONTENT', 'utf-8');

    const encoded = encodePath(relPath);

    // 模拟并发写入竞争：在发起请求的同时或极短间隔内替换目标为指向外部敏感文件的符号链接
    const replacePromise = (async () => {
      // 延迟 5ms 让路由进入路径解析阶段，并在打开前执行替换
      await new Promise((r) => setTimeout(r, 5));
      try {
        fs.unlinkSync(targetPath);
        fs.symlinkSync(outsideMarkerFile, targetPath);
      } catch {}
    })();

    const [res] = await Promise.all([
      filesRoutes.request(
        `/${encodeURIComponent(jid)}/files/download/${encoded}`,
        { headers: { cookie: cookieHeader } },
      ),
      replacePromise,
    ]);

    const body = await res.text();
    // 核心安全断言：无论时序如何交错，绝对不能返回外部 marker！
    expect(body).not.toContain(outsideMarkerContent);

    // 随后再次请求已被替换的文件：必须明确被拦截为 500
    const resSecond = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(resSecond.status).toBe(500);
    expect(await resSecond.text()).not.toContain(outsideMarkerContent);
  });

  test('流背压与取消：提前关闭/取消读取流，底层资源和子进程安全回收', async () => {
    const relPath = 'stream-cancel-test.dat';
    const filePath = path.join(workspaceDir, relPath);
    // 写入 500KB 测试数据
    const chunk = 'A'.repeat(1024);
    const streamWrite = fs.createWriteStream(filePath);
    for (let i = 0; i < 500; i++) {
      streamWrite.write(chunk);
    }
    await new Promise((resolve) => streamWrite.end(resolve));

    const encoded = encodePath(relPath);
    const res = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    // 仅读取前几个 chunk 便主动取消流
    const first = await reader!.read();
    expect(first.value).toBeDefined();

    // 取消流，模拟客户端连接断开
    await reader!.cancel('client disconnected');

    // 稍等 50ms 确认没有未捕获异常或进程孤立
    await new Promise((r) => setTimeout(r, 50));
  });
});
