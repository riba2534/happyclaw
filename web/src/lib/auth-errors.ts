import { apiErrorBody } from '../utils/error';

/**
 * What the password, two-factor and passkey routes mean by their error
 * `code`s, in the user's words. The English `error` text is a fallback only.
 */
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  CURRENT_PASSWORD_INCORRECT: '当前密码不正确',
  MFA_INVALID: '验证码不正确',
  MFA_REQUIRED: '请输入验证器 App 上的验证码',
  MFA_EXPIRED: '验证已过期或尝试次数过多，请重新输入密码',
  MFA_ALREADY_ENABLED: '二次验证已经开启',
  MFA_NOT_ENABLED: '二次验证没有开启',
  MFA_SECRET_UNREADABLE:
    '服务器的加密密钥已变更，无法校验验证器 App 的验证码。请改用恢复码，或请管理员重置二次验证。',
  PASSKEY_INVALID: '这个通行密钥未登记在本站，或已被删除',
  PASSKEY_EXPIRED: '通行密钥验证已过期，请重试',
  PASSKEY_LIMIT_REACHED: '通行密钥已达上限（20 个），请先删除不用的',
  PASSKEY_IP_HOST:
    '通行密钥不能在 IP 地址下使用，请用 localhost 或域名访问本站。',
  PASSKEY_INSECURE: '通行密钥只能在 HTTPS 域名（或 localhost）下使用。',
  PASSKEY_NOT_ALLOWED: '当前地址未允许使用通行密钥，请联系管理员',
};

/** The error code of a failed auth request, if it had one. */
export function authErrorCode(err: unknown): string | undefined {
  const code = apiErrorBody(err)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A failed password, two-factor or passkey request, in the user's words. */
export function authErrorMessage(err: unknown, fallback: string): string {
  const body = apiErrorBody(err);
  const code = authErrorCode(err);
  if (code === 'TOO_MANY_ATTEMPTS') {
    const seconds = Number(body?.retry_after_seconds);
    return Number.isFinite(seconds) && seconds > 0
      ? `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试`
      : '尝试次数过多，请稍后再试';
  }
  if (code && AUTH_ERROR_MESSAGES[code]) return AUTH_ERROR_MESSAGES[code];
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? (err as { message?: unknown }).message
      : undefined;
  return typeof message === 'string' && message.trim() ? message : fallback;
}
