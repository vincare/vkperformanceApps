# PERFORMANCE

PERFORMANCE is a read-only BMW HU_MGU / iDrive 7 engine monitor. Version 0.3.0
keeps its existing black-and-red sports display and uses the same signal
mappings and calculation approach as the locally installed source project
`idrive7-apps-main/apps/car_vitals` (M Vitals 2.27.9).

## What the readings mean

- **RPM** comes from BMW SOME/IP `CDS.statusEngineSpeed2`, field
  `actualValueRPMEngineCrankshaft`, scaled by 0.25 rpm per raw count.
- **Torque** comes from BMW SOME/IP `FES.statusActualValueTorque2`, field
  `actualValueTorqueCrankshaft`, scaled as `raw × 0.5 − 1023.5 Nm`. Negative
  engine-braking values are shown as zero, as in M Vitals.
- **Power** prefers BMW's `FES.statusVehicleDynamicEngine` field
  `displaySportEnginePower`. That field is a 0–100% Sport Display reading,
  **not a horsepower value**. PERFORMANCE multiplies it by the configured
  maximum power in kW, then converts to kW, hp, or PS. The app setting defaults
  to 215 kW, matching M Vitals' default; set both apps to the same maximum and
  power unit to compare their numbers exactly. If the percentage is missing or
  `Torque × RPM` is selected, power is estimated as `Nm × RPM / 9549` kW.
- **Torque scale** is BMW's separate Sport Display percentage from
  `displaySportEngineTorque`. The Nm value remains the direct FES torque signal.
- **Boost** in Auto mode prefers the FES Sport Display signal once it has moved
  by at least 0.03 bar. Its raw scale follows the M Vitals mapping: 0.01 bar
  per count in bar/kPa mode, or 0.1 psi per count converted to bar in psi mode.
  M Vitals marks this FES scale as unverified, so PERFORMANCE labels it
  approximate. If it is not trusted, the app tries the same ordered read-only
  engine-unit candidates as M Vitals: DIDs `F470`, `F487`, `F40B`, then OBD PID
  `0B`. These are decoded as absolute kPa. It subtracts barometric pressure
  (`F433`, then OBD PID `33`) to show gauge pressure in bar. If barometric
  pressure cannot be read, 101.3 kPa is used and the result is labelled as an
  estimate. An explicit source setting can select Sport Display or DME/OBD.

The power percentage, Nm, and RPM are raw BMW signals with the above documented
scaling. HP/hp is a converted reading, not an original BMW HP signal. Boost is
either converted from the Sport Display's undocumented scale or calculated
from engine-unit absolute pressure minus barometric pressure. DME replies and
the pressure interpretation still need confirmation on this specific car.

## M Vitals source and license

M Vitals source is present locally at
`CUSTOM APPS/idrive7-apps-main/apps/car_vitals`; its source is also public in
the upstream repository. PERFORMANCE ports the small signal scaling,
power-selection, unit-conversion, and ordered boost-candidate rules; it does
not copy M Vitals' interface or its full application source. The upstream
repository is MIT licensed. Its copyright and license notice are retained in
the repository's root `LICENSE` file.

## Read-only and demo behavior

The DME path uses the repository's `ReadOnlyDiag` helper and sends only UDS
`0x22` reads or OBD service `0x01` reads. It does not request diagnostic
sessions, security access, coding, resets, actuations, or writes. DME reads
only run while RPM is live, and can be disabled in Settings. Demo data is off
by default and the screen marks it `DEMO · NOT VEHICLE DATA` when enabled.

## Local checks and preview

From the repository root on Windows:

```powershell
node kit/tools/test_performance.js
python kit/tools/build.py performance --preview-only
node kit/tools/preview.js dist/performance preview/performance-demo --set demo=on render
node kit/tools/preview.js dist/performance preview/performance-live --set demo=off render
```

The preview-only build does not include BMW's OAP SDK and is not installable.
No local test can verify the car's actual signal availability, DME candidate
replies, the FES boost scale, or equality with the settings in the installed M
Vitals app. Those points require comparing both apps during a real drive or
controlled stationary engine test.
