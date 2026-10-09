# Offline capture — Asset and Lot Listing

## Explicit durable Android Submit — 2026-10-08 (local; release pending)

An offline capture is still saved locally and never submits merely because
connectivity returns, the app reopens or an autosave completes. After review, an
explicit **Submit** with local originals on a new Android binary now stages an
immutable native transfer: save the full draft, reserve its normal server upload
session, obtain a session-scoped grant, then commit the native queue. Only that
durable receipt closes the form and permits the next independent form. It is
labelled saved/scheduled, not accepted; server acceptance remains separately
validated against owner, capture/submission identity and local revision.

Android can continue that explicitly authorized transfer through ordinary
navigation, process loss, reboot and temporary network loss. Explicit Pause or
Offline holds work; logout/account changes revoke native authority. Reopening
only rehydrates status and never resumes held work. Resume is explicit and uses
the same session, including receipt reconciliation after an uncertain completion.
Force-stop and Android/OEM restrictions can defer work; keep the original device
and do not uninstall or clear app data. Drafts/Upload status offer Pause, Resume
and safe Open; editing stays blocked until the native snapshot is released, and
uncertain acceptance requires Resume before release. Original bytes/references
are retained after both failure and acceptance.

Incoming standard Submit preserves its frozen assignment. Supported Android
**Create Lot & Continue** durably stages the parent and makes a short protected
same-contract server reservation before opening the next form; it does not wait
for media bytes or claim acceptance. A separate owner-bound SQLite intent records
the carried editable details and independent successor IDs without changing the
parent's frozen revision. The empty successor is saved create-only before display;
later edits/photos are never overwritten on reservation replay.

Pending **Continue requests** remain in Drafts/Incoming after process death or
parent acceptance. Reopening only reads this journal. Explicit Retry reconciles
the exact native parent and same reservation without rerunning upload or rotating
its grant. A confirmed absent native row returns to the saved original for explicit
Submit, while uncertainty remains blocked. Bound parent uploads allow Pause/Resume
but not editing/release; originals remain retained. Backend continuation support
must precede the new app binary.

Remote-only media, iOS and older binaries retain the existing in-app foreground
path and acceptance-first Continue with an explicit **Keep the app open** message. These
rules supersede older foreground/no-reconnect wording only for the new explicit
durable Submit path. Camera quality/layouts, report layouts, approval and delivery
remain unchanged. The independent private capture-backup feature remains
**disabled**; this work does not enable automatic backup or automatic submission.

Backend transfer support must precede a new native binary. No production access,
customer repair/mutation, push, deployment or signed release was performed.
All 111 Jest suites / 1,378 tests, TypeScript and both Hermes exports pass, including
rendered Asset/Lot queued Continue, saved-child isolation, owner/navigation fences,
explicit recovery and actual SQLite journal checks. Scoped ESLint has zero errors
/ 34 warnings. Local verification receipts were retained separately;
see `README.android.md` and
`modules/report-transfer/README.md` for detailed verification and the native
physical-device/OEM/real-media endurance boundaries.

## Durable Android cloud backup — 2026-10-06 (local; release pending)

Saved offline/manual-submit Asset and Lot captures now stage an independent
backup intent in the same SQLite transaction as their local save. Revision-scoped
outbox entries cannot overwrite an earlier snapshot before Android acknowledges
it. A bounded, local-only handoff sends metadata to the native scheduler without
waiting for the network; unacknowledged work remains in SQLite. Legacy editable
captures are seeded once, not rehashed on every screen/auth restart.

Android WorkManager owns streaming original-byte uploads, not a React timer.
Closing the form or ordinary process loss does not remove the durable queue.
Checkpoints, immutable private objects and server SHA-256/size verification allow
same-plan retry after lost responses. A newer shortened snapshot cannot cancel
pending originals from an earlier revision. Local files/references are retained;
no backup path deletes, recompresses or watermarks an original. Camera UI, photo
resolution and 720p/30fps recording remain unchanged.

