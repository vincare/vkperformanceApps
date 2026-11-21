# PERFORMANCE

PERFORMANCE 0.6.0 is a read-only BMW HU_MGU / iDrive 7 monitor. The black-and-
red display places live **HORSE POWER** and **TORQUE** gauges in the large left
area. The right area shows **DYNO RUN**, Engine Speed, and Boost. The dyno card
always selects the latest valid saved run. The two gauge limits can be changed
separately in Settings; the defaults are 300 hp and 800 Nm.
Each scale now labels its configured endpoint explicitly, including values
that do not fall on a regular tick interval.

## Live engine readings

- **RPM** comes from BMW SOME/IP `CDS.statusEngineSpeed2`, field
  `actualValueRPMEngineCrankshaft`, scaled by 0.25 rpm per raw count.
- **Live torque** comes from BMW SOME/IP `FES.statusActualValueTorque2`, field
  `actualValueTorqueCrankshaft`, scaled as `raw × 0.5 − 1023.5 Nm`. Negative
  engine-braking values are shown as zero, as in M Vitals.
- **Live power** prefers BMW's `FES.statusVehicleDynamicEngine` field
  `displaySportEnginePower`. This is a percentage, not an HP value; the app
  multiplies it by the configured maximum power in kW, then converts to kW,
  hp, or PS. The setting defaults to 215 kW, matching M Vitals' default. Use
  the same maximum and power unit in both apps to compare the number. If the
  percentage is unavailable or `Torque × RPM` is selected, power is estimated
  as `Nm × RPM / 9549` kW.
- **Boost** in Auto mode prefers the FES Sport Display signal once it changes
  by at least 0.03 bar. Its scale is still unverified, so that source is marked
  approximate. Otherwise, the app tries the same read-only candidates as M
  Vitals: DIDs `F470`, `F487`, `F40B`, then OBD PID `0B`, decoded as absolute
  kPa; it subtracts barometric pressure from `F433`, then OBD PID `33`, to
  calculate gauge pressure in bar. When barometric pressure cannot be read,
  101.3 kPa is used and the display labels the result an estimate.

## Virtual Dyno card

The card records the peak HP and Nm from a full-throttle road pull, using the
same calculation as the local `apps/dyno` app: acceleration, speed, selected
vehicle weight, body drag, rolling resistance, and drivetrain-loss settings.
Power is calculated from road load; dyno torque is derived from that power and
RPM. These are road estimates, separate from the live BMW Sport Display and
FES torque readings. The default weight, body, and drivetrain loss match the
DYNO app defaults. Set them to the same values in both apps for comparable
results.

A pull is saved only when it stays in one gear and spans at least 1,500 rpm.
The app needs fresh RPM, speed, and longitudinal-acceleration signals; a
short or interrupted pull is not presented as a valid result. The card shows
which prerequisite is missing (RPM, speed, acceleration, or signal freshness)
and records gate changes in diagnostics. Start above 15 km/h and 1,200 rpm,
with acceleration above 0.12 g; hold one gear for a sweep of at least 1,500
rpm. The latest completed PERFORMANCE pull is kept in the app's own data
folder. MGU gives each app its own data folder, so existing saved runs inside
the separate DYNO app are not imported. A new pull recorded after installing
this version will appear here.

## License and safety

M Vitals source is present locally at
`CUSTOM APPS/idrive7-apps-main/apps/car_vitals` and publicly in the upstream
repository. PERFORMANCE adapts its signal scaling, power selection, unit
conversion, and boost-candidate order; it does not copy the full app. The
Virtual Dyno calculation is adapted from this repository's `apps/dyno`. The
repository's MIT license and attribution are retained in `LICENSE`.

The app only subscribes to SOME/IP signals and sends read-only UDS `0x22` or
OBD `0x01` requests for boost candidates. It has no coding, reset, actuation,
or write operations. Demo is off by default; dyno recording pauses in Demo and
the screen clearly marks simulated live readings.

## Local checks and preview

From the repository root on Windows:

```powershell
node kit/tools/test_performance.js
node kit/tools/test_performance_dyno.js
python kit/tools/build.py performance --preview-only
node kit/tools/preview.js dist/performance preview/performance-demo --set demo=on render
node kit/tools/preview.js dist/performance preview/performance-live --set demo=off render
```

Preview-only does not include BMW's OAP SDK and is not installable. Local tests
cannot confirm live signal availability, the car's DME replies, or the road
Dyno estimate against a pull in this vehicle.
