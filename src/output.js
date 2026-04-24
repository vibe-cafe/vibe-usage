// Terminal output helpers: colors, status markers, OSC 8 clickable links.
// Falls back to plain text when NO_COLOR is set or stdout is not a TTY.

const NO_COLOR = !!process.env.NO_COLOR || !process.stdout.isTTY;

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function wrap(code, text) {
  if (NO_COLOR) return String(text);
  return `${code}${text}${CODES.reset}`;
}

export const bold = (t) => wrap(CODES.bold, t);
export const dim = (t) => wrap(CODES.dim, t);
export const red = (t) => wrap(CODES.red, t);
export const green = (t) => wrap(CODES.green, t);
export const yellow = (t) => wrap(CODES.yellow, t);
export const cyan = (t) => wrap(CODES.cyan, t);
export const gray = (t) => wrap(CODES.gray, t);

/** OSC 8 hyperlink — supported by modern terminals (iTerm2, Kitty, Warp, VSCode, macOS Terminal 14+). */
export function link(url, text = url) {
  if (NO_COLOR) return url === text ? url : `${text} (${url})`;
  return `\x1b]8;;${url}\x1b\\${CODES.cyan}${CODES.underline}${text}${CODES.reset}\x1b]8;;\x1b\\`;
}

export const success = (msg) => `${green('✓')} ${msg}`;
export const failure = (msg) => `${red('✗')} ${msg}`;
export const warn = (msg) => `${yellow('!')} ${msg}`;
export const arrow = (msg) => `${cyan('→')} ${msg}`;

export const divider = () => dim('─'.repeat(48));

/** Print a blank line. */
export const nl = () => console.log();

const LOGO_LINES = [
  '██╗   ██╗██╗██████╗ ███████╗    ██╗   ██╗███████╗ █████╗  ██████╗ ███████╗',
  '██║   ██║██║██╔══██╗██╔════╝    ██║   ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝',
  '██║   ██║██║██████╔╝█████╗      ██║   ██║███████╗███████║██║  ███╗█████╗  ',
  '╚██╗ ██╔╝██║██╔══██╗██╔══╝      ██║   ██║╚════██║██╔══██║██║   ██║██╔══╝  ',
  ' ╚████╔╝ ██║██████╔╝███████╗    ╚██████╔╝███████║██║  ██║╚██████╔╝███████╗',
  '  ╚═══╝  ╚═╝╚═════╝ ╚══════╝     ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

/** Big ASCII logo — used once at the top of `init` / first-run. */
export function bigHeader() {
  const logo = NO_COLOR
    ? LOGO_LINES.join('\n')
    : LOGO_LINES.map(l => `${CODES.cyan}${l}${CODES.reset}`).join('\n');
  return `\n${logo}\n${dim('  Vibe Usage · by VibeCafé')}\n`;
}

/** Compact one-line header — used for `sync`, `daemon`, `reset`, `skill`. */
export function smallHeader() {
  return `${bold('Vibe Usage')} ${dim('· by VibeCafé')}`;
}
