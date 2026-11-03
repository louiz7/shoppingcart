import { createHash } from 'node:crypto';
import document from '../../../../src/recovery/terms-document.json';

export { document };
export const termsHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
