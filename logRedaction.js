const SENSITIVE_KEY = /^(?:api[-_]?key|authorization|auth|token|secret|secretKey|secretKeyB58|privateKey|mnemonic)$/i;

export function redactUrl(value) {
  const text = String(value || '');
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '[REDACTED]');
    }
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    return url.toString();
  } catch {
    return text;
  }
}

export function redactSensitiveText(value) {
  let text = String(value ?? '');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => redactUrl(candidate));
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(
    /(["']?(?:api[-_]?key|authorization|auth|token|secret(?:Key|KeyB58)?|privateKey|mnemonic)["']?\s*[:=]\s*)(["']?)([^\s,;}\]]+)\2/gi,
    '$1[REDACTED]',
  );
  return text;
}

export function redactSensitiveValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    const copy = new Error(redactSensitiveText(value.message));
    copy.name = value.name;
    copy.stack = redactSensitiveText(value.stack || `${value.name}: ${value.message}`);
    return copy;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : redactSensitiveValue(item, seen);
  }
  return output;
}

export function redactSensitiveLogArgs(args = []) {
  return args.map((value) => redactSensitiveValue(value));
}
