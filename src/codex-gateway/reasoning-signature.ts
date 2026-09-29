// ─── ChatGPT/Codex 订阅网关 — reasoning 回放信封 ──────────────────
//
// 上游强制 store=false，工具循环第二轮必须把上一轮的 reasoning item
// （encrypted_content + id）原样带回，否则 function_call 会被 400 拒绝。
// Anthropic 协议里唯一会被 SDK 原样回传的载体是 thinking 块的
// signature 字段，因此把这对值编码进 signature；前缀标记保证只回放
// 本网关写入的信封，来自真实 Anthropic 的签名或损坏数据一律跳过。

const SIGNATURE_PREFIX = 'codexrs1_';

interface ReasoningSignaturePayload {
  /** 上游 reasoning item id（rs_...），可能缺失。 */
  id: string | null;
  /** 上游 reasoning item 的 encrypted_content。 */
  encryptedContent: string;
}

export function encodeReasoningSignature(
  payload: ReasoningSignaturePayload,
): string | null {
  if (!payload.encryptedContent) return null;
  const json = JSON.stringify({
    v: 1,
    id: payload.id,
    ec: payload.encryptedContent,
  });
  return `${SIGNATURE_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

export function decodeReasoningSignature(
  signature: unknown,
): ReasoningSignaturePayload | null {
  if (
    typeof signature !== 'string' ||
    !signature.startsWith(SIGNATURE_PREFIX)
  ) {
    return null;
  }
  try {
    const json = Buffer.from(
      signature.slice(SIGNATURE_PREFIX.length),
      'base64url',
    ).toString('utf8');
    const parsed = JSON.parse(json) as {
      v?: unknown;
      id?: unknown;
      ec?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.ec !== 'string' || !parsed.ec) {
      return null;
    }
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : null,
      encryptedContent: parsed.ec,
    };
  } catch {
    return null;
  }
}
