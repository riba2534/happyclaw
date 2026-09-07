#!/usr/bin/env node
// ==============================================================================
// HappyClaw 业务就绪 (Readiness) 轮询等待工具 (R12 规范)
//
// 验证规则：
// 1. 严格检查 HTTP 状态码为 200；
// 2. 严格检查 body.ready === true；
// 3. 严格校验 --expected-sha：当传入预期 SHA 时，必须与服务返回的 currentSha 精确匹配；
//    防止旧版本服务未重启或仍处于旧就绪状态时造成假成功！
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
    expectedSha: null,
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
    } else if (arg === '--expected-sha' && args[i + 1]) {
      options.expectedSha = args[++i].trim();
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
    `[Readiness] 开始等待 HappyClaw 服务就绪 (http://${opts.host}:${opts.port}/api/health/readiness, 超时: ${opts.timeout}s, 预期 SHA: ${opts.expectedSha || '任意'})...`,
  );

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const { statusCode, data, err } = await fetchReadiness(
      opts.host,
      opts.port,
    );

    if (data && statusCode === 200) {
      const isStatusReady =
        data.status === 'ready' ||
        (opts.allowDegraded && data.status === 'degraded');
      const isReadyFlag = Boolean(data.ready);

      // SHA 校验
      let shaMatched = true;
      if (opts.expectedSha) {
        shaMatched = Boolean(
          data.currentSha &&
          (data.currentSha === opts.expectedSha ||
            data.currentSha.startsWith(opts.expectedSha) ||
            opts.expectedSha.startsWith(data.currentSha)),
        );
      }

      if (isStatusReady && isReadyFlag && shaMatched) {
        console.log(
          `[Readiness] ✅ 服务业务已就绪！(状态: ${data.status}, SHA: ${data.currentSha || 'unknown'}, 耗时: ${(attempt * opts.interval).toFixed(1)}s)`,
        );
        console.log(`[Readiness] 摘要: ${data.summary}`);
        process.exit(0);
      } else {
        const reason = !shaMatched
          ? `版本尚未更新 (当前: ${data.currentSha || 'unknown'}, 预期: ${opts.expectedSha})`
          : !isReadyFlag
            ? 'ready 标志为 false'
            : `状态为 ${data.status}`;
        process.stdout.write(
          `[Readiness] 等待就绪... (尝试 #${attempt}, 原因: ${reason})\r`,
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
