/*
 * YunFlow (云流) — electron-builder NSIS patch (idempotent).
 * Copyright (C) 2026 YunFlow Contributors
 *
 * AGPL-3.0-or-later. This program is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License
 * as published by the Free Software Foundation, version 3 or later.
 */

/**
 * electron-builder (26.18.0) builds NSIS installers in two passes: it first
 * compiles an "uninstaller extraction" variant and EXECUTES it to carve the
 * uninstaller out of the freshly written installer. On hardened endpoints
 * that execution of a brand-new unsigned setup gets silently blocked (the
 * user may only see a security dialog that auto-dismisses), which aborts the
 * whole build with `File "...__uninstaller.exe" -> no files found`.
 *
 * The patch reroutes the Windows extraction path through the pure-JS
 * UninstallerReader (the code path macOS already uses): it parses the NSIS
 * payload directly and never executes the installer. Execution remains as a
 * fallback, and both the extraction and the (unsigned) co-signing of the
 * uninstaller degrade to warnings instead of failing the build — the
 * uninstaller is still generated normally at install time.
 *
 * Wired as a `postinstall` hook so `npm install` re-applies it automatically.
 */

import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(import.meta.dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');

if (!fs.existsSync(target)) {
  console.log('  patch-electron-builder: app-builder-lib not installed, skipping');
  process.exit(0);
}

const source = fs.readFileSync(target, 'utf8');
if (source.includes('YunFlow patch')) {
  console.log('  patch-electron-builder: already applied');
  process.exit(0);
}

const MARK = "else {\n            const wineVm = new WineVm_1.WineVmManager";
const replacement = `else {
            // YunFlow patch: prefer the pure-JS UninstallerReader (the macOS
            // path) — it parses the installer's NSIS payload directly and
            // never executes it, which avoids hardened endpoints blocking
            // brand-new unsigned setups. Fall back to executing the installer
            // only if parsing fails.
            try {
                await nsisUtil_1.UninstallerReader.exec(installerPath, uninstallerPath);
            }
            catch (readerError) {
                builder_util_1.log.warn(\`UninstallerReader failed (\${readerError.message}); falling back to executing the installer\`);
                const wineVm = new WineVm_1.WineVmManager((_a = packager.config.toolsets) === null || _a === void 0 ? void 0 : _a.wine);
                try {
                    await wineVm.exec(installerPath, [], { env: { __COMPAT_LAYER: "RunAsInvoker" } });
                }
                catch (execError) {
                    builder_util_1.log.warn(\`uninstaller pre-extraction skipped: \${execError.message}\`);
                }
            }
        }`;

if (!source.includes(MARK)) {
  console.warn('  patch-electron-builder: expected code shape not found — app-builder-lib version may have changed; NOT patched');
  process.exit(0);
}

const signMark = '        await packager.signIf(uninstallerPath);';
const signReplacement = `        try {
            await packager.signIf(uninstallerPath);
        }
        catch (error) {
            builder_util_1.log.warn(\`uninstaller signing skipped: \${error.message}\`);
        }`;

let patched = source.replace(MARK, replacement);
if (!patched.includes(signReplacement)) {
  patched = patched.replace(signMark, signReplacement);
}
fs.writeFileSync(target, patched);
console.log('  patch-electron-builder: applied (UninstallerReader-first + soft-fail extraction)');
