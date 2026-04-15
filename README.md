# BitsPleaseYT The PoW Coin Finder.

This is an Electron-based desktop app that displays newly listed and actively tracked Proof of Work (POW) coins with a modern desktop interface.

## Release Notes

### 1.0.5

- Bumped app and installer version to 1.0.5.
- Configured a real Windows app and installer icon via build/icon.ico.
- Cleaned and refreshed installer output artifacts before release build.

### 1.0.4

- Added an Algorithm column to New Listings.
- Added New Listings sorting by algorithm.
- Added algorithm confidence badges and legend for new listings.
- Improved algorithm detection by prioritizing clear ANN title and post matches before fallback mapping.

## How to Run

1. Make sure you have Node.js installed: https://nodejs.org/
2. Open a terminal in this folder.
3. Run:
   npm install
   npm start

## Features
- Modern web-style GUI
- List of POW coins with clickable links (website, GitHub, explorer)
- PoW Prices tab with icons, sorting, and search
- Quick external access to the CoinGecko Proof of Work category page
- Easy to extend for real-time scraping and login features

## Build Installers Locally

1. Install dependencies:
   npm ci
2. Build both platforms from the current machine when supported:
   npm run dist
3. Build Windows only:
   npm run dist:win
4. Build macOS only:
   npm run dist:mac

Artifacts are written to the dist folder.

## GitHub Actions

The repository includes a GitHub Actions workflow that builds installable artifacts for:
- Windows: NSIS installer
- macOS: DMG and ZIP

Trigger it with either:
- a push to main
- a version tag like v1.0.0
- manual workflow dispatch in GitHub Actions

## Signing Secrets

To produce signed installers in GitHub Actions, add these repository secrets:

- WINDOWS_CSC_LINK: Base64 or URL form of your Windows code-signing certificate (.p12 / .pfx)
- WINDOWS_CSC_KEY_PASSWORD: Password for the Windows signing certificate
- MACOS_CSC_LINK: Base64 or URL form of your Apple Developer Application certificate (.p12)
- MACOS_CSC_KEY_PASSWORD: Password for the macOS signing certificate
- APPLE_ID: Apple ID used for notarization
- APPLE_APP_SPECIFIC_PASSWORD: App-specific password for the Apple ID
- APPLE_TEAM_ID: Your Apple Developer Team ID

Without those secrets, GitHub Actions still builds unsigned artifacts. macOS unsigned builds may require right-click Open on first launch.

## No Signers Available

If you do not have signing certificates yet, you can still ship installable builds.

- Windows: unsigned NSIS installer is still generated
- macOS: unsigned DMG and ZIP are still generated

The workflow automatically detects missing signing secrets and falls back to unsigned builds.
