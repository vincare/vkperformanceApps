# PERFORMANCE

A read-only engine performance display for BMW HU_MGU / iDrive 7. The first
page is **Engine Data**, drawn with the same segmented gauges, M-style panels,
and peak markers used by M Vitals. The default palette is black and red; M
Tricolour is also available in Settings.

The display keeps the BMW Sport Display power and torque percentages separate
from the calculated horsepower and the direct torque reading. Demo mode is
labelled `DEMO · NOT VEHICLE DATA`; it never claims its generated values came
from the car.

## What each number means

- **HP** is calculated from the current torque and RPM using `HP = Nm × RPM /
  7127.2`. It is always marked approximate. The BMW FES percentage and maximum
  fields are captured in the diagnostic log for comparison, but their raw
  maximum field has no unit in the catalog, so this app does not convert it to
  horsepower.
- **Torque** prefers the BMW FES `statusActualValueTorque2` crankshaft signal.
  It uses the same 0.5 Nm/bit, zero-at-2047 decoding used by M Vitals and Live
  Data. If that signal is missing, the app can show the DME8FF_R `0x5717`
  read-only candidate, whose SGBD entry is signed 0.1 Nm/bit and describes
  engine torque at the clutch. The source is labelled on the screen/log.
- **Boost** prefers DME8FF_R `0x4A2D` manifold absolute pressure minus `0x4201`
  ambient pressure, converted from hPa to bar. These DME values are only used
  when both replies are fresh. If they are unavailable, the app falls back to
  the FES Sport Display boost signal and uses the car's selected pressure unit;
  this fallback is marked approximate because the upstream app code marks the
  Sport Display scale as unverified.
- **BMW Sport Display scale bars** show the raw 0–100 power and torque
  percentages from `statusVehicleDynamicEngine`, not converted HP or Nm.

When a provider, value, unit, or fresh payload is missing, the display shows
`SIGNAL UNAVAILABLE` / `--`. Demo data is off by default and is visibly labelled
`DEMO · NOT VEHICLE DATA` when enabled.

## Signal evidence

The Some/IP identifiers below were parsed from the supplied HU_MGU
`someip-interfaces.json`. Its instance IDs are `1` for the listed services.
Getter and notifier IDs are catalog values, not guessed names.

| Value | Service / field | Service ID | Getter / notifier | Catalog data | Unit / status |
|---|---|---:|---|---|---|
| RPM | `vehicle.CDS.statusEngineSpeed2` | `46355 / 0xB513` | getter `25`; notifier `32793 / 0x8019` | `UInt16 actualValueRPMEngineCrankshaft`, default `65535` | `raw × 0.25 rpm` from the existing app code; live car not yet checked |
| Torque | `drivingexcitement.FES.statusActualValueTorque2` | `46349 / 0xB50D` | getter `1`; notifier `32769 / 0x8001` | `UInt16 actualValueTorqueCrankshaft`, default `4095` | existing M Vitals / Live Data mapping: `raw × 0.5 − 1023.5 Nm`; live car not yet checked |
| Sport power / torque scale | `FES.statusVehicleDynamicEngine` | `46349 / 0xB50D` | getter `3`; notifier `32771 / 0x8003` | `UInt8 displaySportEnginePower`, `displaySportEngineTorque`, default `255` | interpreted as percent by existing code; kept separate from physical HP/Nm |
| Sport scale max | `FES.statusVehicleDynamicEngineMaxValue` | `46349 / 0xB50D` | getter `40`; notifier `32808 / 0x8028` | two `UInt16` values | logged raw; no physical unit established |
| Sport scale base | `FES.statusVehicleDynamicEngineScaling` | `46349 / 0xB50D` | getter `2`; notifier `32770 / 0x8002` | two scaling enums | logged raw; not used to invent a physical unit |
| Sport Display boost | `FES.statusSwitchDriveDynamicSport2` | `46349 / 0xB50D` | getter `39`; notifier `32807 / 0x8007` | `UInt8 displayBoostPressure`, default `255` | conversion follows the upstream M Vitals / Live Data implementation; remains marked approximate until compared in the car |
| Pressure unit | `vehicle.Vehicle.statusNewCurrentUnitsStatusExt` | `46352 / 0xB510` | getter `46`; notifier `32814 / 0x802E` | `unitOfMeasurementAirPressure` | catalog enum interpreted by existing code as bar/kPa/psi |
| Sport powertrain payload | `FES.displaySportPowertrain` | `46349 / 0xB50D` | notifier `32772 / 0x8004`; no getter | two `UInt16` values | captured raw only; physical units not established |

Read-only DME candidates come from the bundled `DME8FF_R` SGBD reference in
this project. The app makes UDS service `0x22` reads to ECU `0x12` only while
RPM is live and the diagnostic setting is enabled:

| DID | SGBD description | Decode in catalog | Use |
|---|---|---|---|
| `0x4520` | Effective engine power | `UInt16 × 0.015258789062`; catalog has no physical unit | raw/scaled diagnostic only; never shown as HP |
| `0x5717` | Engine torque without anti-jerk intervention / clutch torque | signed `Int16 × 0.1 Nm` | fallback torque reading if the FES signal is unavailable |
| `0x4A2D` | Measured intake manifold absolute pressure | `UInt16 × 0.078125 hPa` | first half of boost gauge pressure |
| `0x4201` | Ambient pressure | `UInt16 × 0.0390625 hPa` | subtracted from `0x4A2D` |

The local ECU response is not yet known. A catalog entry is not proof that this
specific DME software will answer, so unavailable/refused replies are logged
and never replaced with invented values. No write, reset, actuator, session,
security-access, or coding request is present. The DME transport uses the
project's `ReadOnlyDiag` helper, which permits UDS `0x22` reads only.

## Diagnostics and lifecycle

`Settings` opens the app's normal settings / QR-log route. With raw diagnostics
enabled, the rotating app log records provider availability, subscription and
getter outcomes, raw payloads, decoded values, units, timestamps, invalid or
stale data, and DME reply errors. The `Read DME candidates` option can disable
the read-only DME probes while leaving SOME/IP live display data active.

On app shutdown, display timers stop, queued DME reads are cancelled, and every
Some/IP subscription's `shutdown()` method is called. The app never changes
BMW files or services.

## Build and offline preview

From the repository root on Windows:

```powershell
python kit/tools/build.py performance --preview-only
node kit/tools/preview.js dist/performance preview/performance --set demo=on render
```

The local preview-only build does not contain BMW's SDK and is not an
installable package. MGU Store builds need its SDK donor from a BMW app on the
unit; `oap-sdk` and install packages must not be committed to GitHub.
