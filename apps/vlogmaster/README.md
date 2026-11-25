# VLogMaster 0.1.0

Standalone read-only logger and analyzer for BMW MGU / iDrive 7. Initial reference vehicle: M340i G20 Pre-Facelift, B58TU, ZF8HP. It lives in its own app directory and has its own manifest and local data store; it does not alter PERFORMANCE, MoreAmbients, or other apps.

## Resource review and first implementation

- The source repository includes the PERFORMANCE app and the shared MGU runtime. No separate VKP-DEVSCAN app directory was present in this checkout, so the initial design follows PERFORMANCE's canvas/navigation conventions and uses the shared chart and read-only diagnostic helpers.
- The supplied HU_MGU `someip-interfaces.json` describes service schemas and IDs. A schema entry is not proof that the vehicle provider is available or that it has returned valid data. VLogMaster records availability and freshness and shows `CHECKING` / `UNAVAILABLE` instead of inventing values.
- The initial MGU channel set is limited to read-only signals already consumed by PERFORMANCE: engine speed/status/temperatures, speed, torque, gear, exterior temperature, battery charge, tank range/level, longitudinal acceleration, gearbox oil temperature and TPMS pressure/temperature/targets.
- Optional DME/EGS channels use the same guarded `ReadOnlyDiag` + `DidReader` code path and bounded candidate definitions used in PERFORMANCE. The diagnostic reader is opt-in, sends one queued read at a time with pacing, and is activated only for selected channels or a manual health check. Unsupported or refused candidates stay unavailable. These are ECU-dependent candidates, not promises that every DME/EGS will answer.
- No setter, ECU coding, reset, DTC clear, diagnostic session, routine, or control command is enabled in this app. UDS writes are blocked by the shared read-only wrapper. DTC listing remains unavailable: the shared wrapper does not allow UDS service 0x19; HU_MGU's `DtcService.readDtcStatus` is an enum-based status lookup, not a generic DME/EGS fault-list reader. VLogMaster does not call it.

## Technical plan

1. Use one Vehicle Data Manager to own MGU subscriptions, value decoding, timestamps, freshness, source, availability and an opt-in paced read-only DME/EGS queue.
2. Feed live views and recording from the same manager so values are not subscribed twice. Recording is triggered by incoming valid data, not graph redraws.
3. Store logs as buffered JSON Lines under the app data directory, with a separate metadata index. Export CSV and JSON locally; do not start a network listener.
4. Keep Health Check evidence-only. Show measured values separately from fault assessment. No NORMAL, WARNING or CRITICAL verdict is emitted without valid evidence and vehicle-specific, validated limits; until those exist, the assessment is UNAVAILABLE even when live measurements are shown. DTC status is explicitly unavailable in this release.
5. Keep background recording off until the target MGU's app lifecycle has been confirmed. The shared runtime has a background-app hook, but repository presence of that hook alone does not establish reliable unattended recording on this HU_MGU.
6. Add further channels only after checking schema, existing validated decoders, provider availability and real-car read-only response; retain per-signal unavailable states for unsupported cars.

## Recording and data handling

- Profiles are editable in the app; custom channel selection and local history are independent of the source app.
- Sample counts and rates are calculated from the data events received. The current actual-Hz field is the aggregate event rate for a log; per-channel counts are retained.
- The recording page shows a live trace for the focused channel and its running minimum / average / maximum. Sampling frequency excludes paused intervals; wall-clock duration still includes them.
- The analyzer includes channel selection, zoom controls and timeline stepping. Text/enumeration channels are stored as events and values, while numeric channels are plotted.
- If the app exits unexpectedly, the next start rebuilds the interrupted log's counts, statistics and measured event rates from the successfully flushed JSONL rows.
- CSV/JSON files are saved under the VLogMaster app data directory. QR transfer and phone download are not enabled: the Climate app's QR helper stores diagnostic text in a QR image and is not a file-transfer service; no verified MGU local-network server API was found.
- Background/hidden recording is not enabled in this initial version. The app flushes its in-memory batch every four seconds and during normal shutdown.

## Current coverage boundaries

Real MGU metrics appear only after the corresponding provider sends a valid value. A small first set of DME/EGS channels can be requested through read-only identifiers already configured by PERFORMANCE; each remains a vehicle-dependent candidate until this M340i returns a valid response. GPS position, wastegate position, target boost, target rail pressure, lambda/AFR, short/long trims, misfire counters, per-cylinder timing/knock, battery SOC, charging/auxiliary battery status and generic DME/EGS DTC listing remain marked unavailable. TPMS values are not decoded until the car reports valid pressure and temperature units. Health thresholds are intentionally not guessed from the broad candidate sanity bounds in PERFORMANCE.

## Controls

Use the header pages or iDrive controller to navigate. On Live Data, selecting a DME/EGS-backed card opts that channel into paced read-only polling. On Data Recording, select channels, then start/stop or pause. Profiles populate the selected channel set and remain editable. History can be analyzed, compared and exported. Health Check collects available read-only values and reports coverage; it does not clear or change faults.

## Real-vehicle validation still required

This source code cannot prove provider availability, DID support/scaling, actual sample rates, thermal/fuel limits, background lifecycle, or behavior on a specific modified B58TU/EGS. Confirm these on the parked vehicle before relying on any health interpretation. The application has no write path.
