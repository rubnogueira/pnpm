import { promises as fs } from 'node:fs'
import path from 'node:path'

import { WANTED_LOCKFILE } from '@pnpm/constants'
import { filterLockfileByImporters } from '@pnpm/lockfile.filtering'
import {
  getLockfileImporterId,
  readWantedLockfile,
  writeWantedLockfile,
} from '@pnpm/lockfile.fs'
import { pruneSharedLockfile } from '@pnpm/lockfile.pruner'
import type { LockfileObject } from '@pnpm/lockfile.types'
import type { ProjectId, ProjectRootDir } from '@pnpm/types'
import { rimraf } from '@zkochan/rimraf'

const SPLIT_SENTINEL = '.pnpm-split-in-progress'

function sentinelPath (workspaceDir: string): string {
  return path.join(workspaceDir, SPLIT_SENTINEL)
}

/**
 * `lockfileStorage: split` keeps per-package `pnpm-lock.yaml` files on disk
 * (one per workspace project, like `sharedWorkspaceLockfile: false`) while still
 * running the fast, single shared-resolution install path.
 *
 * Around the single `mutateModules()` call we:
 *   1. {@link mergePerPackageLockfiles} the per-package lockfiles into one
 *      unified lockfile at the workspace root, so resolution reuses them.
 *   2. let `mutateModules()` resolve/link/build once for the whole workspace.
 *   3. {@link splitUnifiedLockfile} the result back into per-package lockfiles
 *      and drop the unified root lockfile.
 *
 * A {@link SPLIT_SENTINEL} file marks the window where a unified lockfile may
 * exist at the root, so a crash between steps can be recovered on the next run.
 */

/**
 * If a previous split-mode install crashed between merge and split, a stale
 * unified lockfile may remain at the workspace root. Detect this via the
 * sentinel file and remove the stale unified lockfile so the next install
 * starts from the per-package lockfiles again.
 */
export async function recoverFromPartialSplit (workspaceDir: string): Promise<void> {
  try {
    await fs.access(sentinelPath(workspaceDir))
  } catch {
    return // no sentinel — nothing to recover
  }
  // Previous run crashed mid-split. Remove the stale unified lockfile.
  await rimraf(path.join(workspaceDir, WANTED_LOCKFILE))
  await rimraf(sentinelPath(workspaceDir))
}

/**
 * Read per-package lockfiles from each project directory, merge them into a
 * single unified lockfile, and write it to the workspace root so that
 * `mutateModules()` can read it as an ordinary shared lockfile.
 *
 * The merge is only a resolution seed: `mutateModules()` re-resolves and
 * produces the authoritative unified lockfile, so the merge does not need to be
 * perfect. Workspace-level fields (overrides, catalogs, settings, checksums)
 * are taken from the first lockfile found, since every per-package lockfile in a
 * workspace is written with the same workspace-level configuration.
 *
 * Writes the sentinel before creating the unified lockfile so partial failures
 * can be detected and cleaned up on the next run.
 */
export async function mergePerPackageLockfiles (
  workspaceDir: string,
  projectDirs: ProjectRootDir[]
): Promise<void> {
  await fs.writeFile(sentinelPath(workspaceDir), `pid=${process.pid}\n`)

  const lockfiles = await Promise.all(projectDirs.map(async (projectDir) => ({
    projectDir,
    lockfile: await readWantedLockfile(projectDir, { ignoreIncompatible: true }),
  })))

  let merged: LockfileObject | null = null

  for (const { projectDir, lockfile } of lockfiles) {
    if (lockfile == null) continue

    const importerId = getLockfileImporterId(workspaceDir, projectDir)

    // Re-key importers: a per-package lockfile uses "." for its own project and
    // relative paths for any nested importers. In the unified lockfile these
    // become paths relative to the workspace root (e.g. "." -> "services/foo").
    const remappedImporters: LockfileObject['importers'] = {}
    for (const [id, snapshot] of Object.entries(lockfile.importers)) {
      const newId = (id === '.' ? importerId : `${importerId}/${id}`) as ProjectId
      remappedImporters[newId] = snapshot
    }

    if (merged == null) {
      merged = {
        ...lockfile,
        importers: remappedImporters,
      }
      continue
    }

    Object.assign(merged.importers, remappedImporters)
    if (lockfile.packages) {
      merged.packages ??= {}
      Object.assign(merged.packages, lockfile.packages)
    }
    if (lockfile.time) {
      merged.time ??= {}
      Object.assign(merged.time, lockfile.time)
    }
    if (lockfile.ignoredOptionalDependencies) {
      merged.ignoredOptionalDependencies = [...new Set([
        ...merged.ignoredOptionalDependencies ?? [],
        ...lockfile.ignoredOptionalDependencies,
      ])]
    }
  }

  if (merged != null) {
    await writeWantedLockfile(workspaceDir, merged)
  }
}

