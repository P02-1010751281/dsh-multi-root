/**
 * Path identity helpers shared by the plugin and its discovery module.
 * @module dsh-multi-root/canonical
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Canonicalize a path the way the host does (native realpath, spelled path as
 * the fallback when it does not resolve).
 * @param path - any path.
 * @returns the physical path when resolvable, else the input.
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `child` is `parent` itself or lies below it, comparing physical
 * paths. Both sides are canonicalized first so a symlinked ancestor cannot
 * disguise containment.
 * @param child - candidate descendant.
 * @param parent - candidate ancestor.
 * @returns whether child is inside parent.
 */
export function pathInside(child, parent) {
  const a = canonicalPath(child)
  const b = canonicalPath(parent)
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}
