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
const { getFileRoot, safeReadWorkspaceFileText } =
  await import('../src/file-manager.js');
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

  test('流背压与取消：零读取与慢读取下内存严格有界，取消时底层子进程被彻底销毁无泄漏', async () => {
    const relPath = 'stream-cancel-test.dat';
    const filePath = path.join(workspaceDir, relPath);
    // 写入 64MB 稀疏测试文件
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, Buffer.from('START'), 0, 5, 0);
    fs.writeSync(fd, Buffer.from('END'), 0, 3, 64 * 1024 * 1024 - 3);
    fs.closeSync(fd);

    const { safeOpenWorkspaceReadStream } =
      await import('../src/file-manager.js');

    const memBefore = process.memoryUsage();
    const readResult = await safeOpenWorkspaceReadStream(folder, relPath);
    const pid = readResult.processPid;
    expect(pid).toBeDefined();

    // 零消费者读取：等待 150ms，验证有界背压使得底层 Python 子进程暂停，绝不在无读取时吞吐全部 64MB
    await new Promise((r) => setTimeout(r, 150));

    // 验证子进程此时仍存活（被内核管道缓冲区背压暂停）
    expect(() => process.kill(pid!, 0)).not.toThrow();

    const memAfterPause = process.memoryUsage();
    // 关键安全断言：流内存有稳定上限，零消费时 ArrayBuffer 增量必须极小（不超过 512KB），绝不能暴涨几十 MB
    const abGrowth = memAfterPause.arrayBuffers - memBefore.arrayBuffers;
    expect(abGrowth).toBeLessThan(512 * 1024);

    const reader = readResult.stream.getReader();
    // 读出首块 chunk
    const first = await reader.read();
    expect(first.value).toBeDefined();

    // 主动取消流（不调用显式 readResult.destroy()，直接取消 WebStream）
    await reader.cancel('client aborted');

    // 等待 100ms
    await new Promise((r) => setTimeout(r, 100));

    // 确凿断言：底层子进程必须已被销毁，向其发信号必然抛出 ESRCH 错误！
    let processDead = false;
    try {
      process.kill(pid!, 0);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        processDead = true;
      }
    }
    expect(processDead).toBe(true);
  });

  test('并发截断防御（safeReadWorkspaceFileText）：文本读取途中底层文件被截断，必须拒绝抛错', async () => {
    const relPath = 'concurrent-truncate-text.txt';
    const filePath = path.join(workspaceDir, relPath);
    // 写入 2MB 数据
    fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 'X'));

    const { safeOpenWorkspaceReadStream } =
      await import('../src/file-manager.js');
    // 启动安全读取：获取元数据后
    const res = await safeOpenWorkspaceReadStream(folder, relPath);
    expect(res.size).toBe(2 * 1024 * 1024);

    // 在消费数据前或中途立即将文件截断为 100 字节
    fs.truncateSync(filePath, 100);

    const reader = res.stream.getReader();
    let errored = false;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      errored = true;
      expect(err).toBeDefined();
    } finally {
      res.destroy();
    }
    // 必须向调用方传播 stream error，绝不静默假装成功读取！
    expect(errored).toBe(true);
  });

  test('并发截断防御（WebStream 真实流下载）：慢消费者读取途中底层文件被截断，WebStream 必须触发 stream error', async () => {
    const relPath = 'concurrent-truncate-stream.dat';
    const filePath = path.join(workspaceDir, relPath);
    // 写入 2MB 数据
    fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 'Y'));

    const encoded = encodePath(relPath);
    const res = await filesRoutes.request(
      `/${encodeURIComponent(jid)}/files/download/${encoded}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    // 读出首块 chunk
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);

    // 慢消费者模拟：在读取中途，外部进程将底层文件截断为 50 字节
    fs.truncateSync(filePath, 50);

    // 继续消费流，必须触发 stream error，绝不能正常且无错地返回 done: true！
    let streamErrored = false;
    try {
      while (true) {
        const next = await reader!.read();
        if (next.done) break;
      }
    } catch (err) {
      streamErrored = true;
    }
    expect(streamErrored).toBe(true);
  });
});
