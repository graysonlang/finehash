// Browser and Node base64 helpers. FineHash byte strings are tiny, but these
// avoid spread-argument limits and keep encode/decode behavior symmetric.

declare const Buffer: {
  from(data: string, encoding: string): Uint8Array;
  from(data: Uint8Array): { toString(encoding: string): string };
} | undefined;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function getBuffer(): NonNullable<typeof Buffer> {
  if (typeof Buffer !== 'undefined') return Buffer;
  throw new Error('base64 conversion requires btoa/atob or Buffer');
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; ++i) binary += String.fromCharCode(bytes[i]!);
    return globalThis.btoa(binary);
  }
  return getBuffer().from(bytes).toString('base64');
}

export function base64ToBytes(base64: string): Uint8Array {
  const text = base64.trim();
  if (text.length === 0 || text.length % 4 === 1 || !BASE64_RE.test(text)) {
    throw new Error('invalid FineHash base64');
  }

  if (typeof globalThis.atob === 'function') {
    let binary: string;
    try {
      binary = globalThis.atob(text);
    } catch {
      throw new Error('invalid FineHash base64');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  return new Uint8Array(getBuffer().from(text, 'base64'));
}