/**
 * Read the unified lockfile from the workspace root, split it into per-package
 * lockfiles (one per project, each pruned to only the packages it needs, with
 * its own importer re-keyed to "."), write each to its package directory, and
 * remove the unified lockfile from the workspace root.
 *
 * When the workspace root is itself a project (importer "."), its dedicated
 * lockfile is written to the root, so the unified file is not removed.
 *
 * `pnpmfileChecksums` carries each project's own pnpmfile checksum (computed by
 * the caller from that project's `.pnpmfile`). The unified resolution only
 * tracks the workspace-root pnpmfile, so each per-package lockfile is re-stamped
 * with its own checksum to match what a per-project install would write (and so
 * the up-to-date check re-resolves a project when its pnpmfile changes).
 */
export async function splitUnifiedLockfile (
  workspaceDir: string,
  projectDirs: ProjectRootDir[],
  pnpmfileChecksums?: Map<ProjectRootDir, string | undefined>
): Promise<void> {
  const lockfile = await readWantedLockfile(workspaceDir, { ignoreIncompatible: false })
  if (lockfile == null) {
    // Nothing was resolved (e.g. lockfile-only no-op). Clear the sentinel.
    await rimraf(sentinelPath(workspaceDir))
    return
  }

  const importerIds = projectDirs.map((dir) => getLockfileImporterId(workspaceDir, dir))
  const hasRootImporter = importerIds.includes('.' as ProjectId)

  await Promise.all(importerIds.map(async (importerId, i) => {
    const projectDir = projectDirs[i]

    if (!lockfile.importers[importerId]) return

    const filtered = filterLockfileByImporters(lockfile, [importerId], {
      include: {
        dependencies: true,
        devDependencies: true,
        optionalDependencies: true,
      },
      skipped: new Set(),
      failOnMissingDependencies: false,
    })

    // Re-key the importer back to "." (and nested importers relative to it) so
    // the per-package lockfile is self-contained.
    const perPkgLockfile: LockfileObject = {
      ...filtered,
      importers: {},
    }
    for (const [id, snapshot] of Object.entries(filtered.importers)) {
      if (id === importerId) {
        perPkgLockfile.importers['.' as ProjectId] = snapshot
      } else if (id.startsWith(`${importerId}/`)) {
        const newId = id.slice(importerId.length + 1) as ProjectId
        perPkgLockfile.importers[newId] = snapshot
      }
      // Importers that don't belong to this package are dropped.
    }

    const pruned = pruneSharedLockfile(perPkgLockfile)
    // Re-stamp with this project's own pnpmfile checksum (the unified lockfile
    // only carried the workspace-root one). A falsy checksum is dropped on write.
    const checksum = pnpmfileChecksums?.get(projectDir)
    if (checksum != null) {
      pruned.pnpmfileChecksum = checksum
    } else {
      delete pruned.pnpmfileChecksum
    }
    await writeWantedLockfile(projectDir, pruned)
  }))

  // Remove the unified lockfile from the workspace root, unless the root itself
  // is a project (its dedicated lockfile was just written there).
  if (!hasRootImporter) {
    await rimraf(path.join(workspaceDir, WANTED_LOCKFILE))
  }

  await rimraf(sentinelPath(workspaceDir))
}
