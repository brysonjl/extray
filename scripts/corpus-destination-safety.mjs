// Static destination inventory for synthetic mutations. Never execute sample code.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export function isReservedHost(host) {
  return /\.(?:invalid|example|test)$/i.test(host.replace(/\.$/, ''));
}

function destinationEntries(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const hosts = [];
  function inspect(value, depth = 0) {
    for (const match of value.matchAll(/(?:(?:https?|wss?|ftp):)?\/\/([a-z0-9][^\s'"<>\\]+)/gi)) {
      try { hosts.push({ host: new URL(match[0].startsWith('//') ? `https:${match[0]}` : match[0]).hostname.toLowerCase(), value: match[0] }); } catch { hosts.push({ host: match[1].toLowerCase(), value: match[0] }); }
    }
    // Bare hosts also matter: decoders often concatenate scheme + host + path.
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i.test(value)) {
      // Asset paths are not network destinations. Full URLs are never exempt.
      if (value.includes('/') || !/\.(?:js|json|css|png|jpg|svg|html|txt|woff2?)$/i.test(value)) {
        hosts.push({ host: new URL(`https://${value}`).hostname.toLowerCase(), value });
      }
    }
    if (depth < 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') && /^[\x20-\x7e]+$/.test(decoded.toString('latin1'))) inspect(decoded.toString('latin1'), depth + 1);
    }
  }
  // Raw URLs include HTML, JSON, comments, and binary trailing configuration.
  for (const match of text.matchAll(/(?:(?:https?|wss?|ftp):)?\/\/[a-z0-9][^\s'"<>\\]+/gi)) inspect(match[0]);
  for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g)) {
    const value = match[2].replace(/\\x([0-9a-f]{2})|\\u([0-9a-f]{4})/gi, (_, x, u) => String.fromCharCode(parseInt(x ?? u, 16))).replace(/\\\//g, '/');
    inspect(value);
  }
  // I/J hide a base64 endpoint beyond PNG IEND, not in a script literal.
  for (const match of text.matchAll(/CFG1([A-Za-z0-9+/=]+?)CFG1/g)) inspect(match[1]);
  return hosts;
}

export function destinationHosts(bytes) {
  return destinationEntries(bytes).map(entry => entry.host);
}

export function unsafeAddedHosts(mutant, base = Buffer.alloc(0)) {
  // Only unchanged source lines (ignoring outer whitespace) are inherited. Comparing just hosts (or
  // URLs) would exempt replacing navigation with a new fetch to the same URL.
  const remaining = new Map();
  for (const line of Buffer.from(base).toString('latin1').split(/\r?\n/).map(line => line.trim())) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added = Buffer.from(mutant).toString('latin1').split(/\r?\n/).map(line => line.trim()).filter(line => {
    const count = remaining.get(line) ?? 0;
    if (count > 0) { remaining.set(line, count - 1); return false; }
    return true;
  }).join('\n');
  return destinationHosts(Buffer.from(added, 'latin1')).filter(host => !isReservedHost(host));
}

export function validateDestinations(extensionDir, baseDir) {
  const errors = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) { errors.push(`${relative(extensionDir, file)}: symlinks are not allowed in synthetic samples`); continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      const rel = relative(extensionDir, file);
      const baseline = join(baseDir, rel);
      const bytes = readFileSync(file);
      const base = existsSync(baseline) ? readFileSync(baseline) : Buffer.alloc(0);
      if (bytes.equals(base)) continue;
      for (const host of new Set(unsafeAddedHosts(bytes, base))) errors.push(`${rel}: injected destination ${host} must end in .invalid, .example, or .test`);
    }
  }
  walk(extensionDir);
  return errors;
}
