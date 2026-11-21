# PERFORMANCE

PERFORMANCE 0.6.10 is a BMW HU_MGU / iDrive 7 monitor. The black-and-
red display places live **HORSE POWER** and **TORQUE** gauges in the large left
area. The right area shows **DYNO RUN**, Engine Speed, and **TURBO BOOST**. The dyno card
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

## ENGINE CONFIG page

The second page opens on a compact section picker with a square exhaust icon
and a single **EXHAUST SYSTEM** button. Selecting it opens the BMW exhaust
controls; the picker has no car image and sits at the left for future sections.
The controls page has matching tall sidebars that start level with Engine Data
and extend to the content bottom, headed **SELECT MODE** and **EXHAUST MODE**, with
**BMW EXHAUST SYSTEM** above the centered car. The right card shows **CURRENT
MODE**; the driving mode appears only when **BY DRIVE MODE** is selected.
The app ignores BMW's initialization mode value and makes a short read-only
refresh while waiting for the first valid drive mode. Physical valve position
remains unverified.
The supplied Jersey 75 font is not embedded: its included license disallows
redistribution and modification. The page uses the app's bundled bold display
font until a redistribution license is available.
**Car Model** in Settings selects one of the six original PNGs supplied in
`assets/car-models/`; the default is
`M340i_Blue.png`. The selection is saved by the app's normal settings storage
and is used again when PERFORMANCE starts. The selected car uses a contain fit
that preserves its full aspect ratio. Transparent image areas use the screen
background, without a grey panel behind the car.

The PNG source files are kept byte-for-byte as supplied. The two Blue files
provide transparent body cutouts. The Red and Black files have baked studio
backgrounds; the app uses the transparent Blue cutout for the matching chassis
to remove those backgrounds while keeping the selected car's own image pixels.
Transparent areas are composited onto the screen background. The app decodes
only the selected image (and its matching cutout) and downsizes it in memory to
fit the renderer's 1024-pixel texture limit; it does not rewrite the source
artwork. The native MGU renderer receives the image through its documented
pixmap protocol, which supports images alongside touch and controller input.

Animated grey wisps are anchored to separately measured coordinates for each
of the six files. Closed, OEM, and Comfort-by-drive-mode show wisps from the
left pair; an Open request shows wisps from all four tips. Small animated
butterfly markers inside the outlets follow the requested valve mode. Smoke
and valve graphics are visual effects, not measurements or confirmation of
physical valve position.

The page offers **OPEN VALVES**, **CLOSE VALVES**, **OEM CONTROL**, and **BY DRIVE MODE**.
Drive Mode follows the existing Engine Config mapping: Sport opens, Comfort and
Adaptive return control to BMW, and Eco Pro closes, with the same plug-in hybrid
mode handling as that app.

The valve controls adapt the upstream Engine Config controller and per-DME adapter.
**Exhaust valve control** defaults to **Disarmed**. With it off,
the buttons send no vehicle command and the page says so. When explicitly armed
in the app settings, the app first makes read-only DME identity and flap-capability
checks; it will not send the control request if a matching flap is not detected.
The close-RPM guard defaults to 4,000 rpm and fails back to BMW control if fresh
RPM is unavailable. Repeating the request every 15 seconds is optional and off
by default. Drive Mode following is only enabled by pressing its page button.

The reused MG1 adapter sends BMW's existing UDS `0x2F` control for DID `0x60FD`
only after the setting is armed and a read-only flap match succeeds. It requests
10% for open, 90% for close, and `returnControlToECU` for OEM. The local source
reports testing on an MG1 and a G20 320i, but this has not been verified on this
M340i. The DME reply and `0x62FD` commanded target are shown as command feedback;
`0x64FD` output bytes are not decoded here, so the graphic does not claim that
the physical flap moved. Closing the app stops hold repeats; the DME is expected
to resume its own strategy after its short-term override expires.

On Engine Data, **M SOUND MODE** requests OPEN from the same guarded controller;
pressing it again requests OEM control. The button is red while the app's open
request is active and grey when it is off or unavailable. It requires the same
explicit Car control arming and matched-DME checks as the Engine Config buttons.
The DME acceptance and commanded target do not prove the flap is physically at
100%, because the `0x64FD` output-position payload has not been decoded or
validated on this car. Opening the flap also does not select Sport Plus or
command pops and bangs; those sounds remain under BMW's driving-mode and DME
strategy.

## Virtual Dyno card

The card records the peak HP and Nm from a full-throttle road pull, using the
same road-load method as the upstream Virtual Dyno: acceleration, speed, selected
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

PERFORMANCE adapts signal scaling, power selection, unit conversion, and
boost-candidate order from the upstream M Vitals reference. Its road-dyno and
exhaust-valve logic also adapt relevant upstream references. The upstream app
packages are not included in this repository branch. Shared MIT licensing and
attribution are retained in `LICENSE` and the relevant source comments.

The engine monitor and boost candidates use SOME/IP subscriptions and read-only
UDS/OBD requests. Exhaust flap control is the only write path, isolated behind
its disarmed-by-default setting, a matching DME capability check, and a manual
page action. Demo is off by default; dyno recording pauses in Demo and the screen
clearly marks simulated live readings.

## Local checks and preview

From the repository root on Windows:

```powershell
node kit/tools/test_performance.js
node kit/tools/test_performance_dyno.js
node kit/tools/test_performance_car_images.js
python kit/tools/build.py performance --preview-only
node kit/tools/preview.js dist/performance preview/performance-demo --set demo=on render
node kit/tools/preview.js dist/performance preview/performance-live --set demo=off render
```

Preview-only does not include BMW's OAP SDK and is not installable. Local tests
cannot confirm live signal availability, the car's DME replies, or the road
Dyno estimate against a pull in this vehicle.
