import { env } from '$env/dynamic/private';
export async function demoRequest(path: '/info' | '/start' | '/status' | '/end', body?: unknown) {
    const base = new URL(env.RECOVERY_API_URL || 'http://127.0.0.1:3110');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('invalid_gateway');
    const response = await fetch(new URL(`/internal/recovery/demo${path}`, base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(45000),
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_TOOL_SECRET || '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'demo_unavailable');
    return result;
}
