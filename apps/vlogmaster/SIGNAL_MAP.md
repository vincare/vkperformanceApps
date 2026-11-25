# VLogMaster signal map · 0.1.0

Extracted from the owner-provided HU_MGU `someip-interfaces.json` (schema version 0.1.0). The catalog describes what HU_MGU knows about; it does not prove that a provider is active on a given car. The app therefore reports each value's provider/data availability separately.

All listed vehicle SOME/IP services below use Instance ID `1` (`instanceIDs` entry `{"1": 1}`). `G` means getter ID; `N` means notifier event ID and event group. A missing getter is notifier-only. The schema marks the BMW field notifiers as unreliable, so this app retains `CHECKING`/`UNAVAILABLE` until a decoded payload arrives.

| Service · Service ID | Field · `dataRef` wrapper | G | N · event group | Decoded leaf / interpretation |
|---|---|---:|---|---|
| `de.bmw.infotainment.vehicle.CDS` · `46355` | `statusEngineSpeed2` · `StatusEngineSpeed2Wrapper` | 25 | 32793 · 1 | `actualValueRPMEngineCrankshaft`, raw × 0.25 rpm |
| same | `statusEngineStatus` · `EngineStatusWrapper` | 26 | 32794 · 1 | `statusEngineRunDrive`, known enum names only |
| same | `statusEngineTemperature` · `EngineTemperatureWrapper` | 27 | 32795 · 1 | `temperatureEngineDrive` and `temperatureEngineOilDrive`, raw − 48 °C |
| same | `statusBattery2` · `StatusBattery2Wrapper` | 5 | 32773 · 1 | `conditionBatteryChargingCondition`, accepted only in 0–100% |
| `de.bmw.infotainment.vehicle.Vehicle` · `46352` | `statusNewCurrentUnitsStatusExt` · `NewCurrentUnitsStatusExtWrapper` | 46 | 32814 · 1 | Air-pressure and temperature unit enums used to decode TPMS values |
| `de.bmw.infotainment.vehicle.Vehicle2` · `46361` | `statusCarSpeed2` · `CarSpeed2Wrapper` | 8 | 32776 · 1, 3 | `speedVehicleCentreOfGravity`, raw × 0.015625 km/h |
| same | `statusVehicleMass` · `StatusVehicleMassWrapper` | 79 | 32847 · 1, 3 | `massVehicle`, kg |
| `de.bmw.infrastructure.VehicleInformation` · `5430` | `statusGearboxDrive` · `StatusGearboxDriveWrapper` | — | 32776 · 8 | `statusActualGearDrive` plus `statusActualStageDrive`; maps the known BMW drive-stage enum and gear values |
| `de.bmw.infotainment.drivingexcitement.FES` · `46349` | `statusActualValueTorque2` · `ActualValueTorque2Wrapper` | 1 | 32769 · 1 | `actualValueTorqueCrankshaft`, raw × 0.5 − 1023.5 Nm |
| `de.bmw.infrastructure.analytics.BasicDataSet` · `4096` | `basicDataSet` · `BasicDataSetWrapper` | — | 32769 · 1 | `valueTemperatureTransmissionOil`, raw − 48 °C |
| `de.bmw.infrastructure.EnvironmentalInformation` · `5429` | `ExteriorTemperature` · `ExteriorTemperatureWrapper` | — | 32769 · 1 | `temperatureExterior`, raw × 0.5 − 40 °C |
| `de.bmw.infotainment.vehicle.CDS2` · `46356` | `statusLongitudinalAccelerationMassCenter` · `StatusLongitudinalAccelerationMassCenterWrapper` | 43 | 32811 · 1 | `longitudinalAccelerationCentreOfGravity`, raw × 0.002 − 65 m/s², then ÷ 9.80665 for g |
| `de.bmw.infotainment.KombiIF` · `46363` | `statusRangeTankStatus` · `RangeTankStatusWrapper` | 29 | 32797 · 1 | `fluidLevelFuelTank` in L and `range` in km |
| `de.bmw.infotainment.vehicle.TPMS` · `46348` | `statusTargetTyrePressure` · `TargetTyrePressureWrapper` | 1 | 32769 · 1 | `targetPressureTyre{FL,FR,RL,RR}H`, raw × 0.1 in the reported pressure unit |
| same | `statusTyrePressure` · `TyrePressureWrapper` | 7 | 32775 · 1 | `actualValuePressureTyre{FL,FR,RL,RR}H`, raw × 0.1 in the reported pressure unit |
| same | `statusTyreTemperature` · `TyreTemperatureWrapper` | 9 | 32777 · 1 | `actualValueTemperatureTyre{FL,FR,RL,RR}H`, raw − 40 in the reported temperature unit |