Drafts and Profile show **Photo cloud backup**, exact verified/total files,
Pause/Resume and an owner-scoped mobile-data preference. Unmetered/Wi-Fi is the
default; enabling mobile data warns about charges. An older pending revision is
shown separately, without adding its counts to the current revision. Explicit
draft deletion pauses pending backups and cannot be bypassed by Resume. It does
not erase originals or existing cloud backups.

Report Activity records explicit user pauses, resumes, network/system/unknown
interruptions and server-verified completion. Offline observations persist until
connectivity and authorization return, even if no upload plan was registered yet.
Unknown process loss is not proof that the user pressed Pause or deleted data.
Captured/report counts remain distinct from exact backup-revision counts.

This supersedes older "nothing uploads automatically" wording **for backup
only**. Report submission, generation, approval and Auctioneer delivery remain
explicit and unchanged. No accepted report is recreated by backup. New backup
plans do not overwrite ordinary cloud drafts. Complete-plan, owner-authenticated
content endpoints support recovery; automatic replacement of local drafts and a
new cross-device backup-restoration UI are not part of this change.

Android can defer background work, and force-stop requires reopening the app.
The seven-day backup-only grant must be renewed online; logout, owner changes or
device restrictions stop authorization. Missing originals require review and are
never silently skipped. iOS/older binaries do not advertise this Android service.
The user must retain the original device until verification completes; uninstall,
clear-app-data, physical loss and manufacturer-specific restrictions cannot be
overridden by the app. There is no automatic retention/pruning policy in this
release; protected original references may continue using device storage.

Roll out backend support first, then admin and a **new native binary**. Configure
`CAPTURE_BACKUP_R2_BUCKET` as a genuinely private bucket separate from current and
legacy public report buckets; turn off its R2.dev/custom-domain public access and
verify policy before enabling backup. Missing/unsafe configuration fails closed.
Existing R2 credentials need permission on this private bucket. See backend
`docs/capture-backups.md`; this is not an OTA-only change. No production access,
customer repair, upload, push, deployment or signed APK release was performed.

Validation includes isolated real SQLite and React interaction tests, owner/race
and 5,000-photo metadata cases, Android/iOS Hermes exports, Kotlin compilation,
and API35 HTTPS/WorkManager interruption checks. See `README.android.md` for the
native test boundary. These are not a physical-device battery/OEM test or a
real 5,000-original end-to-end upload endurance certification.

Final native gate: 104 Jest suites / 1,230 tests, TypeScript, Android/iOS Hermes
exports, arm64 debug application assembly, module test assembly and API35 native
instrumentation pass. Scoped ESLint has no errors (existing array-style and
default-import warnings remain). User labels such as `Data: 2026`, `File: inspected`
and `Asset: tractor` are preserved while genuine local URIs are stripped/rejected.
Receipts: `/tmp/assetinsight-durable-backup-native-final.log`,
`/tmp/assetinsight-backup-hermes-final.log`,
`/tmp/assetinsight-backup-full-debug-final.log` and
`/tmp/assetinsight-capture-backup-native-persistence-final.log`.

## Preserve originals through cloud sync — 2026-10-06 (local; release pending)

Drafts now opens the existing local capture even when a cloud row has a newer
timestamp. Cloud synchronization acknowledges metadata only: it never substitutes
remote URLs for device originals and never automatically prunes their files.
This removes the partial-cloud replacement/cleanup path found while investigating
the 224-photo draft incident. This fix does not recover or modify that customer's
existing draft, server records, or original media.

Cloud-only Continue fetches fresh, owner-bound detail. Every lot, media identity,
slot/index, cover and confirmed size must form a complete mapping before a local
copy is created. A 50-of-224 uploaded manifest is rejected as a whole, with clear
guidance to keep the original device and retry—not restored as 50 or zero photos.
The SQLite insert checks absence atomically, so a local capture saved during the
request, including an accepted/hidden draft, cannot be overwritten. Opening does
not forget a paused upload. Repeated taps, account changes and late responses are
fenced; periodic refresh does not repeatedly invalidate a slow in-flight load.

