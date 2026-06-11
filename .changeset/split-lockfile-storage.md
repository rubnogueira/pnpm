---
"@pnpm/config.reader": minor
"@pnpm/installing.commands": minor
"pnpm": minor
---

Made `sharedWorkspaceLockfile: false` fast by default in workspaces.

Previously, `sharedWorkspaceLockfile: false` ran one full install cycle (resolve + link + write) per package, making clean installs scale linearly with the number of packages. Now a workspace with `sharedWorkspaceLockfile: false` defaults to a new `lockfileStorage: split` mode: per-package `pnpm-lock.yaml` files are merged into a temporary unified lockfile at the workspace root, resolved once via a single `mutateModules()` pass, then split back into per-package lockfiles (the unified root lockfile is removed). The per-package lockfiles produced are byte-identical to the legacy path, so git merge-conflict isolation and CI cache granularity are preserved while clean installs run at nearly shared-lockfile speed.

Per-package `.pnpmfile` hooks are preserved. The legacy path loads each project's own `.pnpmfile` (via `requireHooks(<projectDir>)`); the single shared resolution would otherwise only see the workspace-root `.pnpmfile`. In split mode every project's `.pnpmfile` is loaded and its `readPackage` hooks are composed into the one resolution (safe because such hooks key on the package they target via `pkg.name`), and each per-package lockfile is re-stamped with its own `pnpmfileChecksum`. This keeps `readPackage` rewrites (e.g. `link:` specifiers for workspace-linked dependencies) byte-identical to a per-project install.

A `.pnpm-split-in-progress` sentinel at the workspace root enables recovery if an install is interrupted between the merge and split steps.

The behavior can be controlled explicitly via the new `lockfileStorage` setting: `split` forces the fast path (even with the default `sharedWorkspaceLockfile: true`), while `shared` opts back into the legacy per-project resolution when combined with `sharedWorkspaceLockfile: false`.
