'use strict';
/**
 * tyre_data.js - the car's extra TPMS values (TPMSInternalData + FES DSC) in plain English, ported
 * from aref_tires (ID7-MAIN_APPS2) for PERFORMANCE's TYRES INFO section. Read-side only: the
 * DSC-guarded chassisControl write stays out of CAR DATA.
 *
 * Pure functions, no car access. Node 8.
 */

const name = (v) => (v && typeof v === 'object' ? v.name || v.value : v);
const num = (x) => (typeof x === 'number' && x < 4294967295 ? x : null);

// TPMSInternalData.statusWheelTypeChange.statusWheelTypeChangeDetection: why auto-detect does or doesn't work
const DETECTION = {
    ALGORITHMUS_RADERKENNUNG_LAEUFT: ['busy', 'Finding the wheels', 'The car is still matching sensors to wheels. Keep driving.'],
    ALGORITHMUS_RADERKENNUNG_ABGESCHLOSSEN: ['ok', 'Wheels found', 'Every sensor is matched to a wheel.'],
    RADIDENTIFIKATION_ABGESCHLOSSEN: ['ok', 'Wheels identified', 'The car knows each sensor.'],
    POSITIONSBESTIMMUNG_ABGESCHLOSSEN: ['ok', 'Wheel positions found', 'The car knows where each sensor sits.'],
    NEUER_REIFEN: ['busy', 'New tire noticed', 'The car saw a tire it hasn\'t learned. Pick it in the tire list, then reset.'],
    PERMUTATION: ['busy', 'Wheels swapped', 'The car noticed the wheels moved positions.'],
    KEINE_AUTOMATISCHE_AUSWAHL_MOEGLICH: ['bad', 'Can\'t pick the tire by itself', 'Auto detect can\'t work on these tires. Pick the tire from the list instead.'],
    RDC_DEGRADIERT_KEIN_PASSENDER_REIFEN_GEFUNDEN: ['bad', 'No matching tire found', 'The tires on the car aren\'t in the car\'s tire list. Pick the closest size, or have the list coded with your tire.'],
    RDC_DEGRADIERT_UNGUELTIGE_REIFENLISTE: ['bad', 'Tire list not valid', 'The car\'s stored tire list is broken or missing. A coding job (ISTA / E-Sys) fixes this.'],
    RDC_DEGRADIERT_ERFS_NICHT_CODIERT: ['bad', 'Tire recognition not coded', 'Automatic tire recognition is switched off in this car\'s coding. Pick the tire by hand.'],
    RDC_DEGRADIERT_FUNKTION_NICHT_VERFUEGBAR: ['bad', 'Tire monitor not available', 'The tire monitor reports itself unavailable. Check fault codes.'],
    RDC_NOCH_NICHT_VERFUEGBAR: ['busy', 'Not ready yet', 'The tire monitor hasn\'t started. Drive a few minutes.'],
    FUNKTION_MELDET_FEHLER: ['bad', 'Tire monitor fault', 'The tire monitor reports a fault. Check fault codes.'],
    FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR: ['bad', 'No answer', 'The tire monitor isn\'t answering.'],
};
function detection(v) {
    const n = name(v && v.statusWheelTypeChangeDetection);
    const d = DETECTION[n];
    return d ? { tone: d[0], title: d[1], text: d[2], raw: n } : n ? { tone: 'dim', title: n, text: '', raw: n } : null;
}

