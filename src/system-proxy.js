// Whether the operating system has a proxy or PAC configured (2026-11-25, for
// the Cursor separate sign-in; network-privacy principle rules 1 and 2).
//
// The CLI follows only the proxy its environment names (`env-proxy.js`); the
// desktop apps turn the system proxy and PAC into those variables. A CLI run
// from a terminal or the background service gets no such variables, so on a
// machine set to a system proxy its requests go direct. For the requests the
// separate Cursor sign-in adds, that is not acceptable: when this answers yes
// and no proxy variable is set, they are not sent and the user is told to set
// HTTPS_PROXY. A TUN-only setup configures no system proxy and is unaffected.
// A query that fails on macOS / Windows counts as configured (when unsure, do
// not send). Not covered: Linux desktop proxy settings, and Windows proxies
// handed out only by WPAD ("Automatically detect settings" is on by default,
// so it cannot tell a proxy apart from none) -- the desktop apps' known gap.
import { execFileSync } from 'node:child_process';

export function systemProxyConfigured({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  // Test hook: '0' / '1' answers without asking the system.
  const forced = env.VIBE_USAGE_SYSTEM_PROXY?.trim();
  if (forced === '0') return false;
  if (forced === '1') return true;
  try {
    if (platform === 'darwin') {
      const out = run('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      return /\b(?:HTTPEnable|HTTPSEnable|SOCKSEnable|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*1\b/.test(out);
    }
    if (platform === 'win32') {
      const out = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
        encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /\bProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(out) || /\bAutoConfigURL\s+REG_SZ\s+\S/i.test(out);
    }
  } catch {
    return platform === 'darwin' || platform === 'win32';
  }
  return false;
}
