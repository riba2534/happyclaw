import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'config',
  'oms-bkboole-review.json',
);
const DEFAULT_URL = 'https://oms.bkboole.com/oms/#/';
const CAPTCHA_MAP = {
  '2.jpg': '1127',
  '3.jpg': '3925',
  '5.jpg': '6727',
  '7.jpg': '8868',
  '8.jpg': '9332',
  '9.jpg': '6920',
  '10.jpg': '6920',
  '11.jpg': '6920',
  '12.jpg': '4920',
};
const DEFAULT_QUERY =
  '哈佛大学；耶鲁大学；哥伦比亚大学；普林斯顿大学；麻省理工学院；斯坦福大学；芝加哥大学；加州理工大学；杜克大学；宾夕法尼亚大学；约翰霍普金斯大学；美国国家科学院 ；美国国家工程院；美国国家医学科学院；美国国家学院；艾姆斯实验室；阿贡国家实验室；布鲁克黑文国家实验室；费米国家加速器实验室；弗雷德里克国家癌症研究实验室；爱达荷州国家实验室；劳伦斯·伯克利国家实验室；劳伦斯·利弗莫尔国家实验室；洛斯阿拉莫斯国家实验室；国家能源技术实验室；国家可再生能源实验室；橡树岭国家实验室；太平洋西北国家实验室；普林斯顿等离子体物理实验室；桑迪亚国家实验室；萨凡纳河国家实验室；SLAC国家加速器实验室；托马斯·杰斐逊（Thomas Jefferson）国家加速器设施；苹果；微软；亚马逊；谷歌；脸书；英特尔；Space X；甲骨文；Advanced Micro Devices；Alphabet；Cisco；Hewlett Packard Enterprise；HP；IBM；Intel(英特尔)；Nvidia';
const STRATEGIC_PATTERNS = [
  /国家实验室/u,
  /国家科学院/u,
  /国家工程院/u,
  /国家医学科学院/u,
  /national laborator/i,
  /\bllnl\b/i,
  /\bslac\b/i,
  /lincoln laboratory/i,
  /accelerator/i,
  /artemis/i,
  /lunar/i,
  /\bnasa\b/i,
  /moon mission/i,
  /plasma/i,
  /space/i,
];
const SKIP_PATTERNS = [
  /a day in the life/i,
  /events? calendar/i,
  /elected/i,
  /honou?rs?/i,
  /appoint/i,
  /joins?/i,
  /fellow/i,
  /director/i,
  /future of work/i,
  /your privacy choices/i,
  /lecture/i,
  /recap/i,
  /welcome/i,
  /class of/i,
  /podcast/i,
  /review:/i,
  /discount/i,
  /sale/i,
  /rumou?r/i,
  /tv /i,
  /credit cards?/i,
  /law/i,
  /tariffs?/i,
  /homestays?/i,
  /educators?/i,
  /students?/i,
  /service/i,
  /work[- ]in[- ]progress/i,
  /works for britain/i,
  /privacy/i,
  /video/i,
  /请稍候/u,
  /^loading/i,
  /^wait/i,
];
const PROGRESS_PATTERNS = [
  /research/i,
  /highlights/i,
  /innovation/i,
  /discover/i,
  /scient/i,
  /technology/i,
  /model/i,
  /\bai\b/i,
  /coding agent/i,
  /gpu/i,
  /chip/i,
  /inference/i,
  /quantum/i,
  /battery/i,
  /robot/i,
  /peer review/i,
  /satellite/i,
  /imaging/i,
  /framework/i,
  /internet/i,
  /drug discovery/i,
  /life sciences/i,
  /energy/i,
  /climate/i,
  /supply chain/i,
  /monitor/i,
  /intelligence/i,
  /lunar/i,
  /artemis/i,
  /accelerator/i,
  /plasma/i,
  /lab/i,
  /实验室/u,
  /科研/u,
  /研究/u,
  /创新/u,
  /技术/u,
  /模型/u,
  /智能/u,
  /卫星/u,
  /量子/u,
  /电池/u,
  /机器人/u,
];

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--config' && argv[i + 1]) {
      args.configPath = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = {
    url: raw.url || DEFAULT_URL,
    username: String(raw.username || '').trim(),
    password: String(raw.password || ''),
    query: String(raw.query || DEFAULT_QUERY).trim(),
    executablePath:
      raw.executablePath ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    maxPages: Number.isFinite(raw.maxPages) ? Number(raw.maxPages) : 20,
    recentDays: Number.isFinite(raw.recentDays) ? Number(raw.recentDays) : 2,
    headless: raw.headless !== false,
  };
  if (!config.username || !config.password || !config.query) {
    throw new Error(`Config is incomplete: ${configPath}`);
  }
  return config;
}

function parsePublishedAt(value) {
  const ts = Date.parse(String(value).replace(' ', 'T'));
  return Number.isNaN(ts) ? null : ts;
}

function isRecentEnough(publishedAt, recentDays) {
  const ts = parsePublishedAt(publishedAt);
  if (!ts) return false;
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  return ts >= cutoff;
}

function decideChannel(row) {
  const title = row.title || '';
  const source = row.source || '';
  const combined = `${title} ${source}`;
  if (SKIP_PATTERNS.some((pattern) => pattern.test(combined))) {
    return { submit: false, reason: 'skip-pattern' };
  }
  if (!row.canSubmit) {
    return { submit: false, reason: 'no-send-button' };
  }
  if (!isRecentEnough(row.publishedAt, row.recentDays)) {
    return { submit: false, reason: 'out-of-range' };
  }
  if (!PROGRESS_PATTERNS.some((pattern) => pattern.test(combined))) {
    return { submit: false, reason: 'not-tech-progress' };
  }
  const channel = STRATEGIC_PATTERNS.some((pattern) => pattern.test(combined))
    ? '战略科技力量'
    : '创新生态';
  return { submit: true, channel };
}

