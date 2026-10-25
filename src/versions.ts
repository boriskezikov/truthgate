// Versions a verdict carries: the schema of the report, the rule set, and the prompts (by content hash).
import { createHash } from 'node:crypto';

/** Bumped when a field of Report, Claim or ClaimVerdict changes meaning. */
export const SCHEMA_VERSION = '1.1.0';
/** Bumped when a deterministic rule changes; a calibration table is only valid for the rules version it was built on. */
export const RULES_VERSION = '2.7.2';

export function promptsVersion(...prompts: string[]): string {
  return createHash('sha256').update(prompts.join('\n---\n')).digest('hex').slice(0, 12);
}
