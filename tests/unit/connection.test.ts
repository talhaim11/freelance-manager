import { describe, expect, it, vi } from 'vitest';
import { privilegedKeyProblem } from '../../app/src/data/backend';
import { mapError } from '../../app/src/data/supabaseRepo';
import { authErrorMessage, errorMessage } from '../../app/src/domain/errors';
import { uuid } from '../../app/src/lib/uuid';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('browser key guard', () => {
  it('accepts public keys and refuses privileged ones', () => {
    expect(privilegedKeyProblem('sb_publishable_abc123')).toBeNull();
    expect(privilegedKeyProblem(jwt({ role: 'anon' }))).toBeNull();
    expect(privilegedKeyProblem('sb_secret_abc123')).toBe('secret');
    expect(privilegedKeyProblem(jwt({ role: 'service_role' }))).toBe('service_role');
    expect(privilegedKeyProblem('eyJnot-a-jwt')).toBe('unreadable');
  });
});

describe('error mapping (what the user is told)', () => {
  it('passes through codes raised by the database functions', () => {
    expect(mapError({ message: 'FINALIZED_DOCUMENT: issued documents cannot be edited' }, 400).code).toBe('FINALIZED_DOCUMENT');
  });
  it('treats an expired or invalid token as an expired session, never as empty data', () => {
    expect(mapError({ message: 'JWT expired', code: 'PGRST303' }, 401).code).toBe('SESSION_EXPIRED');
    expect(mapError({ message: 'whatever' }, 401).code).toBe('SESSION_EXPIRED');
  });
  it('treats a failed request as NETWORK (outcome unknown)', () => {
    expect(mapError({ message: 'TypeError: Failed to fetch' }, 0).code).toBe('NETWORK');
    expect(mapError({ message: 'FetchError: fetch failed' }).code).toBe('NETWORK');
  });
  it('maps permission and duplicate errors', () => {
    expect(mapError({ message: 'permission denied for table documents', code: '42501' }, 403).code).toBe('NOT_ALLOWED');
    expect(mapError({ message: 'duplicate key value violates unique constraint', code: '23505' }, 409).code).toBe('DUPLICATE');
  });
  it('has a Hebrew message for every mapped code', () => {
    for (const code of ['SESSION_EXPIRED', 'NETWORK', 'NOT_ALLOWED', 'DUPLICATE', 'FINALIZED_DOCUMENT']) {
      expect(errorMessage(mapError({ message: code === 'FINALIZED_DOCUMENT' ? code : 'x', code: code === 'NOT_ALLOWED' ? '42501' : code === 'DUPLICATE' ? '23505' : undefined },
        code === 'SESSION_EXPIRED' ? 401 : code === 'NETWORK' ? 0 : 400))).toMatch(/[֐-׿]/);
    }
  });
  it('sign-in errors do not reveal whether an account exists', () => {
    expect(authErrorMessage({ message: 'Invalid login credentials', status: 400 })).toBe('הדוא״ל או הסיסמה שגויים.');
    expect(authErrorMessage({ message: 'Failed to fetch', name: 'AuthRetryableFetchError' })).toMatch(/אין תקשורת/);
    expect(authErrorMessage({ message: 'Request rate limit reached', status: 429 })).toMatch(/יותר מדי/);
  });
});

describe('uuid', () => {
  it('works without crypto.randomUUID (phone over plain http on the local network)', () => {
    const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never);
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    spy.mockRestore();
  });
});
