# VClimateStatus

Read-only climate screen for BMW MGU / iDrive 7. The current screen shows the
driver and passenger setpoint slots, A/C state, and a clear signal status. No
climate setters, commands, or write permissions are declared.

## Current implementation

- App id and title: `vclimatestatus` / `VClimateStatus`.
- English-only, BMW M Dark Red dashboard, 1600 x 520 logical canvas.
- A/C status uses `de.bmw.infotainment.climate.Climate2.statusACFront`, with
  the nested `statusAircon` values interpreted as documented in the upstream
  `idrive7-apps` implementation.
- Vehicle updates use the OAP kit's SOME/IP field subscription and initial
  getter. The confirmed A/C state is re-read every 5 seconds as a freshness
  check; no temperature signal is declared or inferred.
- The temperature slots intentionally render `--°C` and `SIGNAL UNAVAILABLE`
  in live mode. No public source inspected so far confirms the exact driver and
  passenger setpoint fields, their nested structure, or scaling.
- The value/degree unit position is measured from the rendered text width.
  `HI`/`LO` are treated as special display strings without a numeric unit;
  `--` remains the unavailable placeholder and retains the °C marker.
- There is no demo setting or climate control in the installed app. Only the
  offline preview stub sets `ctx.preview`; the 22°C / 21°C values require that
  marker and `hasNative() === false`, and are labelled `DEMO VALUES · NOT
  VEHICLE DATA` as well as `LOCAL PREVIEW VALUE` on each card.
- The manifest's only setting is a hidden internal `repoCredit` marker. It
  keeps the build kit's normal credits row in its generated settings screen;
  it does not enable demo mode or vehicle control.
- Invalid A/C payloads, provider loss, and 15 seconds without a fresh value
  clear the displayed state and show `SIGNAL UNAVAILABLE`. The watcher polls
  its getter every 5 seconds while the provider is available.
- On the OAP `shutdown` event, the app clears its redraw and freshness timers
  and calls the subscription's `shutdown()`. The kit watcher also clears its
  poll timer and calls the SOME/IP proxy's `shutdown()`; callbacks arriving
  after that are ignored.

## Signal research

The upstream `idrive7-apps` project uses these climate fields:

- `ClimateMaster.statusClimateSystemOn`, whose list members include
  `airConditioningOn` and `operationZone`.
- `ClimateMaster.statusAirCondAC`, whose list members include `acButton`.
- `Climate2.statusACFront`, whose nested member is `statusAircon`.

These document climate/A/C state, not the two target temperatures. The public
repo does not include BMW's full SOME/IP master catalog. The exact catalog on
this car is needed to inspect available fields and datatypes:

```text
/etc/oap/someip/someip-interfaces.json
```

After a read-only copy is saved locally as
`reference/someip-interfaces.json`, inspect the climate interfaces:

```powershell
python kit\tools\sigdoc.py de.bmw.infotainment.climate.climatemaster.ClimateMaster
python kit\tools\sigdoc.py de.bmw.infotainment.climate.Climate2
python kit\tools\sigdoc.py de.bmw.infotainment.climate.Climate
```

The concrete discovery sequence is:

1. List every catalog interface whose name contains `climate` or `IHKA` and
   inspect its fields and nested datatypes with `sigdoc.py`. Search datatype
   members for temperature/setpoint/target terminology; treat these as search
   terms only, not as signal names.
2. For each catalog candidate, verify the exact field name, getter ID,
   notifier, datatype, nested zone identifier/enum, unit and scaling in the
   raw catalog. Do not infer a driver/passenger mapping from field order.
3. Compare candidate values with the factory climate display, changing only
   one zone at a time. Confirm numeric values, `HI`/`LO`, and invalid/sentinel
   encodings before adding a decoder.
4. Add only catalog-confirmed read flags (`r`/`s`) to `app.json`, then run
   `python kit\tools\check_signals.py` against that catalog. Add the matching
   callbacks to `main.js` only after the zone mapping and units are verified.
   Use notifications when present; retain a getter poll only if the catalog or
   vehicle testing shows notifications are absent or unreliable.

### Network access assessment

- **BMW OAP:** preferred route. Applications declare specific services and
  fields in their manifest; MainApp generates per-app SOME/IP access from the
  HU_MGU's catalog. The runtime in this project provides `signals.watch()`.
- **SOME/IP:** the project confirms that vehicle data is exposed to apps via
  service fields, with notifications plus an initial getter. The climate state
  fields above are proven examples. Setpoint availability is still specific to
  the HU_MGU catalog and must be checked.
- **Raw CAN:** this OAP app kit exposes SOME/IP subscriptions and selected UDS
  diagnostics, not a general raw CAN frame reader. The vehicle gateway controls
  which bus values are made available to the MGU. Public CAN examples for older
  BMW generations are not valid evidence for G20 MGU18 IDs, byte layouts or
  scaling. This project does not access raw CAN or change gateway/firmware
  settings.
- **Existing apps:** upstream eDrive uses climate/A/C status and HVAC power
  figures. The public code inspected does not show driver/passenger setpoint
  values. It is useful for a known-good read-only subscription pattern, not as
  evidence for the setpoints.

## Build and preview

Windows is supported by the upstream kit using Python 3.6+ and Node.js 14+;
WSL2 is optional. A local installable package needs BMW's `oap-sdk`, which the
public repository intentionally omits. The SDK can be extracted from an OAP
donor app on the owner's HU_MGU. Alternatively, the existing MGU Store repo
configuration describes a source build on the head unit, where its deploy
tool can link against the SDK already installed there. Confirm that the
installed Store version accepts this repo schema before installing.

Offline preview (no BMW SDK and no car connection):

```powershell
python kit\tools\build.py vclimatestatus --preview-only
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus render
```

The PNG output is local preview only and is not an installable package.

To visually inspect the special temperature labels without connecting to a
car, override the preview-only values (the `DEMO` marker remains visible):

```powershell
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus-special --set demoDriver=HI --set demoPassenger=LO render
node kit\tools\preview.js dist\vclimatestatus preview\vclimatestatus-missing --set demoDriver=-- --set demoPassenger=21 render
```

`app.json` is the MGU App Kit input manifest. `mgu-repo.json` uses the Store's
repo-tree `apps` layout and supplies the kit build script, SDK folder, output
pattern and shared build inputs. That layout is supported by the published
MGU Store publishing guide. Whether the Store version installed in a specific
car accepts this exact repo revision still requires checking that Store's
version; no Store or vehicle install was performed here.

## Vehicle validation still required

1. After SSH access is separately available, confirm it with a read-only login
   and `id`; do not run an installer or restart a service for this check.
2. Copy `/etc/oap/someip/someip-interfaces.json` from the HU_MGU read-only and
   inspect the climate datatypes using the steps above.
3. Confirm driver/passenger zone mapping, units/scaling, and whether each
   setpoint field has a notifier. Compare against the factory climate display
   while changing one side at a time.
4. Add the verified fields, build, and perform an offline preview before any
   installation.
5. Review the exact install plan and backup/rollback behavior. Install only
   after the owner approves it; verify read-only behavior and remove through
   the same Store/deploy mechanism if needed.

No changes have been made to the vehicle.