The catalog's unit enums are exact: air pressure `BAR=1`, `KPA=2`, `PSI=3`, `DEFAULT=0`, invalid `7`; temperature `C=1`, `F=2`, `DEFAULT=0`, invalid `3`. VLogMaster converts reported pressure units to bar (`kPa × 0.01`, `psi ÷ 14.5038`) and Fahrenheit to Celsius. If the unit value is default/invalid/missing, it leaves the tyre metric `UNAVAILABLE` instead of guessing from magnitude.

## Read-only DME / EGS candidate requests

These are the same bounded identifiers/scales already configured in the existing PERFORMANCE app; they are candidates, not guaranteed responses on every DME/EGS. Each channel is opt-in, paced, and stays unavailable after non-response/refusal. The app uses the shared read-only transport: UDS `0x22` ReadDataByIdentifier and OBD `0x01` current-data PIDs only. It does not request a diagnostic session, clear DTCs, or write/control anything.

| Channel | ECU | Candidate ID(s) and decoding |
|---|---:|---|
| Engine load | `0x12` | DID `5813`, UInt8 × 0.75; fallbacks `F404` / OBD PID `04`, × 100/255 |
| Absolute boost | `0x12` | DID `F470` (UInt16 at byte 3 × 1/32 kPa), `F487` (UInt16 at byte 1 × 1/32 kPa), `F40B` or OBD PID `0B` (UInt8 kPa) |
| Rail pressure | `0x12` | `F423` (UInt16 × 0.1 bar), `F459` (UInt16 × 0.1 − 1 bar), OBD PID `23` |
| Low-pressure fuel | `0x12` | `F40A` / OBD PID `0A` (UInt8 × 0.03 bar), `F422` / OBD PID `22` (UInt16 × 0.00079 bar) |
| Ignition advance | `0x12` | OBD PID `0E` or DID `F40E`, UInt8 × 0.5 − 64 degrees |
| Intake-air temperature | `0x12` | `F40F` (UInt8 − 40 °C), `F477` (byte 1 − 40 °C), or OBD PID `0F` |
| Control-module voltage | `0x12` | DID `5853` or OBD PID `42`, UInt16 × 0.001 V |
| EGS oil temperature | `0x18` | DID `6000`, UInt8 − 40 °C |

The catalogue's Tasu bridge is `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu`, Service ID `63654`, Instance ID `SystemFunctionsInternalTasuInst1` = `128`; read-only request method `sendTasuRequest` ID `1` takes `(UInt8 sourceAddress, UInt8 targetAddress, UInt8 serviceID, UInt8 subroutineID, UInt16 udsDataLength, ByteBuffer udsData, TimeoutType deadlockTime)` and returns `TasuErrorEnum`. Its `sendTasuResponse` event is ID `32769`, group `1`, carrying `(ByteBuffer udsResponse, UInt16 udsResponseLength, TasuErrorEnum errorCode)`. The shared reader imposes the allowed-service checks before requests reach this bridge.

## Deliberately unavailable in this build

No verified source/scale is wired for GPS position, boost target/deviation, wastegate position, target fuel-rail pressure, lambda/AFR, short/long fuel trims, misfire counters, per-cylinder ignition/knock data, battery state of charge, charging/auxiliary battery status, or a general DME/EGS DTC list. The live `conditionBatteryChargingCondition` field is kept separate from a claimed battery SOC. HU_MGU's enum-based `DtcService.readDtcStatus` is not treated as a generic ECU fault-list API. Health Check does not return `NORMAL` or `CRITICAL` without vehicle-specific validated limits.
