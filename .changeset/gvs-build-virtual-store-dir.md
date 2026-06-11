---
"@pnpm/building.after-install": patch
"pnpm": patch
---

Under `enableGlobalVirtualStore`, the post-install build step no longer overwrites `node_modules/.modules.yaml` with a local `node_modules/.pnpm` virtual-store path instead of the global `<storeDir>/links`. Previously this caused a subsequent `pnpm install` in a workspace package to detect a virtual-store mismatch and prompt to remove and reinstall `node_modules`.