// tpmsCalibrationData: the last reset
const CAL_TYPE = {
    ECU_NOT_CALIBRATED_YET: 'Never reset', ECU_NOT_CALIBRATED_YET_WU_POSITIONS_ASSUMED: 'Never reset',
    CALIBRATION_IS_ONGOING: 'Reset running', ERFS_HMI_USER_INITIATED_SELECTION: 'Reset from the iDrive menu',
    ERFS_DIAGNOSTIC_SELECTION: 'Set by a shop tool', ERFS_DIAGNOSTIC_SELECTION_WU_POSITIONS_ASSUMED: 'Set by a shop tool',
};
const CAL_RESULT = {
    PASSED: ['ok', 'Passed'], FAILED: ['bad', 'Failed'], ONGOING: ['busy', 'Running: keep driving'],
    MANUAL_CALIBRATION_PLAUSIBILITY_CHECK_PASSED: ['ok', 'Passed (manual tire)'],
    MANUAL_CALIBRATION_PLAUSIBILITY_CHECK_FAILED: ['bad', 'Failed: the pressures don\'t fit the tire picked'],
    SIGNAL_UNBEFUELLT: ['dim', 'No result yet'],
};
function calibration(v) {
    if (!v) return null;
    const t = name(v.tpmsCalibrationCalibrationType), r = name(v.tpmsCalibrationPlausibility);
    const typ = CAL_TYPE[t] || (/^AUTOMATIC_FILLING/.test(t || '') ? 'Learned after inflating' : t || '');
    const res = CAL_RESULT[r] || ['dim', r || ''];
    return { type: typ, tone: res[0], result: res[1], mileage: num(v.tpmsCalibrationMileage), raw: { type: t, result: r } };
}

/** A tire size from one of the car's tire structs (member prefixes differ per struct: pass the suffix). */
const SEASON = { SOMMERREIFEN: 'summer', WINTERREIFEN: 'winter', ALLJAHRESREIFEN: 'all-season' };
const RUNFLAT = { RUNFLAT: 'run-flat', NON_MINUS_RUNFLAT: '', PAX: 'PAX' };
function tire(v, k) {
    if (!v) return null;
    const g = (m) => v[m.replace('#', k)];
    const rw = g('width#'), rr = g('relationSide#') !== undefined ? g('relationSide#') : g('crossSection#'), rd = g('radius#') !== undefined ? g('radius#') : g('diameter#');
    if (!(rw > 0 && rw < 255 && rr > 0 && rr < 255 && rd > 0 && rd < 255)) return null;
    // the car sends steps, not millimetres (width = 95 + 10 x step, ratio = 15 + 5 x step, rim = 11 + step);
    // real millimetres pass as they are
    const w = rw < 60 ? 95 + 10 * rw : rw, r = rr < 20 ? 15 + 5 * rr : rr, d = rd < 12 ? 11 + rd : rd;
    const speed = name(g('indexSpeed#') !== undefined ? g('indexSpeed#') : g('speedIndex#'));
    const xl = name(g('carcass#')) === 'REIFEN_XL', season = SEASON[name(g('season#'))] || '', rf = RUNFLAT[name(g('runflat#'))] || '';
    const sp = speed && speed !== 'SIGNAL_UNGUELTIG' && speed.length <= 2 ? ' ' + speed : '';
    const size = w + '/' + r + 'R' + d + sp;
    return { size: size, xl: xl, season: season, runflat: rf, text: [size, xl ? 'XL' : '', season, rf].filter(Boolean).join(' · ') };
}
const frontAxle = (v) => tire(v, 'FrontAxleTypeTyre');
const rearAxle = (v) => tire(v, 'BackAxleTypeTyre');
/** What the sensors say is fitted (ERFS: tire data written into the sensors from the tire's QR code). */
function sensorTire(v) {
    if (!v) return null;
    const mounted = name(v.tpmsErfsActTireDimSummerMounted);
    const m = {
        width: v.tpmsErfsActTireDimSummerWidth, crossSection: v.tpmsErfsActTireDimSummerCrossSection, diameter: v.tpmsErfsActTireDimSummerDiameter,
        loadIndex: v.tpmsErfsActTireDimSummerLoadIndex, speedIndex: v.tpmsErfsActTireDimSummerSpeedIndex, carcass: v.tpmsErfsActTireDimSummerCarcass,
        season: v.tpmsErfsActTireDimSummerSeason, runflat: v.tpmsErfsActTireDimSummerRunflat,
    };
    return { mounted: mounted === 'TIRE_MOUNTED', state: mounted, tire: tire(m, '') };
}

