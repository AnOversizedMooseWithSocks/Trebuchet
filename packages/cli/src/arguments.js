const FLAG_OPTIONS = new Set(['json', 'help', 'version']);
const VALUE_OPTIONS = new Set(['config', 'out', 'plan']);

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

export function parseCliArguments(argv = []) {
  const options = {};
  const positionals = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (positionalOnly || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }

    const equalAt = token.indexOf('=');
    const key = token.slice(2, equalAt >= 0 ? equalAt : undefined);
    const inlineValue = equalAt >= 0 ? token.slice(equalAt + 1) : null;
    if (FLAG_OPTIONS.has(key)) {
      if (inlineValue !== null) throw new CliArgumentError(`--${key} does not accept a value.`);
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new CliArgumentError(`Unknown option: --${key}`);
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new CliArgumentError(`Option --${key} may only be provided once.`);
    }
    const value = inlineValue !== null ? inlineValue : argv[++index];
    if (value === undefined || String(value).startsWith('--')) {
      throw new CliArgumentError(`Option --${key} requires a value.`);
    }
    options[key] = String(value);
  }

  return { options, positionals };
}
