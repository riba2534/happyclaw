#!/usr/bin/env node
// ==============================================================================
// HappyClaw 业务就绪 (Readiness) 轮询等待工具
// 用于生产部署后等待系统业务完全就绪（DB、数据恢复、消费者队列、启用渠道连接）
// ==============================================================================

import http from 'http';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    host: '127.0.0.1',
    port: 3000,
    timeout: 60,
    interval: 2,
    allowDegraded: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && args[i + 1]) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--host' && args[i + 1]) {
      options.host = args[++i];
    } else if (arg === '--timeout' && args[i + 1]) {
      options.timeout = parseInt(args[++i], 10);
    } else if (arg === '--interval' && args[i + 1]) {
      options.interval = parseInt(args[++i], 10);
    } else if (arg === '--strict') {
      options.allowDegraded = false;
    }
  }
  return options;
}

function fetchReadiness(host, port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: '/api/health/readiness',
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            resolve({ statusCode: res.statusCode, data, err: null });
          } catch {
            resolve({
              statusCode: res.statusCode,
              data: null,
              err: 'Invalid JSON',
            });
          }
        });
      },
    );

    req.on('error', (err) => {
      resolve({ statusCode: 0, data: null, err: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 0, data: null, err: 'Request timeout' });
    });
  });
}

async function main() {
  const opts = parseArgs();
  const deadline = Date.now() + opts.timeout * 1000;

  console.log(
    `[Readiness] 开始等待 HappyClaw 服务就绪 (http://${opts.host}:${opts.port}/api/health/readiness, 超时: ${opts.timeout}s)...`,
  );

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const { statusCode, data, err } = await fetchReadiness(
      opts.host,
      opts.port,
    );

    if (data) {
      const isReady =
        data.status === 'ready' ||
        (opts.allowDegraded && data.status === 'degraded');
      if (isReady) {
        console.log(
          `[Readiness] ✅ 服务业务已就绪！(状态: ${data.status}, 耗时: ${(attempt * opts.interval).toFixed(1)}s)`,
        );
        console.log(`[Readiness] 摘要: ${data.summary}`);
        if (data.phases?.channels?.items?.length) {
          const summary = data.phases.channels.items
            .map((c) => `${c.name}(${c.provider}): ${c.status}`)
            .join(' | ');
          console.log(`[Readiness] 渠道明细: ${summary}`);
        }
        process.exit(0);
      } else {
        process.stdout.write(
          `[Readiness] 等待就绪... (尝试 #${attempt}, 状态: ${data.status}, 原因: ${data.summary})\r`,
        );
      }
    } else {
      process.stdout.write(
        `[Readiness] 等待服务响应... (尝试 #${attempt}, 原因: ${err || `HTTP ${statusCode}`})\r`,
      );
    }

    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }

  console.error(`\n[Readiness] ❌ 超时 (${opts.timeout}s) 未能达到就绪状态！`);
  const finalCheck = await fetchReadiness(opts.host, opts.port);
  if (finalCheck.data) {
    console.error(
      `[Readiness] 最终报告: ${JSON.stringify(finalCheck.data, null, 2)}`,
    );
  }
  process.exit(1);
}

main();
