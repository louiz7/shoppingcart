import { env } from '$env/dynamic/private';

export async function recoveryRequest(customerId: number, path = '', body?: unknown, actorUserId?: number) {
	const base = env.RECOVERY_API_URL || 'http://127.0.0.1:3110';
	const url = new URL(base);
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('recovery_gateway_must_be_local');
	const response = await fetch(`${base}/internal/recovery/admin${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_TOOL_SECRET || '', 'x-customer-id': String(customerId),
			...(actorUserId === undefined ? {} : { 'x-user-id': String(actorUserId) }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(60000), redirect: 'error'
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || 'recovery_unavailable');
	return result;
}

async function organizationRequest(path: string, body?: unknown, actor?: { customerId: number; userId: number }) {
	const base = env.RECOVERY_API_URL || 'http://127.0.0.1:3110';
	const url = new URL(base);
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('recovery_gateway_must_be_local');
	const response = await fetch(`${base}/internal/recovery/organizations${path}`, {
		method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
		headers: { 'Content-Type': 'application/json', 'x-internal-secret': env.INTERNAL_TOOL_SECRET || '',
			...(actor ? { 'x-customer-id': String(actor.customerId), 'x-user-id': String(actor.userId) } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || 'organization_unavailable');
	return result;
}

export const registerOrganization = (body: { organizationName: string; displayName: string; email: string; password: string; clientAddress: string }) => organizationRequest('/register', body);
export const authenticateOrganization = (body: { email: string; password: string; clientAddress: string }) => organizationRequest('/login', body);
export const organizationOverview = (customerId: number, userId: number) => organizationRequest('/overview', undefined, { customerId, userId });
