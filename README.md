# Asset Insight Mobile APK

Source code for the Asset Insight Expo and React Native mobile application.

## Latest source synchronization — 9 October 2026

Synchronized source revision `dc73c68`, including explicit durable Android report
submission, queued Incoming Create Lot & Continue and reviewed specification edits.
Pristine77's Bank and logo defaults, bounded decoding, immutable asynchronous
camera snapshots, fixed-lot locks, native CameraX routing and September controls
are preserved. Photo sizing remains 3000 px standard / 6000 px high resolution,
with 720p/30fps video. Private capture backup remains disabled.

OpenAI credits, provider usage logging, usage multipliers/calculations and Salvage
provider-cost tracking are excluded. Existing report layouts are retained.
This is application source; no APK/AAB or signing credentials are included.

The obsolete custom APK installer and unused legacy Incoming adapter were removed
to match the current application. Their previous source remains in Git history.
Verification and exclusion checks use an isolated staging copy; production and
physical-device behavior are not exercised by source synchronization.

Final checks: both native exports passed all 115 Jest suites / 1,430 tests and
TypeScript. Android/iOS Hermes exports passed from the Front-End native copy;
source maps match the exported application. Report-transfer, camera, application
and instrumentation Kotlin compiled offline. An initial concurrent run timed out
two existing 100-lot tests; unchanged focused and full reruns passed without
changing timeouts. No emulator, physical device, live provider, signing or store
release was exercised. Backend endpoints must precede a new native binary;
runtime layouts, OEM endurance and provider integration still require release
validation. Application changes match the paired Front-End export, while this
repository's synchronization summary is maintained separately.

## Included

- Asset Listing and Lot Listing workflows
- Photo and video capture, including the custom Android auction camera module
- Direct, resumable, Smart Upload, and offline upload flows
- Authentication, secure session storage, and device-access approval
- Report preview, editing, approval, release, and file access
- Auction management, notifications, and supporting mobile screens

## Source-only repository

This repository intentionally excludes generated APK, AAB, and IPA files; signing keys and credential files; Firebase service configuration; Expo state; dependency folders; Gradle caches; and native build outputs.

Keep these files local and provide them through the appropriate build or secret-management system:

- `google-services.json`
- Android signing keystores and credentials
- Apple signing certificates and provisioning profiles

## Requirements

- Node.js 20 or newer
- npm
- Expo-compatible Android tooling only when a native Android build is required

## Setup

```bash
npm install
```

The application can load without `google-services.json`; Firebase-backed functionality requires a valid local copy of that file.

## Lightweight validation

```bash
npm exec tsc -- --noEmit --pretty false -p tsconfig.json
```

Native builds, Metro, and emulators are not required for the static check above.

## Security

Never commit signing keys, credential files, service-account files, access tokens, or production secrets. See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## License

ISC. See [LICENSE](LICENSE).
