/**
 * Share tokens: 18 random bytes, base64url, 24 characters (design §5.6).
 * 144 bits of randomness is why a share URL needs no other secret; the only
 * way in is having the link.
 */
import { randomBytes } from 'node:crypto';

/** 18 bytes → exactly 24 base64url characters, no padding */
const TOKEN_BYTES = 18;

/** What a token looks like in a URL path; anything else is a 404 without a lookup */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export const generateShareToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

export const isShareToken = (value: string): boolean => TOKEN_PATTERN.test(value);