async function login(page, config) {
  await page.goto(config.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(3_000);
  await page.locator('input').nth(0).fill(config.username);
  await page.locator('input').nth(1).fill(config.password);
  const img = page.locator('img').first();
  const captchaInput = page.locator('input').nth(2);

  for (let i = 0; i < 60; i += 1) {
    const src = await img.getAttribute('src');
    const file = path.basename(src || '');
    const code = CAPTCHA_MAP[file];
    if (!code) {
      await img.click();
      await page.waitForTimeout(250);
      continue;
    }
    await captchaInput.fill(code);
    await page.getByText('登录', { exact: true }).click();
    await page.waitForTimeout(2_500);
    if ((await page.locator('body').innerText()).includes('网站采集')) return;
    await img.click();
    await page.waitForTimeout(250);
  }

  throw new Error('Login failed after exhausting captcha refresh attempts');
}

async function runQuery(page, query) {
  await page.locator('input[placeholder="输入文章来源查找"]').first().fill(query);
  await page.getByRole('button', { name: '查询' }).first().click();
  await page.waitForTimeout(3_000);
}

async function collectRows(page, recentDays) {
  const rows = await page
    .locator('tbody tr')
    .evaluateAll(
      (trs, rd) =>
        trs.map((tr, idx) => {
          const tds = Array.from(tr.querySelectorAll('td')).map((td) =>
            (td.innerText || '').trim(),
          );
          return {
            index: idx,
            title: tds[2] || '',
            source: tds[3] || '',
            category: tds[4] || '',
            status: tds[5] || '',
            publishedAt: tds[6] || '',
            actionText: tds[7] || '',
            canSubmit: (tds[7] || '').includes('送审'),
            recentDays: rd,
          };
        }),
      recentDays,
    );
  return rows;
}

async function submitRow(page, row, channel, dryRun) {
  if (dryRun) return { ok: true, mode: 'dry-run' };
  const rows = page.locator('tbody tr');
  const count = await rows.count();
  let rowLocator = null;
  for (let i = 0; i < count; i += 1) {
    const candidate = rows.nth(i);
    const text = await candidate.innerText();
    if (text.includes(row.title) && text.includes(row.publishedAt)) {
      rowLocator = candidate;
      break;
    }
  }
  if (!rowLocator) {
    return { ok: false, mode: 'row-not-found', detail: row.title };
  }
  const sendButton = rowLocator.getByText('送审', { exact: true });
  if (!(await sendButton.count())) {
    return { ok: false, mode: 'no-send-button', detail: row.title };
  }
  await sendButton.click();
  const dialog = page.getByRole('dialog', { name: '送审' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.locator('input').nth(0).click();
  const option = page
    .locator('.el-select-dropdown:visible .el-select-dropdown__item')
    .filter({ hasText: channel })
    .first();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();
  await dialog.getByRole('button', { name: '确定' }).click();
  await page.waitForTimeout(2_500);
  const dialogStillVisible = await dialog.isVisible().catch(() => false);
  if (dialogStillVisible) {
    const body = await dialog.innerText();
    return { ok: false, mode: 'blocked', detail: body };
  }
  return { ok: true, mode: 'submitted' };
}

async function gotoNextPage(page) {
  const nextButton = page.locator('.el-pagination .btn-next:not([disabled])').first();
  if (!(await nextButton.count())) return false;
  await nextButton.click();
  await page.waitForTimeout(3_000);
  return true;
}

function formatSummary(summary) {
  const lines = [];
  lines.push(
    `OMS 定时送审完成: 提交 ${summary.submitted.length} 条, 跳过 ${summary.skipped.length} 条, 失败 ${summary.failed.length} 条, 扫描 ${summary.pages} 页`,
  );
  if (summary.submitted.length) {
    lines.push('提交:');
    for (const item of summary.submitted) {
      lines.push(`- [${item.channel}] ${item.title}`);
    }
  }
  if (summary.skipped.length) {
    lines.push('跳过:');
    for (const item of summary.skipped) {
      lines.push(`- [${item.reason}] ${item.title}`);
    }
  }
  if (summary.failed.length) {
    lines.push('失败:');
    for (const item of summary.failed) {
      lines.push(`- [${item.channel}] ${item.title} :: ${item.detail}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: config.executablePath,
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  const seen = new Set();
  const summary = {
    pages: 0,
    submitted: [],
    skipped: [],
    failed: [],
  };

  try {
    await login(page, config);
    await runQuery(page, config.query);

    for (let pageNo = 1; pageNo <= config.maxPages; pageNo += 1) {
      summary.pages = pageNo;
      const rows = await collectRows(page, config.recentDays);
      const recentRows = rows.filter((row) =>
        isRecentEnough(row.publishedAt, config.recentDays),
      );
      if (recentRows.length === 0) break;

      for (const row of recentRows) {
        const key = `${row.title}__${row.publishedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const decision = decideChannel(row);
        if (!decision.submit) {
          summary.skipped.push({
            title: row.title,
            reason: decision.reason,
          });
          continue;
        }

        try {
          const result = await submitRow(page, row, decision.channel, args.dryRun);
          if (result.ok) {
            summary.submitted.push({
              title: row.title,
              channel: decision.channel,
            });
          } else {
            summary.failed.push({
              title: row.title,
              channel: decision.channel,
              detail: result.detail || result.mode,
            });
          }
        } catch (error) {
          summary.failed.push({
            title: row.title,
            channel: decision.channel,
            detail:
              error instanceof Error ? error.message : String(error),
          });
        }
      }

      const moved = await gotoNextPage(page);
      if (!moved) break;
    }

    console.log(formatSummary(summary));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
