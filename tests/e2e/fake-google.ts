// In-memory stand-ins for Google Identity Services and the Drive v3 API.
// No request ever reaches Google during tests.
import type { Page, Route } from '@playwright/test';

export interface FakeFile { id: string; name: string; version: number; content: string }

export class FakeDrive {
  files = new Map<string, FakeFile>();
  fail401 = false;
  failStatus: number | null = null;
  requests: string[] = [];
  private seq = 0;

  seed(content: object, name = 'freelance_data.json') {
    const id = `file-${++this.seq}`;
    this.files.set(id, { id, name, version: 1, content: JSON.stringify(content) });
    return id;
  }
  only(): FakeFile { return [...this.files.values()][0]; }
  json(): any { return JSON.parse(this.only().content); }
  /** Simulates another device writing to the file. */
  externalWrite(mutate: (d: any) => void) {
    const f = this.only();
    const d = JSON.parse(f.content);
    mutate(d);
    f.content = JSON.stringify(d);
    f.version += 1;
  }

  async install(page: Page) {
    await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: {
        initTokenClient(cfg) { return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: 'fake-token', expires_in: 3600 }), 0); } }; },
        revoke(t, cb) { cb && cb(); } } } };`,
    }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://api.anthropic.com/**', (r) => { this.requests.push('ANTHROPIC ' + r.request().url()); return r.abort(); });
    await page.route('https://www.googleapis.com/**', (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    this.requests.push(`${req.method()} ${url.pathname}${url.search}`);
    if (this.fail401) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":401}}' });
    if (this.failStatus) return route.fulfill({ status: this.failStatus, body: '{}' });
    const path = url.pathname;
    const ok = (obj: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

    if (req.method() === 'GET' && path === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name='([^']+)'/.exec(q)?.[1];
      const files = [...this.files.values()].filter((f) => !name || f.name === name)
        .map((f) => ({ id: f.id, name: f.name, version: String(f.version), modifiedTime: '2026-01-01T00:00:00Z' }));
      return ok({ files });
    }
    const m = /^\/(upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m) {
      const f = this.files.get(m[2]);
      if (!f) return route.fulfill({ status: 404, body: '{}' });
      if (req.method() === 'GET' && url.searchParams.get('alt') === 'media') return route.fulfill({ status: 200, contentType: 'application/json', body: f.content });
      if (req.method() === 'GET') return ok({ id: f.id, version: String(f.version) });
      if (req.method() === 'PATCH') { f.content = req.postData() ?? ''; f.version += 1; return ok({ id: f.id, version: String(f.version) }); }
    }
    if (req.method() === 'POST' && path === '/upload/drive/v3/files') {
      const body = req.postDataBuffer()?.toString('utf8') ?? '';
      const jsonParts = body.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      const meta = JSON.parse(jsonParts[0]);
      const id = `file-${++this.seq}`;
      this.files.set(id, { id, name: meta.name, version: 1, content: jsonParts[1] });
      return ok({ id, version: '1' });
    }
    return route.fulfill({ status: 400, body: `unhandled ${req.method()} ${path}` });
  }
}
