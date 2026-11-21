# Climate Control

Read-only climate status app for BMW MGU / iDrive 7. It shows the driver's and
passenger's setpoints when the HU_MGU supplies valid records and reports the
real A/C status. It does not adjust climate settings and declares no climate
setters, commands, or write permissions.

## Implementation

- App id/title: `vclimatestatus` / `Climate Control`; version `0.4.2`. The id
  stays the same so MGU Store updates the existing app instead of adding a
  second tile.
- English UI, black and red BMW M-style graphics, 1600 x 520 logical canvas.
- The screen contains only read-only setpoint and A/C status. Its airflow lines
  are decoration; it has no pretend temperature arrows, fan controls, defrost
  controls, or seat-heating buttons.
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
- Temporary raw diagnostics were enabled by default in 0.4.1 and remain
  available in 0.4.2 through the `climateDiagnostics` setting. The main screen
  can show real values only when the vehicle sends them. Startup logs whether
  diagnostics are active; setpoint diagnostics record interface-config lookup,
  whether `statusTemperature` is declared with a getter, proxy initialization,
  availability subscription, field-subscription result, provider availability,
  getter errors, and a 30-second no-payload result. Each distinct raw payload
  records UTC receive time, its source (`event` or `getter`), raw
  `operationZone`, mapped zone, raw `targetTemperature`, and `saveLUM`. An
  unchanged value is repeated in the log at most every 30 seconds. The MGU kit
  writes this to the app's own `data/vclimatestatus.log` and the system log; the
  file log rotates at 256 KiB.
  Example: `CLIMATE_DIAG statusTemperature rx=2026-11-21T12:00:00.000Z source=getter record=0 zoneRaw=1 zone=DRIVER targetRaw=25 saveLUMRaw=false`.
- `app.json` settings are built into the app's HMI interface; they are not
  toggled from MGU Store's own Settings page. In 0.4.0 the canvas had no
  `BTN_SETTINGS` action, so the generated app Settings screen had no route from
  the screen the user opened. Version 0.4.1 added that standard action. Open
  `Settings` in the app header or tap the screen's Settings icon to reach the
  app settings and its `QR log` row.
  The existing QR log shows the recent app log as scannable pages, without SSH.
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

For the MGU Store route, publish the updated project branch, then refresh the
GitHub repository source and select only `Climate Control` from
`codex/vclimatestatus`. Version 0.4.2 source changes are local until published.
No package has been installed on the vehicle as part of this change.

## Vehicle validation required before claiming complete live °C values

1. Build and preview offline first. Confirm the demo label and the unavailable,
   HI and LO layouts. The offline preview does not simulate vehicle SOME/IP.
2. After the updated branch is available in MGU Store, review the single-app
   install details. Do not proceed if it proposes a factory-file/service
   change or a system-process restart.
3. Once installation is separately approved, diagnostics should already be on
   from the 0.4.1 or newer update. Confirm `Temporary climate diagnostics (raw)` is On
   under the app's Settings. Use the factory climate controls to set Driver to
   24°C and Passenger to 27°C, changing one side at a time. The app itself has
   no climate controls.
4. In the app, open `Settings > QR log`, photograph every page, and share the
   images. The project decoder can reconstruct them on a computer with
   `python kit/tools/qrlog_decode.py <folder-of-photos>` (requires `zxing-cpp`
   and `pillow`). Alternatively, retrieve the full
   `data/vclimatestatus.log` from the app's own data directory. The QR view is
   the simpler path and does not need SSH.
5. Check whether the log says the field is declared, has a getter, the event
   subscription call resolved, the provider became available, and whether a
   `statusTemperature` payload arrived. If it did, compare raw zone IDs and
   values against the factory display; do not assume units or scale.
6. Confirm Celsius/no scale conversion and prompt updates against the factory
   display before adding `°C` to live values. Do not infer HI/LO or invalid
   sentinels from Float values. Switch diagnostics off after capturing the
   short test from the app's Settings.
7. Remove the app only through MGU Store if needed. Do not run a system-level
   install/restore procedure without separate approval.

No vehicle settings, system files, or installation state were changed.
