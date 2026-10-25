// The world as the verifier sees it: every file under the sandbox, hashed; a symlink is recorded by its target, never
// followed. Taken by the harness before and after the run, never reported by the model.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { WorldSnapshot } from './types.ts';

/** Directories the snapshot does not enter; the world level sends claims about them to the judge. */
export const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function snapshotWorld(root: string): WorldSnapshot {
  const files: WorldSnapshot['files'] = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const st = lstatSync(full); // a symlink is never followed: the world is the sandbox, not where a link points
      if (st.isSymbolicLink()) files[relative(root, full)] = { sha256: createHash('sha256').update(`symlink:${readlinkSync(full)}`).digest('hex'), bytes: 0 };
      else if (st.isDirectory()) walk(full);
      else if (st.isFile()) files[relative(root, full)] = { sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), bytes: st.size };
    }
  };
  walk(root);
  return { files };
}

export interface WorldDiff { created: string[]; modified: string[]; deleted: string[] }

export function diffWorld(before: WorldSnapshot, after: WorldSnapshot): WorldDiff {
  const created: string[] = [], modified: string[] = [], deleted: string[] = [];
  for (const p of Object.keys(after.files)) {
    if (!(p in before.files)) created.push(p);
    else if (before.files[p]!.sha256 !== after.files[p]!.sha256) modified.push(p);
  }
  for (const p of Object.keys(before.files)) if (!(p in after.files)) deleted.push(p);
  return { created, modified, deleted };
}