Backup status compares the actual local/cloud manifest, not the server's upload
progress timestamp. A shorter confirmed remote copy is not a complete local backup.
Cloud acknowledgement/failure applies only to the expected owner, timestamp and
local revision. Legacy uploaded objects with missing byte-size evidence are
confirmed by server HEAD, without sending their bytes again. Normal offline
captures remain manual-submit; reconnect still cannot submit an offline report.

Verification: 101 Jest suites / 1,162 tests, TypeScript and Android Hermes export
pass; scoped ESLint has no errors (existing import/array-style warnings remain).
RN interaction tests exercise both Continue forms, delayed cleanup and parent
handoff, cached/incomplete cloud copies, repeated taps, paused uploads, account
changes, and local saves during loading. Real SQLite tests preserve all 224
original references/activity during a rejected 50-photo replacement. Pure
manifest tests cover 5,000 entries. Isolated backend compatibility checks pass
24 tests; backend runtime is unchanged. Android API35 retained-native harness
passes 254/5,000-photo metadata handoff/recovery and camera layout/720p profile
checks. That harness does not execute the new React screens; physical-device,
real-photo endurance and live Auctioneer continuation remain unverified.

No push, production deployment, customer data repair or signed APK release.
Installed apps require a new native binary, including the retained camera rollback.
Receipts: `/tmp/assetinsight-mobile-continue-draft-final2-tests.log` and
`/tmp/assetinsight-mobile-fixes-final-hermes.log`.

## User boundary

Both native forms default to Online and offer labelled Online / Offline radio
controls. Offline preserves incomplete details, lot order, photo references,
report-only photos, cover selections and edits in an owner-scoped SQLite database.
Save on device, last-save time, missing originals and counts are visible in the
form and Drafts. Separate drafts may share a contract number.

Offline Save/review flow (2026-09-18): new Offline capture has a primary **Save**
action instead of Submit, including incomplete drafts. It flushes older local
saves, commits the explicit snapshot/activity, then closes with a device-only
confirmation. A failed save keeps the editor open; repeated taps coalesce.
The saving screen blocks further edits until the transaction finishes.
**Open and submit** in Offline captures restores the complete saved details,
lot/photo order, report-only photos and cover choices behind a loading/error
gate. Only successfully loaded offline-origin work exposes **Submit** (or
**Resume upload** for interrupted work). Merely autosaving does not enable
submission. Users may edit/save again; opening and reconnecting never submit a report.
The independent Android backup service described above may upload saved originals.
Incoming Create Lot & Continue remains Online-only. Existing submission
identity, assignment validation and missing-original checks are preserved.

Successful review opens enqueue a metadata-only `draft_opened` activity with
counts and logo state in the same owner-scoped journal. Stable per-open IDs and
durable acknowledgement tombstones prevent duplicate events on retry. Opening
does not modify the draft revision, copy media or claim server submission.
Existing capture/edit/save/upload/processing events remain distinct; private
unsent field values and keystrokes are not recorded. Admin shows **Draft opened
for review** after foreground metadata sync. Deploy the additive backend action
allowlist before admin/mobile; no new package or database migration is required.

Both forms show **Photos by lot** in Online and Offline modes, using live local
metadata (`Lot 5 · 8 images`). Drafts use the same compact 10-lot pager. Saved lot
numbers/order are preserved, with positional fallback only for blank numbers.
Report-only images and missing originals are disclosed separately; cover choices,
thumbnails, edited renditions and videos do not inflate image totals. This display
does not save, upload, copy or delete media, or change submission behaviour.

Per-lot display verification (2026-09-18): TypeScript, 68 Jest suites / 525 tests
and Android/iOS Hermes exports pass. Focused cases cover custom/blank/zero lot
numbers, paging 100 lots / 5,000 references, count updates, deletion, missing
originals, report-only images and exclusion of cover/thumbnail/video renditions.
This is component/bundle validation, not a new physical-device acceptance run.

