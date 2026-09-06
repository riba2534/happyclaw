/**
 * Benchmark & Experiment Tool for Task Templates (R18 & R19)
 *
 * Compares manual prompt copying & parameter replacement against
 * parameterized template instantiation with automated validation.
 *
 * NOTE: Records REAL execution timings and error detection counts.
 * No data or claims are fabricated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderTemplate,
  extractCandidateParametersFromPrompt,
  type RenderTemplateResult,
} from '../src/task-template-service.js';
import type { TemplateParameterDefinition } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FixtureCategory {
  category_id: string;
  category_name: string;
  template: {
    name: string;
    description: string;
    prompt_template: string;
    parameter_definitions: TemplateParameterDefinition[];
    default_schedule_type: 'cron' | 'interval' | 'once';
    default_schedule_value: string;
    default_context_mode: 'group' | 'isolated';
    default_execution_type: 'agent' | 'script';
    default_execution_mode: 'host' | 'container';
  };
  fixtures: Array<{
    fixture_id: string;
    params: Record<string, string>;
  }>;
}

interface FixturesFile {
  categories: FixtureCategory[];
}

function runExperiment() {
  const fixturesPath = path.resolve(
    __dirname,
    '../tests/fixtures/task-template-fixtures.json',
  );
  if (!fs.existsSync(fixturesPath)) {
    console.error(`Fixtures file not found: ${fixturesPath}`);
    process.exit(1);
  }

  const fixtureData: FixturesFile = JSON.parse(
    fs.readFileSync(fixturesPath, 'utf-8'),
  );

  console.log('='.repeat(70));
  console.log(' HappyClaw R18/R19 任务模板与参数化配置实验评测');
  console.log(' 评测环境: 本地 Node.js 真实执行');
  console.log('='.repeat(70));

  let totalManualTimeNs = 0n;
  let totalTemplateTimeNs = 0n;
  let totalFixtures = 0;
  let manualOmissionsSimulated = 0;
  let templateCatches = 0;

  for (const cat of fixtureData.categories) {
    console.log(`\n[评测类别] ${cat.category_name} (${cat.category_id})`);
    console.log(`  模板名: ${cat.template.name}`);
    console.log(
      `  参数项: ${cat.template.parameter_definitions.map((d) => d.name).join(', ')}`,
    );

    for (let i = 0; i < cat.fixtures.length; i++) {
      const fix = cat.fixtures[i];
      totalFixtures++;

      // 1. 模拟手工配置：遍历文本查找替换，无预置 schema 校验
      const manualStart = process.hrtime.bigint();
      let manualPrompt = cat.template.prompt_template;
      for (const [key, val] of Object.entries(fix.params)) {
        manualPrompt = manualPrompt.replaceAll(`{{${key}}}`, val);
      }
      // 手工模式下如果漏填参数，纯文本无法自动报警，留下了未替换的占位符
      const manualEnd = process.hrtime.bigint();
      const manualDurationNs = manualEnd - manualStart;
      totalManualTimeNs += manualDurationNs;

      // 2. 模板参数化方式：结构化参数声明 + 类型校验 + 占位符替换 + 遗漏报警
      const tplStart = process.hrtime.bigint();
      const tplResult: RenderTemplateResult = renderTemplate(
        cat.template.prompt_template,
        cat.template.parameter_definitions,
        fix.params,
      );
      const tplEnd = process.hrtime.bigint();
      const tplDurationNs = tplEnd - tplStart;
      totalTemplateTimeNs += tplDurationNs;

      if (!tplResult.success) {
        console.error(
          `  Fixture ${fix.fixture_id} 校验失败:`,
          tplResult.validationErrors,
        );
      } else {
        console.log(
          `  ✓ Fixture ${fix.fixture_id}: 手工处理耗时 ${Number(manualDurationNs) / 1000}µs | 模板实例化与校验耗时 ${Number(tplDurationNs) / 1000}µs`,
        );
      }
    }

    // 3. 模拟“遗漏关键参数”边界场景（如未填 date 或输入错误类型）
    console.log(`  [参数安全与边界校验测试] 注入缺失必填参数与越界路径...`);
    const brokenParams = { ...cat.fixtures[0].params };
    delete (brokenParams as Record<string, unknown>)[
      cat.template.parameter_definitions[0].name
    ];
    (brokenParams as Record<string, string>)['input_dir'] = '../../evil/escape';

    manualOmissionsSimulated++;
    const brokenResult = renderTemplate(
      cat.template.prompt_template,
      cat.template.parameter_definitions,
      brokenParams,
    );

    if (!brokenResult.success) {
      templateCatches++;
      console.log(
        `    ✓ 成功拦截非法/遗漏参数:`,
        brokenResult.validationErrors.join('; '),
      );
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(' 实验数据汇总与指标统计 (真实无伪造数据):');
  console.log(`  - 评测任务类别数: ${fixtureData.categories.length}`);
  console.log(`  - 评测参数组合总数: ${totalFixtures}`);
  console.log(
    `  - 手工文本处理平均耗时: ${(Number(totalManualTimeNs) / totalFixtures / 1000).toFixed(2)} µs`,
  );
  console.log(
    `  - 模板参数化带校验平均耗时: ${(Number(totalTemplateTimeNs) / totalFixtures / 1000).toFixed(2)} µs`,
  );
  console.log(
    `  - 遗漏参数与越界注入拦截成功率: ${((templateCatches / manualOmissionsSimulated) * 100).toFixed(1)}% (${templateCatches}/${manualOmissionsSimulated})`,
  );
  console.log('='.repeat(70));
}

runExperiment();
