# Release Checklist (1.0.x)

Use this checklist for every release to keep versioning, installers, and GitHub artifacts consistent.

## 1. Prepare Branch

- Pull latest main.
- Confirm working tree is clean (`git status --short`).
- Ensure Node dependencies are installed (`npm ci`).

## 2. Update Version

- Update app version in `package.json`.
- Update root version values in `package-lock.json`.
- Add release notes entry in `README.md` under Release Notes.

## 3. Verify Packaging Assets

- Ensure Windows icon exists at `build/icon.ico`.
- Confirm `package.json` build config uses the icon:
  - `build.win.icon`
  - `build.nsis.installerIcon`
  - `build.nsis.uninstallerIcon`
  - `build.nsis.installerHeaderIcon`

## 4. Clean and Build Locally

- Clear old artifacts in `dist`.
- Build Windows installer locally:
  - `npm run dist:win`
- Verify installer filename includes new version:
  - `dist/BitsPleaseYT The PoW Coin Finder-Setup-<version>-x64.exe`

## 5. Commit and Push

- Commit release changes (version bump, notes, assets).
- Push commit to main.

## 6. Tag and Trigger CI Builds

- Create and push tag:
  - `git tag v<version>`
  - `git push origin v<version>`
- This triggers GitHub Actions workflow for Windows and macOS installers.

## 7. Verify GitHub Actions Outputs

- Open Actions run for the pushed tag.
- Confirm both matrix jobs succeed:
  - windows-latest
  - macos-latest
- Download artifacts and confirm expected files:
  - Windows: `.exe` and `.blockmap`
  - macOS: `.dmg` and `.zip`

## 8. Post-Release Sanity Check

- Install/test Windows build quickly on a clean machine or VM.
- Confirm app version shown in installer/app metadata matches release version.
- Record any follow-up fixes for next patch release.
