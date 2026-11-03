import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Exercises the built SvelteKit route and hooks, using only a synthetic visitor password.
const password = `demo-only<&"'><script>bad()</script>`;
async function check(enabled) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['dashboard/build/index.js'], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, RECOVERY_ONLY: '1', RECOVERY_BROWSER_DEMO_ENABLED: enabled ? '1' : '0', SHOPIFY_STOREFRONT_PASSWORD: password },
        stdio: 'ignore'
    });
    const exited = once(child, 'exit');
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { await fetch(origin + '/demo/unlock', { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await delay(100); }
        }
        assert.ok(ready, 'dashboard starts');
        const request = (options = {}, path = '/demo/unlock') => fetch(origin + path, { redirect: 'manual', ...options });
        const get = await request();
        assert.equal(get.status, 405, 'GET cannot disclose the visitor password');
        const foreign = await request({ method: 'POST', headers: { origin: 'https://other.example' } });
        assert.equal(foreign.status, 403);
        const missingOrigin = await request({ method: 'POST' });
        assert.equal(missingOrigin.status, 403);
        const response = await request({ method: 'POST', headers: { origin } }, '/demo/unlock?shop=other.example&return_to=https://other.example');
        assert.equal(response.status, enabled ? 200 : 503);
        const html = await response.text();
        assert.ok(!html.includes(password));
        if (!enabled) { assert.ok(!html.includes('name="password"')); return; }
        assert.match(html, /value="demo-only&lt;&amp;&quot;&#39;&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;"/);
        assert.match(html, /action="https:\/\/test-store-slzn5m7l\.myshopify\.com\/password"/);
        assert.ok(!html.includes('other.example'), 'caller cannot change the destination');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const nonce = html.match(/<script nonce="([^"]+)"/)[1];
        const csp = response.headers.get('content-security-policy');
        assert.ok(csp.includes(`script-src 'nonce-${nonce}'`), 'hooks preserve route CSP');
        assert.ok(csp.includes("frame-ancestors 'none'"));
        assert.ok(csp.includes('form-action https://test-store-slzn5m7l.myshopify.com;'));
    } finally {
        child.kill('SIGTERM');
        await exited;
    }
}
await check(true);
await check(false);
console.log('Demo unlock: origin checks, feature gate, escaping, fixed destination and response headers passed.');
