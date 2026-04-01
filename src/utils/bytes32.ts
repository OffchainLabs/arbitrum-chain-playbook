/**
 * Bytes32 utilities for consistent handling of bytes32-like values
 */

/**
 * Normalize a bytes32-like value (bigint / hex string / decimal string) to a
 * canonical 0x-prefixed, 32-byte, lowercase hex string.
 *
 * This avoids bugs where one call site treats bytes32 as bigint while another treats it as 0x string.
 */
export function normalizeBytes32Like(value: unknown): string {
  if (typeof value === 'bigint') {
    return `0x${value.toString(16).padStart(64, '0')}`;
  }

  if (typeof value === 'string') {
    // Hex string (possibly not padded / mixed-case)
    if (value.startsWith('0x')) {
      const hex = value.slice(2);
      if (/^[0-9a-fA-F]*$/.test(hex)) {
        return `0x${hex.padStart(64, '0')}`.toLowerCase();
      }
    }

    // Decimal string
    try {
      const bi = BigInt(value);
      return `0x${bi.toString(16).padStart(64, '0')}`;
    } catch {
      return value;
    }
  }

  return String(value);
}