// TPMS.statusTyreState
const SELECTION = { AUSWAHL: 'Picked from the list', VERBAUT: 'Fitted (learned)', VERBAUT_FELGENSENSOR: 'Fitted (rim sensors)' };
const LOADING = { ECO_SOLLDRUCK: 'Eco / comfort', TEILBELADEN: 'Partly loaded', VOLLBELADEN: 'Fully loaded' };
const MANUAL = { AUTOMATISCHE_REIFENAUSWAHL: 'Automatic', MANUELLE_REIFENAUSWAHL: 'Manual' };
function tyreState(v) {
    if (!v) return null;
    return {
        selection: SELECTION[name(v.statusSelectionTyre)] || null, loading: LOADING[name(v.statusTargetPressureLoadingConditionTyrePressureControl)] || null,
        season: SEASON[name(v.statusTyreSeasonTyrePressureControl)] || null, mode: MANUAL[name(v.statusManualSelection)] || null,
        progress: v.qualifierRDCInitializationDisplay <= 100 ? v.qualifierRDCInitializationDisplay : v.qualifierRDCInitializationDisplay === 253 ? 'failed' : null,
    };
}

// FES.statusDSCSwitchHMI: what DSC is doing now (what the cluster shows)
const DSC = { DSC_EIN: 'on', DSC_AUS: 'off', TRAKTIONSMODUS_EIN: 'traction', ANFAHRHILFE_AKTIV: 'start-off assist' };
function dsc(v) { const n = name(v && v.displayStatusDSC2); return n ? { state: DSC[n] || 'unknown', raw: n } : null; }

// TPMSInternalData.tpmsInternalLastValues: the last value each wheel sensor reported —
// pressure (mbar), target pressure (mbar), temperature (degC), battery. Backup feed for
// cars that never notify the TPMS pressure/target fields.
const CORNER = { FRONT_LEFT: 'FL', FRONT_RIGHT: 'FR', REAR_LEFT: 'RL', REAR_RIGHT: 'RR' };
function lastValues(v) {
    if (!v) return null;
    const out = [];
    for (let i = 1; i <= 4; i++) {
        const pos = name(v['tpmsInternalLastPositionId' + i]);
        const m = pos && pos.match(/(FRONT_LEFT|FRONT_RIGHT|REAR_LEFT|REAR_RIGHT)$/);
        if (!m) continue;
        out.push({
            corner: CORNER[m[1]],
            pressureMbar: num(v['tpmsInternalLastPressureMbarId' + i]),
            targetMbar: num(v['tpmsInternalLastTargetPressureMbarId' + i]),
            tempC: num(v['tpmsInternalLastTemperatureDegCId' + i]),
            battery: name(v['tpmsInternalLastBatteryStatusId' + i]),
        });
    }
    return out.length ? out : null;
}

/* ---------- the write ---------- */
// TPMS.chassisControl is one struct the HMI's tire menu and the DSC button share. Every member
// carries the "idle" defaultValue from the car's interface spec — anything else makes the ECU
// treat the member as a real request. Only the member we explicitly set carries our request.
// The "no request" member values, verified on the car by aref_tires: the ECU wants the
// explicit KEINE_* no-action enums — SIGNAL_UNGUELTIG members make it drop the whole write.
const CHASSIS_NO_ACTION = Object.freeze({
    operationTyreSeasonTyrePressureControl: 'KEINE_AENDERUNG',
    operationTyrePressureControl: 'KEINE_AKTION',
    operationModeTractionDSC: 'SIGNAL_UNGUELTIG',
    operationTargetPressureLoadingConditionTyrePressureControl: 'SIGNAL_UNGUELTIG',
    requestObjectListTyrePressureControl: 'KEINE_LISTE_ANGEFORDERT',
    operationSelectionTyreAvailable: 255,
    operationIDRSelection: 'KEINE_AKTION',
    statusIDRMessageCenter: 'KEINE_AKTION_DURCHGEFUEHRT',
});
/** The chassisControl struct carrying exactly one DSC request value. */
function dscStruct(dscValue) {
    return Object.assign({}, CHASSIS_NO_ACTION, { operationModeTractionDSC: dscValue });
}
/** chassisControl carrying the TPMS reset (RPA init) — iDrive's "Reset tyre pressure".
 * The car stores the current pressures as the new targets while driving. */
function tpmsResetStruct() {
    return Object.assign({}, CHASSIS_NO_ACTION, { operationTyrePressureControl: 'RDC_S_RPA_SETZEN' });
}

module.exports = { detection, calibration, tire, frontAxle, rearAxle, sensorTire, tyreState, lastValues, dsc, dscStruct, tpmsResetStruct };
