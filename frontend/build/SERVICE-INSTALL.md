# Windows service packaging and installer integration (Phases 1–2)

The service scaffold lives in `D:\ACE-HRM-dev\windows-service`. `npm run dist` now builds the payload with `windows-service/scripts/build-payload.js` and bundles it through `build.win.extraResources` in `frontend/package.json` (Windows builds only). The manual steps below remain the reference for what the script does.

The NSIS include at `frontend/build/installer.nsh` looks for a bundled service payload and is a no-op when it is absent.

## What is already configured

- `nsis.oneClick: false`
- `nsis.perMachine: true`
- `nsis.allowElevation: true`
- `nsis.allowToChangeInstallationDirectory: true`
- `nsis.include: "build/installer.nsh"`
- `win.signAndEditExecutable: true`
- `forceCodeSigning` remains `false`, so unsigned local builds still work.

The per-machine installer runs elevated. `installer.nsh` removes any existing service before `electron-builder` closes running processes, because killing the service would make Windows restart it during the uninstall. It invokes the service installer only if this file exists at install time:

```
$INSTDIR\resources\windows-service\install-service.cmd
```

and invokes the service uninstaller, on both uninstall and upgrade, only if this file exists:

```
$INSTDIR\resources\windows-service\uninstall-service.cmd
```

Both macros are guarded and no-op-safe.

## Build the service payload

The service needs a Node runtime on the target machine. For an end-user installer, bundle a private runtime instead of requiring a system-wide Node installation.

```powershell
$svc = 'D:\ACE-HRM-dev\windows-service'
$stage = Join-Path $svc 'dist-service'

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

Push-Location $svc
npm install --omit=dev --no-audit --no-fund
Pop-Location

Copy-Item -LiteralPath (Join-Path $svc 'package.json') -Destination $stage
Copy-Item -LiteralPath (Join-Path $svc 'src') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $svc 'node_modules') -Destination $stage -Recurse
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $stage 'node.exe')
```

`npm run build-payload` (in `windows-service/`) does all of the above and generates `install-service.cmd` and `uninstall-service.cmd`; don't write them by hand. The listings below are reference only.

`install-service.cmd`:

```bat
@echo off
setlocal
"%~dp0node.exe" "%~dp0src\install.js" install
exit /b %ERRORLEVEL%
```

`uninstall-service.cmd`:

```bat
@echo off
setlocal
"%~dp0node.exe" "%~dp0src\install.js" uninstall
exit /b %ERRORLEVEL%
```

`node.exe` is a generic Node runtime. Confirm the Node license and redistribution terms for the version you ship.

## Add the payload to electron-builder

Only after `windows-service/dist-service` exists, add this to the `build` object in `frontend/package.json`:

```json
"extraResources": [
  {
    "from": "../windows-service/dist-service",
    "to": "windows-service",
    "filter": ["**/*"]
  },
  {
    "from": "../windows-service/dist-service/node_modules",
    "to": "windows-service/node_modules",
    "filter": ["**/*"]
  }
]
```

This places the files under `resources\windows-service\...`, which is the path used by `installer.nsh`.

Keep the second entry: `electron-builder` always drops a `node_modules` folder at the root of a `from` path, whatever the filter says, and without it the service can't install or run. Before shipping, check that `release_build\win-unpacked\resources\windows-service\node_modules\ws` exists. The installer only logs the service installer's exit code, so a failure there doesn't stop the app install.

Do not commit `windows-service/dist-service`.

## Signing hooks

The code-signing certificate is not available yet. Keep `forceCodeSigning` false so local builds remain possible.

When a certificate is available, provide it through the environment used by `electron-builder`:

```powershell
$env:CSC_LINK = 'C:\secure\acehrm-signing.pfx'
$env:CSC_KEY_PASSWORD = '<password>'
```

`electron-builder` signs the app executable through `signAndEditExecutable: true`. For an Azure Trusted Signing setup, add `win.azureSignOptions` later; do not put secrets or certificate paths in the repository.

`extraResources` files are not signed automatically by `electron-builder`. Sign the service payload executables before packaging, for example with `signtool.exe` using a SHA-256 timestamped signature:

```powershell
signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f <certificate.pfx> /p <password> <service-payload.exe>
```

In this Phase 1/2 payload the executables are the vendored `node.exe` (already signed by the Node.js project) and `node_modules\node-windows\bin\winsw\winsw.exe` (the wrapper that `src/install.js` copies to `daemon\aceHRMDeviceService.exe` at install time). Sign `winsw.exe` before packaging if your signing policy covers it, and sign any wrapper or generated service executable you add later. Do not run signing steps until the certificate is available.

## Build the installer

```powershell
cd D:\ACE-HRM-dev\frontend
npm --prefix ..\windows-service run build-payload
npm run build
npx electron-builder --win nsis
```

or:

```powershell
cd D:\ACE-HRM-dev\frontend
npm run dist
```

Output: `frontend/release_build/aceHRM-Setup-<version>.exe`.

## Deployment notes

- Nothing needs provisioning: the PC enrolls when a user signs in to the app, and is assigned to them. The service uses the production API by default. To point it elsewhere, or to enroll before anyone signs in with an admin `enrollmentToken`, create `C:\ProgramData\aceHRM\device-service.json`, then restart `aceHRMDeviceService`. Restrict the file to Administrators/SYSTEM:
  ```powershell
  icacls "C:\ProgramData\aceHRM\device-service.json" /inheritance:r /grant:r "*S-1-5-32-544:(F)" "*S-1-5-18:(F)"
  ```
- The service is installed as LocalSystem with automatic start, and Windows restarts it after a failure.
- Uninstalling restores the settings the service enforced. An upgrade that runs the old uninstaller therefore lifts the policy until the new service next syncs, usually within a minute.
- The installer is per-machine and requires elevation; the service installer commands inherit that elevation.
- Validate the upgrade path on a test machine. The NSIS include is intentionally a guarded no-op, not an upgrade orchestrator; stop/remove the service before replacing its binaries if your payload locks files.
- The named-pipe DACL and service-account hardening remain future work. See `windows-service/README.md`.