An offline-origin or recovered draft remains manual-submit for its lifetime,
including after switching the radio back to Online. Connectivity, foregrounding,
app restart and the old queue's Force sync cannot submit it. Only Submit / Resume
starts the existing upload workflow. Upload pauses cancel active native,
filesystem, fetch and API transports; ambiguous acceptance retains the same
submission/session identity. An accepted receipt cannot be downgraded by a late
local refresh failure.
Explicit submission intent is persisted before transport starts; an app restart
with ready/uploading/paused state shows Resume upload without scheduling it.

The app does not make an additional original-size copy when saving camera/gallery
photos offline. It reuses MediaStore content URIs or durable camera files. A
temporary imported image may require one managed durable import. SQLite contains
metadata, not photo bytes. Gallery originals and files shared with another draft
are not deleted by save, acceptance or discard. Thumbnails remain disposable.
Photos are **not cloud-backed up** until server verification of backup or an
explicit report upload succeeds. Merely saving metadata is not a media backup. Missing or
inaccessible originals remain in the draft and block submission until repaired.

Android capture writes a durable owner/draft/session journal; the fallback camera
uses an owner-scoped SQLite journal for photos and videos. Exact revisions are
acknowledged only after the local draft commits. Reopening a draft offers pending
journal recovery without launching the camera; a late journal must not replace
edits made while the recovery prompt is open. Failed saves retain the original
and pending layout for an explicit retry. Existing always-on camera watermark
behavior is retained. Offline/manual capture does not start enhancement uploads.

## Identity and migration

### Report Activity journal

Asset/Lot drafts now have a separate owner-scoped SQLite activity outbox alongside
their operational capture inventory. It retains stable photo/lot IDs, per-slot
positions, before/after counts, Next Lot, imports/capture, deletion/reordering,
cover/logo choices and submission-state observations. Explicit Save adds a save
event even for text-only edits, with changed field names only; text autosaves do
not produce a per-keystroke audit or upload private unfinished notes.

The Android camera journal persists event metadata with capture state before
handoff. SQLite stages and acknowledges exact journal revisions, and seen-event
tombstones prevent replay after lost acknowledgements. Fallback capture keeps the
existing durable SQLite handoff and records successfully persisted photo facts.
Activity stores no image bytes and makes no additional original-sized copy.
Camera-reported stamps are separate from the upload-logo switch; server verified
receipt counts are a separate kind of evidence. Existing watermark behaviour is
unchanged.

Foreground sync sends operational events in batches of at most 100/256 KiB,
scoped to the authenticated owner. It clears only acknowledged event IDs, stops
on account changes and never automatically uploads photos/submits/resumes work.
The activity ID is the capture ID; contract numbers can be shared by drafts.
Missing historical facts remain unknown. Removed server history acknowledges
delayed batches without restoring the stream.

Backend support is required before the admin/web release and new native binary.
This camera-journal change is not OTA-only. See the backend `docs/report-activity.md`
for permissions, retention, instrumented server boundaries and release gates.
Unit/SQLite and Android instrumentation cover 5,000 metadata references, journal
restart/replay, Next Lot, deletion/reordering, counts and exact acknowledgements.
This does not certify physical-device capture of 5,000 actual photos, iOS hardware
behaviour, long-duration offline operation or production rollout.

`AutoSaveService.setOwner` binds SQLite, managed media and upload cancellation to
the authenticated owner before displaying drafts. Previously authenticated users
may reopen local drafts offline; first login remains online and known device
restrictions remain enforced. Account changes stop upload/sync work and hide the
previous owner's drafts without deleting them.
Temporary refresh/network failures retain the cached owner and secure session;
definitive access failures remain enforced. Refresh requests are bounded to 15
seconds. Authentication responses and serialized credential writes are fenced so
a late login/device approval cannot resurrect a session after logout or restriction.

Legacy AsyncStorage sources are transactionally quarantined and preserved.
Known owners cannot be overridden. Records lacking ownership require the explicit
“These are my drafts” confirmation and open in the form for review, never an
automatic historical upload. Imported legacy work without a verified assignment
cannot submit until its Incoming mapping is verified. Cached current assignments
can reopen offline; new claims and continuation remain online-only, and manual
submission freshly revalidates the assignment.

