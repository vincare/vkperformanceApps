# VClimateStatus

Read-only climate monitor for BMW MGU / iDrive 7. It uses a catalog-confirmed
front-zone setpoint candidate and the catalog-confirmed A/C status. It displays
front driver and passenger values when the HU_MGU supplies valid records. It
declares no climate setters, commands, or write permissions.

## Implementation

- App id/title: `vclimatestatus` / `VClimateStatus`; version `0.4.0`.
- English UI, dark BMW M-style colors, 1600 x 520 logical canvas.
- A/C: `de.bmw.infotainment.climate.Climate2.statusACFront` (`rs`). The
  nested `statusAircon` enum maps `0` to off, `1` to on, and all other values
  (including catalog value `3`, invalid) to unavailable.
- Setpoint: `de.bmw.infotainment.climate.climatemaster.ClimateMaster.statusTemperature`
  (`rs`), instance `1`, service ID `45210`, interface version `1.0`. The field
  has getter ID `2`, notifier event ID `32801`, event group `1`, and is marked
  unreliable in the catalog. Its declared array can contain up to six
  `StatusTemperature` records.
- Each record has `targetTemperature` (`Float`), `operationZone` and
  `saveLUM`. Catalog enum values `DRIVER=1` and `PASSENGER=2` select the two
  front zones. Other enum values, including `ALL_ZONES` and second/third row
  zones, are ignored instead of being assigned to a front seat by position.
- The catalog does not state the Float's unit, scale, special-value encoding,
  or whether HI/LO can be represented. Live numbers are therefore displayed
  without a `°C` suffix and marked `LIVE VALUE · UNIT UNVERIFIED` until the
  values are compared with the factory display. Non-finite or non-numeric
  payloads are rejected. HI/LO are supported only as offline preview strings;
  they are not guessed from numeric sentinel values.
- The separate `Climate2.statusAirConditionDRStatus` and
  `statusAirConditionPSStatus` fields contain UInt8 temperature target members,
  but the catalog does not define their encoding. They are intentionally not
  used as a fallback.
- A valid front-zone record updates only that zone. Provider loss clears both
  displayed values. A zone with no valid record remains waiting; a zone whose
  last accepted record is older than 15 seconds is cleared and marked stale.
  The kit performs initial getters and re-reads subscribed getter fields every
  five seconds while the provider is available.
- Offline demo values `22` / `21` require the preview stub, no native SOME/IP
  module, and the preview-only `demo=on` setting. They are explicitly marked
  `DEMO VALUES · NOT VEHICLE DATA` and `LOCAL PREVIEW VALUE`. The installed
  manifest contains no demo setting; the live path never falls back to them.
- The optional `Climate signal diagnostics (raw)` app setting is off by default.
  When enabled, each received `statusTemperature` record writes its UTC receive
  time, raw `operationZone`, mapped zone name, raw `targetTemperature`, and
  `saveLUM` value through `ctx.log`. The MGU kit writes this to the app's own
  `data/vclimatestatus.log` and the system log; its file log rotates at 256 KiB.
  Unsupported payloads are logged in a short, capped form. The main screen is
  unchanged, and diagnostics can be switched off after the test.
  Example: `CLIMATE_DIAG statusTemperature rx=2026-11-20T12:00:00.000Z zoneRaw=1 zone=DRIVER targetRaw=24 saveLUMRaw=false`.
- On the OAP app `shutdown` event, redraw/freshness timers are cleared and each
  resolved watcher is shut down. The kit watcher stops its poll interval,
  ignores subsequent callbacks, and shuts down its SOME/IP proxy.

## Catalog evidence and limits

The provided `someip-interfaces.json` is valid JSON and contains the exact
interfaces and datatypes above. The provided `climate.txt` is a truncated
extract, not valid JSON; it contains none of the exact setpoint field/type
names, so it cannot establish additional interfaces or encodings. The JSON
catalog is the source used for this implementation.

The other candidate names `ClimateDriver`, `ClimatePassenger`, and
`CLIMATEANDRADIOCONTROL` are not interface names in this catalog and are not
used as signal guesses. `Climate2.statusAirConditionDRStatus` and
`statusAirConditionPSStatus` are real catalog fields, but their UInt8 encoding
is unconfirmed. The chosen `ClimateMaster.statusTemperature` field provides
the explicit zone enum and a Float target member, but the live payload shape,
unit and behavior on this specific HU_MGU still need vehicle-side validation.

Catalog cross-checks for this app (replace the path with the supplied catalog
location):

```powershell
python kit\tools\check_signals.py C:\Users\User\Downloads\someip-interfaces.json
```

