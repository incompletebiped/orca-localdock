export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** A logger that prefixes every message with `scope`. */
  child(scope: string): Logger;
}

export type LogSink = (entry: LogEntry) => void;

const secrets = new Set<string>();

/**
 * Register a secret value (password, passphrase, API key) so every logger
 * masks it, wherever it ends up in a message. Values shorter than 4 characters
 * are ignored because masking them would garble ordinary text.
 */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) {
    secrets.add(value);
  }
}

const PATTERNS: Array<[RegExp, string]> = [
  // MYSQL_PWD='...' / MYSQL_PWD=...
  [/(MYSQL_PWD=)('[^']*'|"[^"]*"|\S+)/g, '$1***'],
  // password=... in option files or URLs
  [/(password\s*[=:]\s*)('[^']*'|"[^"]*"|\S+)/gi, '$1***'],
  // define( 'DB_PASSWORD', '...' ) and the WordPress auth keys and salts
  [
    /(define\s*\(\s*['"](?:DB_PASSWORD|[A-Z_]*(?:KEY|SALT))['"]\s*,\s*)('[^']*'|"[^"]*")/g,
    "$1'***'",
  ],
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  // Authorization headers
  [/(Authorization:\s*\S+\s+)\S+/gi, '$1***'],
  [/(X-LocalDock-Key:\s*)\S+/gi, '$1***'],
];

export function redact(message: string): string {
  let out = message;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

export function createLogger(sink: LogSink, scope = 'localdock'): Logger {
  const write = (level: LogLevel) => (message: string) =>
    sink({ time: new Date().toISOString(), level, scope, message: redact(message) });
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (child) => createLogger(sink, `${scope}:${child}`),
  };
}

export const silentLogger: Logger = createLogger(() => {});
