/**
 * Repository anchoring: which directory a workspace's grants belong to.
 *
 * A session's cwd sits at an arbitrary depth, so keying grants on the cwd alone
 * hides them from a session opened one level up or down — the grants describe a
 * project, not a directory. Anchoring on the nearest `.git` gives one key per
 * project.
 *
 * Only `.git` counts. Inheriting along arbitrary ancestor directories would let
 * a grant recorded in a home directory apply to everything beneath it, which is
 * the opposite of a write boundary.
 *
 * @module dsh-multi-root/project
 */

import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { canonicalPath } from './canonical.js'

/** A directory holding this entry is a project root. A file counts too (worktrees, submodules). */
const MARKER = '.git'

/**
 * Resolve the directory a workspace's grants are stored under: the nearest
 * ancestor (itself included) that holds a `.git` entry, else the workspace
 * itself.
 * @param path - a session workspace, spelled or physical.
 * @returns the physical anchoring directory.
 */
export function projectRootOf(path) {
  const start = canonicalPath(path)
  let current = start
  for (;;) {
    if (existsSync(join(current, MARKER))) return current
    const parent = dirname(current)
    if (parent === current || current === sep) return start
    current = parent
  }
}