`check_signals.py` checks every app manifest in the repository against the
catalog, so unrelated repository/catalog mismatches may also be reported.
For the ClimateMaster datatype details, inspect the catalog's
`interfaces["de.bmw.infotainment.climate.climatemaster.ClimateMaster"]` and
`datatypes["de.bmw.infotainment.climate.climatemastertypes.ClimateMasterTypes.StatusTemperature"]`
entries, along with `Temperature` and `OperationZone`.

## Build and offline preview

Windows is supported by the kit for building/previewing. WSL2 is optional. A
preview-only build does not need BMW's private `oap-sdk` and is not an
installable vehicle package:

```powershell
python kit\tools\build.py vclimatestatus --preview-only
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus render
```

Preview the display-only HI/LO and unavailable cases. These overrides are
local to the preview process and never become vehicle values:

```powershell
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus-special --set demo=on --set demoDriver=HI --set demoPassenger=LO render
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus-missing --set demo=on --set demoDriver=-- --set demoPassenger=21 render
```

An installable package needs the BMW OAP SDK and platform validation. No
local installable package has been generated in this workspace because the
private `oap-sdk/index.js` and `oap-sdk/package.json` are absent. The project
README's documented way to obtain them for a local build is to copy the stock
`x_call` package from the owner's unit and extract it locally:

```powershell
scp root@<unit>:'/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz' .
mkdir x_call
tar xzf x_call@*.tgz -C x_call
node kit/tools/extract_sdk.js x_call/javascript/app.js
python kit/tools/build.py vclimatestatus
```

The SDK is BMW code; `oap-sdk/` is git-ignored and must not be uploaded to
GitHub. Python 3.6+ and Node.js 14+ are the local build requirements from the
project README. The current workspace has Python 3.12 and Node.js 25; no npm
packages or Docker are needed for this app.

## MGU Store compatibility and separate-app install

The root `mgu-repo.json` uses the kit's existing repo-tree build: `apps/*`,
`app.json`, `python kit/tools/build.py {id}`, SDK folder `oap-sdk`, and output
`dist/{id}@{version}.tgz`. This matches the repository's build output. The
MGU Store repo-tree flow builds a selected app from a GitHub branch on the unit;
its `build.sdk` support supplies the private SDK module from a stock BMW donor
to the temporary build copy. The SDK should not be committed. The car-side
build also requires the Store's `mgu-python` tool; the last project inventory
reported version 1.0.3, but that was not rechecked during this change.

The app declares id `vclimatestatus` and `mguHmi: ["ID7"]`. It is an OAP app,
not a tool or replacement package for a BMW app. Normal installation creates a
separate app entry and app-specific SOME/IP access configuration. It does not
replace a factory app's package. The installed Store version and its exact
install transaction have not been checked, so a process restart or Store-level
fallback cannot be ruled out. Under the current no-restart constraint, do not
confirm an install if the Store reports that a system process must restart or
that a factory file/service must change. Do not use this repository's manual
`deploy/push-to-car.ps1 install` path for this test; the root README documents
that path as installing the whole custom-app kit and restarting the app
platform.

For the MGU Store route, first push the updated project branch, then add the
GitHub repository as a branch source and select only `VClimateStatus` from
`codex/vclimatestatus`. The current 0.4.0 edits are local and have not been
pushed, so the Store cannot see them yet. No package has been installed on the
vehicle as part of this change.

## Vehicle validation required before claiming complete live °C values

1. Build and preview offline first. Confirm the demo label and the unavailable,
   HI and LO layouts. The offline preview does not simulate vehicle SOME/IP.
2. After the updated branch is available in MGU Store, review the single-app
   install details. Do not proceed if it proposes a factory-file/service
   change or a system-process restart.
3. Once installation is separately approved, enable `Climate signal diagnostics
   (raw)` in the app settings. Use the factory climate controls to set Driver to
   24°C and Passenger to 27°C, changing one side at a time. The app itself has
   no climate controls.
4. In `Settings > QR log` or the app's `data/vclimatestatus.log`, confirm log
   entries with `zoneRaw=1 zone=DRIVER targetRaw=24` and
   `zoneRaw=2 zone=PASSENGER targetRaw=27`, each with its UTC `rx` time. The
   QR log may shorten long lines; the app data log retains the full entry.
5. Confirm Celsius/no scale conversion and prompt updates against the factory
   display before adding `°C` to live values. Do not infer HI/LO or invalid
   sentinels from Float values. Switch diagnostics off after capturing the
   short test.
6. Remove the app only through MGU Store if needed. Do not run a system-level
   install/restore procedure without separate approval.

No vehicle settings, system files, or installation state were changed.
