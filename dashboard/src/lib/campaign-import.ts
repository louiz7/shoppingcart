export type ImportRow = Record<string, string>;

export const importAliases = {
	firstName: ['vorname', 'first name', 'first_name', 'firstname', 'given name', 'given_name'],
	lastName: ['nachname', 'name', 'familienname', 'last name', 'last_name', 'lastname', 'surname'],
	fullName: ['name', 'vor- und nachname', 'vorname nachname', 'vollständiger name', 'vollstaendiger name', 'debitor'],
	invoice: ['rechnungsnummer', 'invoice', 'invoice number'],
	email: ['e-mail-adresse', 'email', 'e-mail'],
	amount: ['rechnungsbetrag', 'betrag', 'amount'],
	phone: ['telefonnummer', 'telefon', 'phone'],
	dueDate: ['fälligkeitsdatum', 'faelligkeitsdatum', 'due date', 'due_date'],
	fileNumber: ['aktenzeichen', 'file number', 'file_number'],
	subFileNumber: ['unteraktennummer', 'unteraktenzeichen', 'sub-file number', 'sub_file_number'],
	note: ['notiz', 'note', 'notes']
} as const;

export type ImportField = keyof typeof importAliases;

const standardFields: { key: Exclude<ImportField, 'firstName' | 'lastName' | 'fullName'>; label: string }[] = [
	{ key: 'invoice', label: 'Rechnungsnummer' },
	{ key: 'email', label: 'E-Mail-Adresse' },
	{ key: 'amount', label: 'Rechnungsbetrag' },
	{ key: 'phone', label: 'Telefonnummer' },
	{ key: 'dueDate', label: 'Fälligkeitsdatum' }
];

export function normalizeImportHeader(value: unknown): string {
	return String(value ?? '').trim().toLocaleLowerCase('de-DE');
}

function containsAlias(headers: Set<string>, key: ImportField): boolean {
	return importAliases[key].some((alias) => headers.has(alias));
}

export function importField(row: ImportRow, key: ImportField): string {
	for (const alias of importAliases[key]) {
		const value = row[alias];
		if (value !== undefined) return String(value).trim();
	}
	return '';
}

export function usesSplitName(row: ImportRow): boolean {
	return importAliases.firstName.some((alias) => Object.hasOwn(row, alias));
}

export function importPersonName(row: ImportRow): { firstName: string; lastName: string; name: string; split: boolean } {
	const split = usesSplitName(row);
	if (!split) {
		const name = importField(row, 'fullName');
		return { firstName: '', lastName: '', name, split };
	}

	const firstName = importField(row, 'firstName');
	const lastName = importField(row, 'lastName');
	return {
		firstName,
		lastName,
		name: [firstName, lastName].filter(Boolean).join(' '),
		split
	};
}

export function missingImportHeaders(values: unknown[]): string[] {
	const headers = new Set(values.map(normalizeImportHeader));
	const hasFirstName = containsAlias(headers, 'firstName');
	const hasLastName = containsAlias(headers, 'lastName');
	const hasFullName = containsAlias(headers, 'fullName');
	const missing: string[] = [];

	if (hasFirstName) {
		if (!hasLastName) missing.push('Nachname');
	} else if (!hasFullName) {
		missing.push('Vorname');
		if (!hasLastName) missing.push('Nachname');
	}

	for (const field of standardFields) {
		if (!containsAlias(headers, field.key)) missing.push(field.label);
	}
	return missing;
}
