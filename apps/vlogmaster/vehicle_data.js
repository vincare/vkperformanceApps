'use strict';

/*
 * VehicleDataManager for VLogMaster. One SOME/IP subscription per interface,
 * shared decoded values, and an opt-in, paced READ ONLY UDS/OBD queue.
 */
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');

const CHANNELS = [
    { key: 'rpm', label: 'ENGINE RPM', category: 'ENGINE INFO', unit: 'rpm', iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusEngineSpeed2', path: 'actualValueRPMEngineCrankshaft', factor: 0.25, invalid: 65535, min: 0, max: 12000, stale: 12000 },
    { key: 'engineStatus', label: 'ENGINE STATUS', category: 'ENGINE INFO', unit: '', iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusEngineStatus', path: 'statusEngineRunDrive', text: true, stale: 15000 },
    { key: 'engineLoad', label: 'ENGINE LOAD', category: 'ENGINE INFO', unit: '%', diagnostic: true, ecu: 0x12, candidates: [
        { did: '5813', bytes: 1, factor: 0.75, min: 0, max: 191.25, note: 'B58 actual relative air charge, from PERFORMANCE candidate list' },
        { did: 'F404', bytes: 1, factor: 0.39216, min: 0, max: 100, note: 'OBD PID 04' }, { obd: '04', bytes: 1, factor: 0.39216, min: 0, max: 100, note: 'OBD PID 04' }], stale: 12000 },
    { key: 'speed', label: 'VEHICLE SPEED', category: 'POWERTRAIN', unit: 'km/h', iface: 'de.bmw.infotainment.vehicle.Vehicle2', field: 'statusCarSpeed2', path: 'speedVehicleCentreOfGravity', factor: 0.015625, invalid: 65535, min: 0, max: 400, stale: 12000 },
    { key: 'torque', label: 'ENGINE TORQUE', category: 'POWERTRAIN', unit: 'Nm', iface: 'de.bmw.infotainment.drivingexcitement.FES', field: 'statusActualValueTorque2', path: 'actualValueTorqueCrankshaft', factor: 0.5, offset: -1023.5, invalid: 65535, invalidFrom: 4095, min: 0, max: 2000, stale: 12000 },
    { key: 'gear', label: 'CURRENT GEAR', category: 'DRIVETRAIN', unit: '', iface: 'de.bmw.infrastructure.VehicleInformation', field: 'statusGearboxDrive', path: 'statusActualGearDrive', text: true, stale: 15000 },
    { key: 'boostActual', label: 'BOOST PRESSURE (ABS.)', category: 'BOOST', unit: 'kPa', diagnostic: true, ecu: 0x12, candidates: [
        { did: 'F470', bytes: 2, at: 3, factor: 0.03125, min: 20, max: 600, note: 'PERFORMANCE / M Vitals candidate' },
        { did: 'F487', bytes: 2, at: 1, factor: 0.03125, min: 20, max: 600, note: 'PERFORMANCE / M Vitals candidate' },
        { did: 'F40B', bytes: 1, factor: 1, min: 20, max: 255, note: 'PERFORMANCE / OBD PID 0B candidate' },
        { obd: '0B', bytes: 1, factor: 1, min: 20, max: 255, note: 'OBD PID 0B' }], stale: 12000 },
    { key: 'boostTarget', label: 'BOOST TARGET', category: 'BOOST', unit: 'kPa', unsupported: true },
    { key: 'hpfp', label: 'FUEL RAIL PRESSURE', category: 'FUEL SYSTEM', unit: 'bar', diagnostic: true, ecu: 0x12, candidates: [
        { did: 'F423', bytes: 2, factor: 0.1, min: 0, max: 500, note: 'PERFORMANCE / OBD PID 23 candidate' },
        { did: 'F459', bytes: 2, factor: 0.1, offset: -1, min: 0, max: 500, note: 'PERFORMANCE absolute pressure candidate' },
        { obd: '23', bytes: 2, factor: 0.1, min: 0, max: 500, note: 'OBD PID 23' }], stale: 12000 },
    { key: 'lpfp', label: 'LOW-PRESSURE FUEL', category: 'FUEL SYSTEM', unit: 'bar', diagnostic: true, ecu: 0x12, candidates: [
        { did: 'F40A', bytes: 1, factor: 0.03, min: 0.5, max: 8, note: 'PERFORMANCE candidate' },
        { did: 'F422', bytes: 2, factor: 0.00079, min: 0.5, max: 15, note: 'PERFORMANCE candidate' },
        { obd: '0A', bytes: 1, factor: 0.03, min: 0.5, max: 8, note: 'OBD PID 0A' },
        { obd: '22', bytes: 2, factor: 0.00079, min: 0.5, max: 15, note: 'OBD PID 22' }], stale: 12000 },
    { key: 'ignitionTiming', label: 'IGNITION ADVANCE', category: 'IGNITION', unit: 'deg', diagnostic: true, ecu: 0x12, candidates: [
        { obd: '0E', bytes: 1, factor: 0.5, offset: -64, min: -64, max: 63.5, note: 'OBD PID 0E' },
        { did: 'F40E', bytes: 1, factor: 0.5, offset: -64, min: -64, max: 63.5, note: 'PERFORMANCE candidate' }], stale: 12000 },
    { key: 'oilTemp', label: 'ENGINE OIL', category: 'TEMPERATURES', unit: '°C', iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusEngineTemperature', path: 'temperatureEngineOilDrive', factor: 1, offset: -48, invalid: 255, min: -40, max: 200, stale: 15000 },
    { key: 'coolantTemp', label: 'COOLANT', category: 'TEMPERATURES', unit: '°C', iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusEngineTemperature', path: 'temperatureEngineDrive', factor: 1, offset: -48, invalid: 255, min: -40, max: 160, stale: 15000 },
    { key: 'iat', label: 'INTAKE AIR', category: 'TEMPERATURES', unit: '°C', diagnostic: true, ecu: 0x12, candidates: [
        { did: 'F40F', bytes: 1, factor: 1, offset: -40, min: -40, max: 150, note: 'PERFORMANCE candidate' },
        { did: 'F477', bytes: 1, at: 1, factor: 1, offset: -40, min: -40, max: 150, note: 'PERFORMANCE charge-air candidate' },
        { obd: '0F', bytes: 1, factor: 1, offset: -40, min: -40, max: 150, note: 'OBD PID 0F' }], stale: 12000 },
    { key: 'gearboxTemp', label: 'TRANSMISSION OIL', category: 'TEMPERATURES', unit: '°C', iface: 'de.bmw.infrastructure.analytics.BasicDataSet', field: 'basicDataSet', path: 'valueTemperatureTransmissionOil', factor: 1, offset: -48, invalid: 255, min: -40, max: 180, stale: 45000 },
    { key: 'gearboxTempEgs', label: 'EGS OIL TEMP · READ ONLY', category: 'DRIVETRAIN', unit: '°C', diagnostic: true, ecu: 0x18, candidates: [
        { did: '6000', bytes: 1, factor: 1, offset: -40, min: -40, max: 160, note: 'PERFORMANCE ZF 8HP EGS candidate' }], stale: 12000 },
    { key: 'ambientTemp', label: 'OUTSIDE TEMP', category: 'TEMPERATURES', unit: '°C', iface: 'de.bmw.infrastructure.EnvironmentalInformation', field: 'ExteriorTemperature', path: 'temperatureExterior', factor: 0.5, offset: -40, invalid: 255, min: -50, max: 70, stale: 30000 },
    { key: 'batteryCondition', label: 'BATTERY CHARGE CONDITION', category: 'ELECTRICAL', unit: '%', iface: 'de.bmw.infotainment.vehicle.CDS', field: 'statusBattery2', path: 'conditionBatteryChargingCondition', min: 0, max: 100, stale: 30000 },
    { key: 'batteryVoltage', label: 'CONTROL MODULE VOLTAGE', category: 'ELECTRICAL', unit: 'V', diagnostic: true, ecu: 0x12, candidates: [
        { did: '5853', bytes: 2, factor: 0.001, min: 5, max: 18, note: 'PERFORMANCE / BMW voltage candidate' },
        { obd: '42', bytes: 2, factor: 0.001, min: 5, max: 18, note: 'OBD PID 42' }], stale: 12000 },
    { key: 'accelG', label: 'LONGITUDINAL ACCELERATION', category: 'VEHICLE DYNAMICS', unit: 'g', iface: 'de.bmw.infotainment.vehicle.CDS2', field: 'statusLongitudinalAccelerationMassCenter', path: 'longitudinalAccelerationCentreOfGravity', factor: 0.002, offset: -65, invalid: 65535, divide: 9.80665, min: -8, max: 8, stale: 12000 },
    { key: 'vehicleMass', label: 'VEHICLE MASS', category: 'VEHICLE DYNAMICS', unit: 'kg', iface: 'de.bmw.infotainment.vehicle.Vehicle2', field: 'statusVehicleMass', path: 'massVehicle', min: 500, max: 5000, stale: 30000 },
    { key: 'fuelLevel', label: 'FUEL LEVEL', category: 'FUEL SYSTEM', unit: 'L', iface: 'de.bmw.infotainment.KombiIF', field: 'statusRangeTankStatus', path: 'fluidLevelFuelTank', min: 0, max: 200, stale: 30000 },
    { key: 'range', label: 'ESTIMATED RANGE', category: 'FUEL SYSTEM', unit: 'km', iface: 'de.bmw.infotainment.KombiIF', field: 'statusRangeTankStatus', path: 'range', min: 0, max: 4094, stale: 30000 },
    { key: 'tyrePFL', label: 'TYRE PRESSURE · FL', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyrePressure', path: 'actualValuePressureTyreFLH', tyrePressure: true, stale: 20000 },
    { key: 'tyrePFR', label: 'TYRE PRESSURE · FR', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyrePressure', path: 'actualValuePressureTyreFRH', tyrePressure: true, stale: 20000 },
    { key: 'tyrePRL', label: 'TYRE PRESSURE · RL', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyrePressure', path: 'actualValuePressureTyreRLH', tyrePressure: true, stale: 20000 },
    { key: 'tyrePRR', label: 'TYRE PRESSURE · RR', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyrePressure', path: 'actualValuePressureTyreRRH', tyrePressure: true, stale: 20000 },
    { key: 'tyrePtFL', label: 'TARGET PRESSURE · FL', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTargetTyrePressure', path: 'targetPressureTyreFLH', tyrePressure: true, stale: 30000 },
    { key: 'tyrePtFR', label: 'TARGET PRESSURE · FR', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTargetTyrePressure', path: 'targetPressureTyreFRH', tyrePressure: true, stale: 30000 },
    { key: 'tyrePtRL', label: 'TARGET PRESSURE · RL', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTargetTyrePressure', path: 'targetPressureTyreRLH', tyrePressure: true, stale: 30000 },
    { key: 'tyrePtRR', label: 'TARGET PRESSURE · RR', category: 'TYRES INFO', unit: 'bar', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTargetTyrePressure', path: 'targetPressureTyreRRH', tyrePressure: true, stale: 30000 },
    { key: 'tyreTFL', label: 'TYRE TEMP · FL', category: 'TYRES INFO', unit: '°C', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyreTemperature', path: 'actualValueTemperatureTyreFLH', tyreTemperature: true, stale: 20000 },
    { key: 'tyreTFR', label: 'TYRE TEMP · FR', category: 'TYRES INFO', unit: '°C', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'statusTyreTemperature', path: 'actualValueTemperatureTyreFRH', tyreTemperature: true, stale: 20000 },
    { key: 'tyreTRL', label: 'TYRE TEMP · RL', category: 'TYRES INFO', unit: '°C', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'actualValueTemperatureTyreRLH', tyreTemperature: true, stale: 20000 },
    { key: 'tyreTRR', label: 'TYRE TEMP · RR', category: 'TYRES INFO', unit: '°C', iface: 'de.bmw.infotainment.vehicle.TPMS', field: 'actualValueTemperatureTyreRRH', tyreTemperature: true, stale: 20000 },
    { key: 'gpsPosition', label: 'GPS POSITION', category: 'GPS DATA', unit: '', unsupported: true },
    { key: 'misfireCounters', label: 'MISFIRE COUNTERS', category: 'IGNITION', unit: 'count', unsupported: true },
    { key: 'batterySoc', label: 'BATTERY STATE OF CHARGE', category: 'ELECTRICAL', unit: '%', unsupported: true },
    { key: 'chargingStatus', label: 'CHARGING SYSTEM STATUS', category: 'ELECTRICAL', unit: '', unsupported: true },
    { key: 'auxBatteryStatus', label: 'AUXILIARY BATTERY STATUS', category: 'ELECTRICAL', unit: '', unsupported: true },
    { key: 'boostDeviation', label: 'BOOST DEVIATION', category: 'BOOST', unit: 'kPa', unsupported: true },
    { key: 'wastegatePosition', label: 'WASTEGATE POSITION', category: 'BOOST', unit: '%', unsupported: true },
    { key: 'lambda', label: 'LAMBDA / AFR', category: 'FUEL SYSTEM', unit: '', unsupported: true },
    { key: 'hpfpTarget', label: 'TARGET FUEL RAIL PRESSURE', category: 'FUEL SYSTEM', unit: 'bar', unsupported: true },
    { key: 'shortFuelTrim', label: 'SHORT-TERM FUEL TRIM', category: 'FUEL SYSTEM', unit: '%', unsupported: true },
    { key: 'longFuelTrim', label: 'LONG-TERM FUEL TRIM', category: 'FUEL SYSTEM', unit: '%', unsupported: true },
    { key: 'cylinderTiming', label: 'CYLINDER TIMING CORRECTION', category: 'IGNITION', unit: 'deg', unsupported: true },
    { key: 'knock', label: 'KNOCK DATA', category: 'IGNITION', unit: '', unsupported: true },
];

const INTERFACES = {
    'de.bmw.infotainment.vehicle.CDS': { statusEngineSpeed2: 'rs', statusEngineTemperature: 'rs', statusEngineStatus: 'rs', statusBattery2: 'rs' },
    'de.bmw.infotainment.vehicle.Vehicle': { statusNewCurrentUnitsStatusExt: 'rs' },
    'de.bmw.infotainment.vehicle.Vehicle2': { statusCarSpeed2: 'rs', statusVehicleMass: 'rs' },
    'de.bmw.infrastructure.VehicleInformation': { statusGearboxDrive: 's' },
    'de.bmw.infotainment.drivingexcitement.FES': { statusActualValueTorque2: 'rs' },
    'de.bmw.infrastructure.analytics.BasicDataSet': { basicDataSet: 'rs' },
    'de.bmw.infrastructure.EnvironmentalInformation': { ExteriorTemperature: 's' },
    'de.bmw.infotainment.vehicle.CDS2': { statusLongitudinalAccelerationMassCenter: 'rs' },
    'de.bmw.infotainment.KombiIF': { statusRangeTankStatus: 'rs' },
    'de.bmw.infotainment.vehicle.TPMS': { statusTyrePressure: 'rs', statusTyreTemperature: 'rs', statusTargetTyrePressure: 'rs' },
    'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu': {
        _instances: 'SystemFunctionsInternalTasuInst1', _methods: ['sendTasuRequest'], _broadcasts: ['sendTasuResponse'],
    },
};

const finite = (v) => typeof v === 'number' && isFinite(v);
function enumValue(v) {
    if (v && typeof v === 'object') return v.name != null ? v.name : v.value;
    return v;
}
function tempUnit(value) {
    const v = enumValue(value), s = String(v == null ? '' : v).trim().toUpperCase();
    return ({ '1': 'C', '2': 'F', C: 'C', CELSIUS: 'C', F: 'F', FAHRENHEIT: 'F' })[s] || null;
}
function pressureFactor(value) {
    const v = enumValue(value), s = String(v == null ? '' : v).trim().toUpperCase();
    return ({ '1': 1, '2': 0.01, '3': 1 / 14.5038, BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 })[s] || null;
}
function diagnosticRaw(result, candidate) {
    if (!result || !result.bytes || !candidate) return null;
    const bytes = result.bytes.split(/\s+/).map((x) => parseInt(x, 16));
    const at = (candidate.obd ? 2 : 3) + (candidate.at || 0), n = candidate.bytes || 1;
    if (bytes.length < at + n) return result.bytes;
    let raw = 0;
    for (let i = 0; i < n; i++) raw = raw * 256 + bytes[at + i];
    if (candidate.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
    if (candidate.bit != null) raw = (raw >> candidate.bit) & 1;
    return raw;
}
function numberValue(raw, c) {
    if (!finite(raw) || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null;
    let v = raw * (c.factor == null ? 1 : c.factor) + (c.offset || 0);
    if (c.divide) v /= c.divide;
    return finite(v) && (c.min == null || v >= c.min) && (c.max == null || v <= c.max) ? v : null;
}

class VehicleDataManager {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log; this.signals = ctx.signals;
        this.values = Object.create(null); this.providers = Object.create(null);
        this.listeners = []; this.subscriptions = []; this.stopped = false;
        this.pressUnit = null; this.tempUnit = null; this.rawLatest = Object.create(null); this.latestPayloads = Object.create(null);
        this.diag = null; this.reader = null; this.diagInit = null;
        this.demand = new Set(); this.diagTimer = null; this.diagBusy = false; this.diagCursor = 0;
        this.diagLastFailure = ''; this.diagRetryAt = Object.create(null); this.diagNextInitAt = 0;
        this.metricDefs = Object.create(null); CHANNELS.forEach((c) => { this.metricDefs[c.key] = c; });
        this.bindings = Object.create(null);
        CHANNELS.filter((c) => c.iface && c.field).forEach((c) => {
            const key = c.iface + '.' + c.field;
            if (!this.bindings[key]) this.bindings[key] = [];
            this.bindings[key].push(c);
        });
    }

    onChange(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
    notify(key) { this.listeners.slice().forEach((fn) => { try { fn(key, this.get(key)); } catch (e) { if (this.log) this.log.warn('data listener: ' + e); } }); }
    all() { return CHANNELS.slice(); }
    get(key) {
        const c = this.metricDefs[key], m = this.values[key];
        if (!c) return { status: 'UNAVAILABLE', value: null, raw: null, unit: '', source: '', at: 0 };
        if (c.unsupported) return { status: 'UNAVAILABLE', value: null, raw: null, unit: c.unit, source: 'not mapped to a verified vehicle signal', at: 0 };
        if (!m) {
            const provider = c.iface && this.providers[c.iface];
            return { status: provider === false ? 'UNAVAILABLE' : 'CHECKING', value: null, raw: null, unit: c.unit, source: provider === false ? c.iface + ' unavailable' : c.diagnostic ? 'read-only diagnostic not requested' : 'waiting for signal', at: 0 };
        }
        const stale = Date.now() - m.at > (c.stale || 12000);
        return Object.assign({}, m, { status: stale ? 'UNAVAILABLE' : m.status });
    }
    snapshot(keys) { return (keys || CHANNELS.map((c) => c.key)).map((k) => Object.assign({ key: k }, this.get(k))); }
    recent(key, count) { const m = this.values[key]; return m && m.history ? m.history.slice(-(count || 120)) : []; }

    start() {
        Object.keys(INTERFACES).forEach((iface) => {
            if (iface.indexOf('com.harman.') === 0) return;
            const handlers = Object.create(null);
            Object.keys(INTERFACES[iface]).forEach((field) => {
                const def = INTERFACES[iface][field];
                if (field[0] === '_') return;
                handlers[field] = (payload) => this._onField(iface, field, payload);
            });
            const options = {};
            if (iface === 'de.bmw.infotainment.KombiIF') options.pollMs = 10000;
            if (iface === 'de.bmw.infotainment.vehicle.TPMS') options.pollMs = 5000;
            if (iface === 'de.bmw.infotainment.vehicle.CDS') options.pollMs = 10000;
            try {
                Promise.resolve(this.signals.watch(iface, '1', handlers, this.log, Object.assign(options, {
                    onAvailability: (a) => { this.providers[iface] = !!a; this.listeners.slice().forEach((fn) => fn(null, null)); },
                }))).then((sub) => {
                    if (!sub) { this.providers[iface] = false; return; }
                    this.subscriptions.push(sub);
                    if (sub.error) { this.providers[iface] = false; if (this.log) this.log.warn(iface + ': ' + sub.error); }
                    else if (typeof sub.available === 'boolean') this.providers[iface] = sub.available;
                }).catch((e) => { this.providers[iface] = false; if (this.log) this.log.warn(iface + ': ' + e); });
            } catch (e) { this.providers[iface] = false; if (this.log) this.log.warn(iface + ': ' + e); }
        });
    }

    _onField(iface, field, payload) {
        if (!payload || typeof payload !== 'object') return;
        this.latestPayloads[iface + '.' + field] = payload;
        if (iface === 'de.bmw.infotainment.vehicle.Vehicle' && field === 'statusNewCurrentUnitsStatusExt') {
            this.pressUnit = enumValue(payload.unitOfMeasurementAirPressure);
            this.tempUnit = tempUnit(payload.unitOfMeasurementTemperature);
            ['statusTyrePressure', 'statusTargetTyrePressure', 'statusTyreTemperature'].forEach((f) => {
                const last = this.latestPayloads['de.bmw.infotainment.vehicle.TPMS.' + f];
                if (last) this._onField('de.bmw.infotainment.vehicle.TPMS', f, last);
            });
            return;
        }
        const list = this.bindings[iface + '.' + field] || [];
        list.forEach((c) => {
            const raw = enumValue(payload[c.path]);
            this.rawLatest[c.key] = raw;
            let value = null, status = 'UNAVAILABLE', unit = c.unit;
            if (c.key === 'gear') {
                const gearRaw = raw;
                const n = typeof gearRaw === 'number' ? (gearRaw >= 3 && gearRaw <= 12 ? gearRaw - 2 : gearRaw === 1 ? -1 : gearRaw === 2 ? 0 : null)
                    : ({ G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10 })[String(gearRaw || '').toUpperCase()];
                const s = String(raw || '').toUpperCase();
                const stageRaw = enumValue(payload.statusActualStageDrive);
                const stage = typeof stageRaw === 'number' ? ({ 1: 'P', 2: 'R', 3: 'N', 4: 'D' })[stageRaw] : String(stageRaw || '').toUpperCase();
                value = stage === 'D' ? (n > 0 ? 'D' + n : 'D') : stage && /^(P|R|N)$/.test(stage) ? stage : n === -1 ? 'R' : n === 0 ? 'N/P' : n > 0 ? 'D' + n : s && !/UNKNOWN|INVALID|NO_VALUE/.test(s) ? s : null;
                status = value == null ? 'UNAVAILABLE' : 'LIVE';
            } else if (c.key === 'engineStatus') {
                const s = String(raw == null ? '' : raw).toUpperCase();
                value = ({ MOTOR_AUS: 'ENGINE OFF', MOTOR_STARTET: 'STARTING', MOTOR_LAEUFT: 'RUNNING', '0': 'ENGINE OFF', '1': 'STARTING', '2': 'RUNNING' })[s] || (s && !/UNKNOWN|INVALID|NO_VALUE|INITIAL/.test(s) ? s : null);
                status = value == null ? 'UNAVAILABLE' : 'LIVE';
            } else if (c.tyrePressure) {
                const x = finite(raw) && raw < 65532 ? raw * 0.1 : null;
                const factor = pressureFactor(this.pressUnit);
                value = x == null || factor == null ? null : x * factor;
                status = finite(value) && value > 0 && value < 7 ? 'LIVE' : 'UNAVAILABLE';
            } else if (c.tyreTemperature) {
                value = finite(raw) && raw !== 65535 && this.tempUnit ? raw - 40 : null;
                if (value != null && this.tempUnit === 'F') value = (value - 32) * 5 / 9;
                status = finite(value) && value > -40 && value < 120 ? 'LIVE' : 'UNAVAILABLE';
            } else {
                value = numberValue(raw, c);
                status = value == null ? 'UNAVAILABLE' : 'LIVE';
            }
            this._update(c.key, raw, value, unit, 'SOME/IP · ' + iface + '.' + field, status);
        });
    }

    _update(key, raw, value, unit, source, status) {
        const at = Date.now(), prev = this.values[key], h = prev && prev.history ? prev.history : [];
        if (finite(value)) { h.push({ t: at, v: value }); if (h.length > 180) h.splice(0, h.length - 180); }
        this.values[key] = { raw: raw == null ? null : raw, value: value == null ? null : value, unit: unit || '', source: source || '', at, status: status || (value == null ? 'UNAVAILABLE' : 'LIVE'), history: h };
        this.notify(key);
    }

    async _ensureDiag() {
        if (this.reader) return true;
        if (this.diagInit) return this.diagInit;
        this.diagInit = Promise.resolve().then(async () => {
            this.diag = new ReadOnlyDiag(this.signals, this.log, { gapMs: 160, silentAfter: 3 });
            await this.diag.init();
            if (!this.diag.ready) throw new Error(this.diag.error || 'read-only diagnostic transport unavailable');
            this.reader = new DidReader(this.diag, { ecu: 0x12 });
            return true;
        }).catch((e) => {
            this.diagLastFailure = String(e && e.message || e);
            if (this.log) this.log.warn('read-only diagnostics: ' + this.diagLastFailure);
            this.diagInit = null; this.diagNextInitAt = Date.now() + 15000;
            return false;
        });
        return this.diagInit;
    }

    setDemand(keys) {
        const next = new Set((keys || []).filter((k) => {
            const c = this.metricDefs[k]; return !!(c && c.diagnostic && c.candidates && c.candidates.length);
        }));
        const changed = next.size !== this.demand.size || Array.from(next).some((k) => !this.demand.has(k));
        this.demand = next;
        if (!this.demand.size) { if (this.diagTimer) clearTimeout(this.diagTimer); this.diagTimer = null; return; }
        if (changed && this.diagTimer) { clearTimeout(this.diagTimer); this.diagTimer = null; }
        if (!this.diagTimer && !this.diagBusy) this.diagTimer = setTimeout(() => this._diagTick(), 10);
    }

    async _diagTick() {
        this.diagTimer = null;
        if (this.stopped || this.diagBusy || !this.demand.size) return;
        const active = Array.from(this.demand);
        const now = Date.now();
        const eligible = active.filter((k) => !this.diagRetryAt[k] || this.diagRetryAt[k] <= now);
        if (!eligible.length) {
            const next = Math.min.apply(null, active.map((k) => this.diagRetryAt[k] || now + 1200));
            this.diagTimer = setTimeout(() => this._diagTick(), Math.max(500, Math.min(15000, next - now)));
            return;
        }
        this.diagBusy = true;
        const key = eligible[this.diagCursor++ % eligible.length], c = this.metricDefs[key];
        try {
            if (Date.now() < this.diagNextInitAt) {
                this._update(key, null, null, c.unit, this.diagLastFailure || 'read-only diagnostic transport retry delayed', 'UNAVAILABLE');
                this.diagRetryAt[key] = Date.now() + 15000;
            } else if (await this._ensureDiag()) {
                const v = await this.reader.value(key, c.candidates.map((candidate) => Object.assign({ ecu: c.ecu }, candidate)));
                const picked = this.reader.pick[key];
                const candidate = picked == null ? null : c.candidates[picked];
                const result = candidate ? (this.reader.raws[this.reader.key(candidate)] || {}) : (this.reader.raws[this.reader.key(c.candidates[0])] || {});
                const reason = result.why || 'no valid response';
                const source = v == null ? 'READ ONLY · ' + reason : 'READ ONLY · ECU ' + c.ecu.toString(16).toUpperCase() + ' · ' + (candidate ? DidReader.label(candidate) : 'DID');
                this._update(key, diagnosticRaw(result, candidate), v, c.unit, source, v == null ? 'UNAVAILABLE' : 'LIVE');
                this.diagRetryAt[key] = v == null ? Date.now() + 15000 : Date.now() + 1200 * Math.max(1, this.demand.size);
            } else {
                this._update(key, null, null, c.unit, this.diagLastFailure || 'read-only diagnostic transport unavailable', 'UNAVAILABLE');
                this.diagRetryAt[key] = Date.now() + 15000;
            }
        } catch (e) {
            this._update(key, null, null, c.unit, 'READ ONLY · ' + String(e && e.message || e), 'UNAVAILABLE');
            this.diagRetryAt[key] = Date.now() + 15000;
        } finally {
            this.diagBusy = false;
            if (!this.stopped && this.demand.size) this.diagTimer = setTimeout(() => this._diagTick(), 1200);
        }
    }

    shutdown() {
        this.stopped = true;
        if (this.diagTimer) clearTimeout(this.diagTimer);
        if (this.diag) this.diag.cancel();
        this.subscriptions.splice(0).forEach((s) => { try { if (s && s.shutdown) s.shutdown(); } catch (e) { /* app is shutting down */ } });
    }
}

module.exports = { VehicleDataManager, CHANNELS, INTERFACES };
