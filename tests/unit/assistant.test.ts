import { describe, it, expect } from 'vitest';
import { handle, type Deps } from '../../netlify/functions/assistant.mjs';

const env = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ANTHROPIC_API_KEY: 'test-key' };
const supabase = (opts: { user?: boolean; allowed?: boolean }) => (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith('/auth/v1/user')) return new Response('{}', { status: opts.user === false ? 401 : 200 });
  if (u.endsWith('/rpc/am_i_allowed')) return new Response(JSON.stringify(opts.allowed !== false), { status: 200 });
  throw new Error('unexpected ' + u);
}) as typeof fetch;
const req = (body: unknown, token: string | null = 'jwt') => new Request('https://app/api/assistant', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

function fakeModel(reply: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const anthropic: Deps['anthropic'] = () => ({ beta: { messages: { create: async (p: Record<string, unknown>) => { calls.push(p); return reply; } } } } as never);
  return { anthropic, calls };
}

describe('assistant function', () => {
  it('refuses without a session, with an expired session, or for a non-allow-listed account — before touching the model', async () => {
    const m = fakeModel({ content: [] });
    expect((await handle(req({ question: 'שאלה' }, null), { env, fetch: supabase({}), anthropic: m.anthropic })).status).toBe(401);
    expect((await handle(req({ question: 'שאלה' }), { env, fetch: supabase({ user: false }), anthropic: m.anthropic })).status).toBe(401);
    expect((await handle(req({ question: 'שאלה' }), { env, fetch: supabase({ allowed: false }), anthropic: m.anthropic })).status).toBe(403);
    expect(m.calls).toHaveLength(0);
  });

  it('says clearly when no AI key is configured (only to an allowed user)', async () => {
    const r = await handle(req({ question: 'שאלה' }), { env: { ...env, ANTHROPIC_API_KEY: undefined }, fetch: supabase({}) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ code: 'AI_NOT_CONFIGURED' });
  });

  it('sends the data as untrusted <data>, uses fallbacks, and returns only text', async () => {
    const m = fakeModel({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'תשובה' }] });
    const r = await handle(req({ question: 'כמה התקבל?', data: { received: 100 } }), { env, fetch: supabase({}), anthropic: m.anthropic });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ answer: 'תשובה' });
    const p = m.calls[0] as { model: string; fallbacks: string; betas: string[]; messages: { content: { text: string }[] }[] };
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toContain('server-side-fallback-2026-07-01');
    expect(p.messages[0].content[0].text).toBe('<data>{"received":100}</data>');
  });

  it('reports a refusal and rejects oversized input', async () => {
    const m = fakeModel({ stop_reason: 'refusal', content: [] });
    expect((await handle(req({ question: 'x' }), { env, fetch: supabase({}), anthropic: m.anthropic })).status).toBe(422);
    expect((await handle(req({ question: 'x'.repeat(2001) }), { env, fetch: supabase({}), anthropic: m.anthropic })).status).toBe(400);
  });
});
