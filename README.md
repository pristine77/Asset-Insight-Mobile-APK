# Asset Insight Mobile APK

Source code for the Asset Insight Expo and React Native mobile application.

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
