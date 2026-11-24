'use strict';

// Search the locally installed SOME/IP catalog. This module never connects to a vehicle.
// Keep the parser tolerant of catalog revisions: BMW has used both maps and arrays in sections.
const CATEGORIES = {
    attributes: 'field', fields: 'field',
    methods: 'method', operations: 'method',
    broadcasts: 'broadcast', events: 'broadcast', notifications: 'broadcast',
    types: 'type', structs: 'type', enumerations: 'type', enums: 'type'
};

const TOPICS = [
    { id: 'ambient', label: 'Ambient lighting', interface: /ambient|interior.?light|innenlicht|lighting|lin.?rgb/i,
        member: /ambient|colour|color|rgb|hue|brightness|light.?profile|light.?scene|innenlicht/i },
    { id: 'route', label: 'Route guidance and ETA', interface: /navigation|guidance|route|carplay|projected/i,
        member: /eta|arrival|time.?to.?dest|remaining.?time|remaining.?distance|destination|maneuver|manoeuvre|guidance/i },
    { id: 'gps', label: 'GPS position', interface: /position|location|gnss|gps|navigation/i,
        member: /latitude|longitude|heading|altitude|gnss|gps|wgs|position|velocity|ground.?speed|speed.?over.?ground|course/i },
    { id: 'media', label: 'Media now playing', interface: /media|entertainment|carplay|audio|player|tuner/i,
        member: /title|artist|album|now.?playing|metadata|track.?info|play.?time|elapsed/i },
    { id: 'climate', label: 'Climate', interface: /climate|hvac|ihka|klima|air.?conditioning/i,
        member: /temperature|fan|blower|air.?flow|seat.?heat|ventilat|defrost|set.?point/i },
    { id: 'lights', label: 'Exterior lights', interface: /light|lamp|flm|headlight|welcome/i,
        member: /welcome|day.?time|drl|low.?beam|high.?beam|headlight|coming.?home|leaving.?home/i },
    { id: 'body', label: 'Doors, locks, windows', interface: /door|lock|window|body|bdc|central/i,
        member: /door|lock|window|trunk|tailgate|mirror|sunroof/i },
    { id: 'drive', label: 'Drive modes, hybrid, battery', interface: /driving.?experience|driving.?excitement|efficiency|hybrid|charging|battery|electric|edrive|powertrain|fes/i,
        member: /driving.?experience|drive.?mode|mode.?driving|drive.?dynamic|switch.?drive|sport|comfort|eco.?pro|hybrid|electric|edrive|battery|state.?of.?charge|charging|precondition/i },
    { id: 'fuel', label: 'Fuel, range, odometer', interface: /kombi|fuel|tank|range|board.?computer/i,
        member: /fuel|tank|range|mileage|odometer|consumption/i }
];

function interfaceMap(document) {
    if (!document || typeof document !== 'object') return {};
    const root = document.interfaces || document;
    if (Array.isArray(root)) {
        const mapped = {};
        root.forEach(function (entry, index) {
            if (!entry || typeof entry !== 'object') return;
            const name = entry.name || entry.interface || entry.id || String(index);
            mapped[name] = entry.definition || entry;
        });
        return mapped;
    }
    return root && typeof root === 'object' ? root : {};
}

// Read member buckets and preserve each member's original description for the detail view.
function membersOf(definition) {
    const found = [];
    const visited = [];
    function walk(node, depth) {
        if (!node || typeof node !== 'object' || depth > 10 || visited.indexOf(node) !== -1) return;
        visited.push(node);
        Object.keys(node).forEach(function (key) {
            const kind = CATEGORIES[key.toLowerCase()];
            const bucket = node[key];
            if (kind) {
                if (Array.isArray(bucket)) {
                    bucket.forEach(function (member) {
                        if (typeof member === 'string') found.push({ name: member, kind: kind, detail: null });
                        else if (member && typeof member === 'object') {
                            const name = member.name || member.id;
                            if (name) found.push({ name: String(name), kind: kind, detail: member });
                        }
                    });
                } else if (bucket && typeof bucket === 'object') {
                    Object.keys(bucket).forEach(function (name) {
                        found.push({ name: name, kind: kind, detail: bucket[name] });
                    });
                }
                return;
            }
            if (bucket && typeof bucket === 'object') walk(bucket, depth + 1);
        });
    }
    walk(definition, 0);
    const order = { field: 0, method: 1, broadcast: 2, type: 3 };
    found.sort(function (a, b) {
        return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
    });
    return found;
}

function createIndex(document) {
    const all = interfaceMap(document);
    return Object.keys(all).map(function (interfaceName) {
        const definition = all[interfaceName];
        const members = membersOf(definition);
        const counts = { field: 0, method: 0, broadcast: 0, type: 0 };
        members.forEach(function (member) { counts[member.kind] = (counts[member.kind] || 0) + 1; });
        return { interfaceName: interfaceName, definition: definition, members: members, counts: counts };
    });
}

function search(index, topic, limit) {
    const result = [];
    (index || []).forEach(function (entry) {
        const matching = entry.members.filter(function (member) { return topic.member.test(member.name); });
        const interfaceMatch = topic.interface.test(entry.interfaceName);
        if (!interfaceMatch && !matching.length) return;
        result.push({
            interfaceName: entry.interfaceName,
            definition: entry.definition,
            members: entry.members,
            matches: matching,
            counts: entry.counts,
            score: matching.length * 2 + (interfaceMatch ? 3 : 0)
        });
    });
    result.sort(function (a, b) {
        return b.score - a.score || a.interfaceName.localeCompare(b.interfaceName);
    });
    return result.slice(0, limit || 40);
}

function report(index, meta) {
    const lines = [
        'VKP DEV-SCAN ' + (meta.version || 'unknown') + ' | ' + new Date().toISOString(),
        'Catalog: ' + (meta.catalogStatus || 'not loaded'),
        'Interface files: ' + ((meta.sourceFiles || []).join(', ') || 'none found'),
        'READ ONLY: this report is based on local head-unit files. No vehicle commands are sent.'
    ];
    TOPICS.forEach(function (topic) {
        const hits = search(index, topic, Infinity);
        lines.push('', '===== ' + topic.label + ' (' + hits.length + ' interfaces) =====');
        hits.forEach(function (hit, index) {
            lines.push((index + 1) + '. ' + hit.interfaceName + ' | ' + hit.counts.field + ' fields | ' +
                hit.counts.method + ' methods | ' + hit.counts.broadcast + ' broadcasts');
            if (hit.matches.length) {
                lines.push('   matched members: ' + hit.matches.map(function (member) {
                    return member.name + ' [' + member.kind + ']';
                }).join(', '));
            }
        });
        // Include six complete definitions as concrete examples; never truncate a definition.
        hits.slice(0, 6).forEach(function (hit) {
            lines.push('--- FULL DEFINITION: ' + hit.interfaceName);
            try { lines.push(JSON.stringify(hit.definition, null, 2)); }
            catch (e) { lines.push('(could not format definition: ' + e.message + ')'); }
        });
    });
    return lines.join('\n');
}

module.exports = { TOPICS: TOPICS, interfaceMap: interfaceMap, membersOf: membersOf, createIndex: createIndex, search: search, report: report };