## Inventory synchronization

`offlineCaptureSync.ts` runs only while foreground/connected and sends an explicit
allowlist of operational metadata to `PUT /api/capture-inventory/:captureId`.
It never invokes report creation, cloud draft media upload or processing. Each
iteration reads one manifest at a time, at most twenty per run. Original paths,
photo bytes and private form notes are excluded. Device/app metadata is frozen
with its revision, so an app update cannot alter a lost-acknowledgement retry.

Revision-specific acknowledgements cannot clear newer edits. A terminal metadata
conflict is shown in Drafts and does not starve other captures; opening and saving
creates the next retry revision. An admin tombstone is acknowledged without
recreating history. Metadata failure does not prevent local saving or a normally
authorized explicit report submission.

Admin and superadmin see this separate observation ledger in Offline Captures.
Counts are as of the last device sync, not live tracking or backup proof. Server
upload/acceptance/preview/processing states come from actual submission records,
never client claims. Discarded inventory can be explicitly removed by an admin;
this does not delete device files or report records. See
`../assetinsight-backend/docs/capture-inventory.md` for the additive API contract.

## Verification and rollout

### Authoritative acceptance recovery (2026-10-01)

A report ID by itself is not acceptance. Manifest replacement now requires
explicit server permission, and uncertain or malformed receipts keep the draft
visible. If the server proves an earlier accepted report is unavailable and
authorizes separate creation, an ordinary draft offers **Start separate report**.
Only confirmation creates and saves fresh capture/submission IDs. Originals, lot
order and the previous draft/history stay intact; this is not replacement of the
accepted submission and does not use force-new or a supersedes pointer. Incoming
work cannot use this action. Account/form changes and local-save failures block
delayed confirmations.

Replayed acceptance keeps the current draft: the server's matching photo manifest
does not prove later text/settings were accepted. Review the earlier report in
Reports/Previews; do not erase drafts or originals to bypass an uncertain upload.
No reconnect submission or automatic identity rotation was added. Backend receipt
and draft-cleanup safeguards precede the updated mobile binary. See
README.android.md for local verification scope and device limitations.

### Mobile draft and upload recovery (2026-09-30)

Cloud Save Draft/Create Preview supports both draft target modes. When the API
does not supply direct PUT URLs, the app uses the existing authenticated media
endpoint in sequential batches of at most ten URI-backed files. Original files
are not copied into JavaScript blobs. Direct PUT confirmations remain separate
from multipart commits; final saved media must be verified before preview starts.
An uncertain multipart response reads the same draft receipt rather than blindly
replaying the batch. Local drafts, media IDs, lot grouping and order are retained.

Direct report uploads now require a readable positive file size before reserving
a session and freeze nested request details during upload-target refreshes. A
structured `SUBMISSION_MANIFEST_CHANGED` refusal on an ordinary Asset/Lot draft
offers **Keep Draft** or **Upload updated version**. Only the latter persists a
new submission ID together with `supersedesClientSubmissionId` on the same local
draft before transport. Interrupted retries and reopened drafts retain that pair.
It does not set force-new or automatically submit on reconnect. Account changes,
closed forms and failed local saves cannot start a delayed replacement.

An existing report receipt blocks replacement. Auctioneer 2.0 Incoming work keeps
its fixed assignment/submission identity and requires same-upload support recovery;
this change does not rotate imported work IDs or bypass assignment checks. Backend
`ACTIVE_REPORT_EXISTS` during replacement does not offer Create Separate.

Deploy the backend supersession safeguard before releasing this mobile update:
even a failed upload session is immutable once a report, placeholder/outbox,
finalization claim or durable job proves handoff. No migration, new dependency,
automatic historical retry or production repair is part of this change. A new
mobile release is needed for installed clients; server deployment alone does not
replace their JavaScript. Real-device uploads remain a release smoke-test gate.

