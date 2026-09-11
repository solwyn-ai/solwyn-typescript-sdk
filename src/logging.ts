/**
 * Logger abstraction (D6).
 *
 * This is the ONLY file in the SDK where `console.*` is permitted — every other
 * module logs through the injected {@link Logger}. Biome's `noConsole` rule is
 * disabled for this path via an override in `biome.json`.
 *
 * Log-level escalation rules (e.g. ERROR at 10 consecutive confirm failures) are
 * behavior owned by other subsystems and tested via injected fake loggers — this
 * module only supplies the interface and the two default implementations.
 */

/** Minimal structured logger. Injectable via SDK config. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Replace every C0/C1 control byte with a printable escape for diagnostic text.
 * `\t`/`\n`/`\r` use short escapes; every other byte uses lowercase `\xHH`.
 */
export function escapeControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += char;
      continue;
    }
    switch (code) {
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        out += `\\x${code.toString(16).padStart(2, "0")}`;
        break;
    }
  }
  return out;
}

/** Default console-backed logger. */
export const consoleLogger: Logger = {
  debug(message: string, ...args: unknown[]): void {
    console.debug(message, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    console.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(message, ...args);
  },
};

/** No-op logger — the default for tests (and for callers who want silence). */
export const noopLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * Wrap an injected logger so diagnostics can never change SDK control flow.
 * Message templates, levels, and positional arguments pass through unchanged;
 * only failures raised by the caller-owned logging sink are discarded.
 */
export function bestEffortLogger(logger: Logger): Logger {
  const emit = (level: keyof Logger, message: string, args: unknown[]): void => {
    try {
      logger[level](message, ...args);
    } catch {
      // Diagnostics are observational; a failing sink must never become authoritative.
    }
  };

  return {
    debug: (message, ...args) => emit("debug", message, args),
    info: (message, ...args) => emit("info", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    error: (message, ...args) => emit("error", message, args),
  };
}
