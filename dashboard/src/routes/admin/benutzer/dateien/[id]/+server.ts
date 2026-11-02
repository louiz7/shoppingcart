import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import type { RequestHandler } from './$types';

function isBfiOrganization(name: string): boolean {
	return /^bfi(?:\s+inkasso)?(?:\s|$)/i.test(name.trim());
}

function asciiFilename(name: string): string {
	return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 150) || 'datei';
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const user = locals.user!;
	if (user.role !== 'admin') error(403, 'Keine Administratorberechtigung.');
	if (!/^\d+$/.test(params.id)) error(404, 'Datei nicht gefunden.');

	const result = await db.query<{
		original_filename: string; content_type: string; content: Buffer; organization_name: string;
	}>(
		`SELECT file.original_filename, file.content_type, file.content, customer.name AS organization_name
		   FROM organization_files file
		   JOIN customers customer ON customer.id = file.customer_id
		  WHERE file.id = $1 AND file.customer_id = $2`,
		[params.id, user.customerId]
	);
	const file = result.rows[0];
	if (!file || !isBfiOrganization(file.organization_name)) error(404, 'Datei nicht gefunden.');

	const encodedFilename = encodeURIComponent(file.original_filename).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return new Response(new Uint8Array(file.content), {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(file.content.length),
			'Content-Disposition': `attachment; filename="${asciiFilename(file.original_filename)}"; filename*=UTF-8''${encodedFilename}`,
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store'
		}
	});
};
