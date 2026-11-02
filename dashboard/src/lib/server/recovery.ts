import { env } from '$env/dynamic/private';

export async function recoveryRequest(customerId: number, path = '', body?: unknown) {
	const base = env.RECOVERY_API_URL || 'http://127.0.0.1:3110';
	const url = new URL(base);
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('recovery_gateway_must_be_local');
	const response = await fetch(`${base}/internal/recovery/admin${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_TOOL_SECRET || '', 'x-customer-id': String(customerId) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60000), redirect: 'error'
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || 'recovery_unavailable');
	return result;
}
