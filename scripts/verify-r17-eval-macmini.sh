#!/usr/bin/env bash
# ==============================================================================
# verify-r17-eval-macmini.sh
#
# HappyClaw R17: 提示词版本任务评测、人工反馈与可下载效果报告
# 生产环境 (Mac mini) 真实执行验收脚本
#
# 严格拒绝模拟或 FakeProvider 兜底。
# 必须对授权隔离的 fixture Agent 启动 15 个脱敏典型工程任务的真实双版本对比评测，
# 验证终态、真实 Usage/Token、模型来源 (live_provider)、权限隔离与 Markdown 报告导出。
# 缺少真实 Provider 凭据配置或任何断言失败时必须退出非 0。
# ==============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo "  HappyClaw R17 生产环境真实端到端验收 (Mac mini)"
echo "============================================================"

# 1. 运行代码编译检查与构建完整性
echo "[1/3] 验证代码类型与产物构建状态..."
npm run typecheck
npm run docs:check
npm run format:check

# 2. 检查真实模型凭据环境门禁（缺配置绝对不能 fallback fake）
echo "[2/3] 检查模型 Provider 认证与凭据..."
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  # 进一步检查持久化配置
  HAS_CONFIGURED_PROVIDER=$(node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const p = path.join(process.cwd(), 'data/config/providers.json');
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const has = (j.providers || []).some(x => x.enabled && (x.anthropicApiKey || x.anthropicAuthToken || x.claudeCodeOauthToken || x.claudeOAuthCredentials));
        process.stdout.write(has ? '1' : '0');
      } catch { process.stdout.write('0'); }
    } else { process.stdout.write('0'); }
  " 2>/dev/null || echo "0")

  if [ "$HAS_CONFIGURED_PROVIDER" != "1" ]; then
    echo ""
    echo "❌ [FATAL] 生产验收未检测到任何有效的模型 Provider 认证凭据！"
    echo "   必须配置 ANTHROPIC_API_KEY / OAuth Token 或在 Web 界面启用带凭据的 Provider。"
    echo "   根据契约规范，严禁使用 FakeProvider 冒充生产验收。"
    echo "   验收脚本终止并返回非 0 退出码。"
    exit 1
  fi
fi
echo "   ✓ 已检测到有效的生产模型凭据"

# 3. 运行生产端到端验收执行驱动器
echo "[3/3] 启动真实执行设施对 fixture Agent 运行 15 案例双版本评测..."
npx tsx scripts/verify-eval-macmini-runner.ts

echo ""
echo "============================================================"
echo "  ✓ R17 生产环境真实端到端验收成功完成！"
echo "============================================================"
