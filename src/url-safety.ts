// SSRF 安全工具：URL 校验 + 内网/loopback hostname 识别。
//
// 在多处需要拒绝用户提交的 URL（init_git_url、skills install URL 等）指向内网
// 或 cloud-metadata 的场景下复用，避免每个调用点各自实现一份正则。

import net from 'net';

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local — covers AWS/GCP cloud-metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0
  if (a === 0) return true;
  return false;
}

/**
 * 检查 hostname 是否为内网地址（SSRF 防护）。
 * 拒绝 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fc00::/7, fe80:: 等。
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  // 去除 IPv6 方括号 + 去除 FQDN trailing dot（new URL('https://localhost./')
  // 把 hostname 留成 'localhost.'，原始 endsWith('.localhost') 不命中）
  const stripped = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const lower = stripped.toLowerCase();
  // localhost 变体（已剥离 trailing dot）
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  if (net.isIPv6(stripped)) {
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 (unique local) 整段 + fe80::/10 (link-local)。fc00 / fd00 都算
    // ULA。fe80::/10 的 high 10 bits = 1111111010，所以第二字节范围 0x80-0xbf —
    // 即第二个 hex 字符是 8/9/a/b。原实现 startsWith('fe80') 漏了 fe81…febf。
    if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // ::ffff:127.0.0.1 (dotted form) — 直接复用 IPv4 判定
    if (lower.startsWith('::ffff:') && lower.includes('.')) {
      const ipv4Part = lower.slice(7);
      return isPrivateIPv4(ipv4Part);
    }
    // ::ffff:7f00:1 (hex form) — Node URL 解析后会规范化成这种形态。
    // 把后两组 16-bit hex 拼回 IPv4 dotted decimals 再判一次。
    {
      const m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
        return isPrivateIPv4(dotted);
      }
    }
    // ::a.b.c.d (IPv4-compatible, 已 deprecated 但 Node 仍解析)
    {
      const m = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        if (a !== 0 && a !== 0xffff) {
          const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
          if (isPrivateIPv4(dotted)) return true;
        }
      }
    }
    // 6to4 (2002:abcd:efgh::/16) — encode IPv4 in second/third hextet
    if (lower.startsWith('2002:')) {
      const m = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
      if (m) {
        const a = parseInt(m[1], 16);
        const b = parseInt(m[2], 16);
        const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
        if (isPrivateIPv4(dotted)) return true;
      }
    }
    return false;
  }

  if (net.isIPv4(stripped)) {
    return isPrivateIPv4(stripped);
  }

  return false;
}

/**
 * 安全 URL 校验：HTTPS-only + 拒绝指向内网 hostname。
 * 返回 null = 通过；返回 string = 拒绝原因。
 */
export function validateSafeHttpsUrl(
  raw: string,
  opts?: { maxLength?: number; allowHttp?: boolean },
): string | null {
  const maxLength = opts?.maxLength ?? 2000;
  if (!raw || raw.length > maxLength) return `URL too long (max ${maxLength})`;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (opts?.allowHttp) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Only http(s) URLs are allowed';
    }
  } else if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
  }
  if (isPrivateHostname(parsed.hostname)) {
    return `Hostname not allowed (private/link-local): ${parsed.hostname}`;
  }
  return null;
}
