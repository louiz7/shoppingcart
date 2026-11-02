import { json } from '@sveltejs/kit';
import { getTasks, type TaskCategory } from '$lib/server/platform-data';
import type { RequestHandler } from './$types';

const categories = new Set<TaskCategory>(['Regelkonform', 'Sonderfall', 'Eskalation']);

export const GET: RequestHandler = async ({ url, locals }) => {
	const category = url.searchParams.get('category');
	return json(await getTasks(
		locals.user!.customerId,
		category && categories.has(category as TaskCategory) ? (category as TaskCategory) : undefined
	));
};