Verification: 76 native Jest suites / 666 tests, TypeScript and Android/iOS
production-mode Hermes exports pass with an isolated loopback API. Regressions
cover the original missing-URL error, 13 lots / 185 images, lost responses,
replacement identity save/reopen, account change/unmount, failed local saves and
fixed Incoming identities. Scoped ESLint has no errors (existing style/import
warnings remain). No connected device or production request was used; physical
Android/iOS transport and customer-specific recovery are not claimed verified.

### Video references (2026-09-24)

Asset and Lot Listing camera clips remain separate from main/report-only photo counts.
Each capture lot retains its optional video URI, stable identity, MIME, size and ordering
metadata during save/reopen/manual Submit or Resume. Native MediaStore video references
and durable `files/camera-videos` fallbacks are reused, not imported as new originals on
each save. Removing an attachment does not delete the gallery/original file.

Android finalization journals the durable clip first, then journals the gallery URI
before removing its own intermediate. If gallery or journal saving fails, the durable
file is retained. The fallback camera records directly to document storage and keeps
its existing gallery-copy behavior; offline saves add no copies. A process killed before
a recording completes may still leave an incomplete MP4 without a completed handoff;
this is not a successfully saved capture and is not claimed as recovered work.

Reconnection still sends metadata only. The existing upload session owns accepted media
and retries; explicit submission carries videos to R2 and the media ZIP, with sparse
per-lot counts to prevent a later lot's video being assigned to an earlier lot.
See `README.android.md` for recording policy, backend-first rollout and device limits.

Current native gate: all 73 suites / 587 tests, TypeScript, both Hermes exports,
debug/test APK builds and isolated Android video/gallery/journal/streaming
instrumentation pass. Physical iOS and long-video endurance remain unverified.

2026-09-18 Save/review gate: TypeScript and all 69 Jest suites / 547 tests pass,
including real form Save/reopen/Submit, incomplete saves, local failure/retry,
Incoming continuation suppression, restored appraiser values, explicit Resume,
owner changes, duplicate taps, ordered photos/covers and SQLite activity replay.
Android/iOS Hermes exports pass with an isolated loopback API configuration.
Admin verify and 78 policy tests pass; backend verify passes 147 suites / 1,959
tests and build. No emulator was connected for this change: native interaction,
physical iOS and real-device storage/network acceptance are not claimed.
No package change, migration, production access, push or deployment was performed.

Run `npm run typecheck && npm test`, Android/Hermes export and native camera
instrumentation with an isolated API/network boundary. Test both report types,
account switching, 5,000-photo metadata, missing/denied originals, repeated saves,
crash recovery, airplane-mode reopen, explicit upload/resume and lost receipts.
Native storage/race tests complement rather than replace device testing.

2026-09-17 final local gate: native TypeScript and 66 Jest suites / 507 tests pass;
Android and iOS production-mode Hermes exports pass against an isolated loopback
API configuration. Android debug compilation and camera journal/watermark
instrumentation also pass. Backend verification (1,926 tests), report-workflow
checks, admin verification and 70 policy tests pass. Isolated admin Chromium
checks cover 320–1440px light/dark views, pagination, access, conflicts and removal;
inventory IDs in these fixtures use the actual 64-character server hash contract.

Android emulator UI checks at 320dp / 130% font cover both forms, keyboard editing,
local save, process restart, reopen and light/dark offline controls. Native
MediaStore-to-loopback HTTPS instrumentation verifies exact bytes/length,
progress, cancellation and four-transfer concurrency. The Asset Images panel
and camera controls share one bounded scrolling viewport; footer actions wrap.

Added package: Expo SDK 54-compatible `expo-sqlite ~16.0.10` (native plugin).
Publish backend support first, then admin and a new mobile binary. An OTA-only
update is not sufficient for SQLite/native camera additions. No Auctioneer API
change or cloud data migration is required. Physical iOS capture, actual low-disk
conditions and full large-photo network interruption trials remain release
acceptance checks; do not infer them from unit or emulator tests. No production
repair, historical submission, push or deployment is part of this change.
