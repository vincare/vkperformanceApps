'use strict';

// VKP DEV-SCAN inspects the interface descriptions installed on the head unit.
// It reads local catalog files only; it never subscribes to vehicle data or sends commands.
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Catalog = require('./catalog');

const VERSION = '0.2.0';
const WIDTH = 1600;
const HEIGHT = 520;
const TOPIC_TABS = ['AMBIENT', 'ROUTE', 'GPS', 'MEDIA', 'CLIMATE', 'LIGHTS', 'DOORS', 'DRIVE', 'FUEL'];
const LIST_ROWS = 8;
const DETAIL_ROWS = 12;
const BASE = process.env.MGU_DEVSCAN_ROOT || '/';
const CATALOG_PATH = path.join(BASE, 'etc/oap/someip/someip-interfaces.json');
const SOURCE_PATH = path.join(BASE, 'usr/lib/oap-mainapp/src-gen');
const MEMBER_COLORS = { field: 'accent2', method: 'warn', broadcast: 'cold', type: 'dim' };

mgu.run({
    async start(ctx) {
        const ui = ctx.ui;
        const log = ctx.log;
        const reportPath = path.join(ctx.dataDir, 'vkp-devscan-report.txt');
        let document = null;
        let catalogIndex = [];
        let readError = '';
        let interfaceCount = 0;
        let sourceFiles = [];
        let selectedTopic = 0;
        let listPage = 0;
        let detailIndex = -1;
        let detailPage = 0;
        let toast = null;
        const results = {};

        function safe(name, fn) {
            return function () {
                try {
                    const value = fn.apply(this, arguments);
                    if (value && typeof value.catch === 'function') {
                        value.catch(function (error) { log.error(name + ': ' + error.message); });
                    }
                    return value;
                } catch (error) {
                    log.error(name + ': ' + (error && error.stack || error));
                    return undefined;
                }
            };
        }

        function notify(message, duration) {
            toast = { message: message, expires: Date.now() + (duration || 3500) };
        }

        function currentTopic() { return Catalog.TOPICS[selectedTopic]; }

        function topicResults() {
            const topic = currentTopic();
            if (!document) return [];
            if (!results[topic.id]) results[topic.id] = Catalog.search(catalogIndex, topic, Infinity);
            return results[topic.id];
        }

        function updateDetailButton() {
            ui.text('BTN_DETAIL', detailIndex >= 0 ? 'Next match' : 'Details');
        }

        function changeTopic(index) {
            selectedTopic = (index + Catalog.TOPICS.length) % Catalog.TOPICS.length;
            listPage = 0;
            detailIndex = -1;
            detailPage = 0;
            updateDetailButton();
        }

        function openDetail(index) {
            if (index < 0 || index >= topicResults().length) return;
            detailIndex = index;
            detailPage = 0;
            updateDetailButton();
        }

        function reportText() {
            return Catalog.report(catalogIndex, {
                version: VERSION,
                catalogStatus: readError || (interfaceCount + ' interfaces found'),
                sourceFiles: sourceFiles
            });
        }

        function saveReport(automatic) {
            try {
                fs.writeFileSync(reportPath, reportText(), 'utf8');
                if (!automatic) notify('REPORT SAVED');
                log.info('report saved: ' + reportPath);
            } catch (error) {
                if (!automatic) notify('REPORT COULD NOT BE SAVED');
                log.warn('report: ' + error.message);
            }
        }

        function loadLocalCatalog() {
            try { sourceFiles = fs.readdirSync(SOURCE_PATH).filter(function (name) { return /\.json$/i.test(name); }); }
            catch (error) { sourceFiles = []; }

            fs.readFile(CATALOG_PATH, 'utf8', safe('catalog read', function (error, contents) {
                if (error) readError = 'Cannot read local catalog (' + (error.code || error.message) + ')';
                else {
                    try {
                        document = JSON.parse(contents);
                        catalogIndex = Catalog.createIndex(document);
                        interfaceCount = catalogIndex.length;
                        if (!interfaceCount) readError = 'Catalog contains no interface entries';
                    } catch (parseError) {
                        readError = 'Catalog is not valid JSON (' + parseError.message + ')';
                    }
                }
                if (readError) log.warn(readError);
                else log.info('local catalog loaded: ' + interfaceCount + ' interfaces; ' + sourceFiles.length + ' source descriptions');
                saveReport(true);
            }));
        }

        function fitText(cv, value, size, maxWidth, options) {
            let text = String(value === undefined || value === null ? '' : value);
            if (cv.textWidth(text, size, options) <= maxWidth) return text;
            while (text.length > 1 && cv.textWidth(text + '...', size, options) > maxWidth) text = text.slice(0, -1);
            return text + '...';
        }

        function compactName(name) {
            return String(name).replace(/^de\.bmw\.infotainment\./i, '').replace(/^com\.harman\.infotainment\./i, '');
        }

        function drawState(cv, theme, heading, message) {
            const top = (G.TOP || 44) + 28;
            cv.fillRect(40, top, 5, 58, theme.accent);
            cv.text(heading, 64, top + 28, 28, theme.text, { font: 'bold', spacing: 1, literal: true });
            cv.text(fitText(cv, message, 19, WIDTH - 130, { literal: true }), 64, top + 57, 19, theme.dim, { literal: true });
        }

        function drawList(cv, theme, hits) {
            const y0 = (G.TOP || 44) + 8;
            if (!document) {
                drawState(cv, theme, 'READING LOCAL CATALOG', 'Loading the head unit interface list...');
                return;
            }
            if (readError) {
                drawState(cv, theme, 'CATALOG UNAVAILABLE', readError + ' | Check that the app can read /etc/oap/someip/.');
                return;
            }
            if (!hits.length) {
                drawState(cv, theme, 'NO MATCHES FOUND', 'No interface names or members matched ' + currentTopic().label + '.');
                return;
            }

            const pages = Math.max(1, Math.ceil(hits.length / LIST_ROWS));
            const page = listPage % pages;
            hits.slice(page * LIST_ROWS, page * LIST_ROWS + LIST_ROWS).forEach(function (hit, position) {
                const absoluteIndex = page * LIST_ROWS + position;
                const y = y0 + 5 + position * 55;
                const hot = absoluteIndex === detailIndex;
                cv.fillRect(28, y, WIDTH - 56, 48, hot ? G.withAlpha(theme.accent, 0.16) : G.withAlpha(theme.text, 0.025));
                cv.fillRect(28, y, 4, 48, hot ? theme.accent : G.withAlpha(theme.accent, 0.48));
                if (cv.target) cv.target(24, y - 2, WIDTH - 48, 52, function () { openDetail(absoluteIndex); }, 'vkp_devscan_row_' + absoluteIndex, 7);

                cv.text(fitText(cv, compactName(hit.interfaceName), 20, 720, { font: 'bold', literal: true }), 48, y + 22,
                    20, theme.text, { font: 'bold', literal: true });
                const counts = hit.counts;
                cv.text(counts.field + ' fields  |  ' + counts.method + ' methods  |  ' + counts.broadcast + ' broadcasts',
                    48, y + 40, 14, theme.dim, { literal: true });
                const names = hit.matches.map(function (member) { return member.name; }).join(', ') || 'matched by interface name';
                cv.text(fitText(cv, names, 15, 720, { literal: true }), 830, y + 29, 15, theme.accent2 || theme.text, { literal: true });
            });
            cv.text('PAGE ' + (page + 1) + ' / ' + pages + '     ' + hits.length + ' MATCHES     USE MORE TO CONTINUE',
                WIDTH - 38, HEIGHT - 10, 14, theme.dim, { align: 'right', font: 'bold', spacing: 0.8, literal: true });
        }

        function memberChip(cv, theme, x, y, kind) {
            const label = kind.toUpperCase();
            const color = theme[MEMBER_COLORS[kind]] || theme.dim;
            const width = Math.max(82, cv.textWidth(label, 13, { font: 'bold', spacing: 0.8 }) + 22);
            cv.roundRect(x, y, width, 24, 4, G.withAlpha(color, 0.13));
            cv.strokeRoundRect(x, y, width, 24, 4, 1, G.withAlpha(color, 0.42));
            cv.text(label, x + width / 2, y + 16, 13, color, { align: 'center', font: 'bold', spacing: 0.8, literal: true });
            return width;
        }

        function memberDescription(detail) {
            if (detail === null || detail === undefined) return '';
            try { return typeof detail === 'string' ? detail : JSON.stringify(detail); }
            catch (error) { return ''; }
        }

        function drawDetails(cv, theme, hit, hits) {
            const members = hit.members;
            const pageCount = Math.max(1, Math.ceil(members.length / DETAIL_ROWS));
            const page = detailPage % pageCount;
            const y0 = (G.TOP || 44) + 8;
            const title = compactName(hit.interfaceName);
            const titleWidth = Math.min(WIDTH - 640, Math.max(360, cv.textWidth(title, 23, { font: 'bold' }) + 48));
            cv.fill([[32, y0 + 4], [32 + titleWidth, y0 + 4], [32 + titleWidth - 14, y0 + 44], [32, y0 + 44]], G.withAlpha(theme.accent, 0.9));
            cv.text(fitText(cv, title, 23, titleWidth - 54, { font: 'bold', literal: true }), 32 + (titleWidth - 14) / 2,
                y0 + 30, 23, theme.text, { align: 'center', font: 'bold', spacing: 0.8, literal: true });
            cv.text('MATCH ' + (detailIndex + 1) + ' / ' + hits.length + '   ' + members.length + ' MEMBERS', WIDTH - 34, y0 + 30,
                16, theme.dim, { align: 'right', font: 'bold', spacing: 0.8, literal: true });

            const firstY = y0 + 57;
            if (!members.length) {
                cv.text('The catalog has no listed fields, methods, events or types for this interface.', 42, firstY + 28,
                    18, theme.dim, { literal: true });
                return;
            }
            members.slice(page * DETAIL_ROWS, page * DETAIL_ROWS + DETAIL_ROWS).forEach(function (member, index) {
                const y = firstY + index * 33;
                const matches = currentTopic().member.test(member.name);
                if (matches) cv.fillRect(32, y, 4, 28, theme.accent);
                const chipW = memberChip(cv, theme, matches ? 48 : 40, y + 1, member.kind);
                cv.text(fitText(cv, member.name, 17, 600, { font: matches ? 'bold' : 'normal', literal: true }),
                    (matches ? 48 : 40) + chipW + 14, y + 20, 17, matches ? (theme.accent2 || theme.text) : theme.text,
                    { font: matches ? 'bold' : 'normal', literal: true });
                const description = memberDescription(member.detail);
                if (description) cv.text(fitText(cv, description, 13, WIDTH - 830, { literal: true }), 820, y + 19, 13, theme.dim, { literal: true });
            });
            if (pageCount > 1) cv.text('PAGE ' + (page + 1) + ' / ' + pageCount + '   USE MORE FOR NEXT PAGE', WIDTH - 38,
                HEIGHT - 10, 14, theme.dim, { align: 'right', font: 'bold', spacing: 0.8, literal: true });
        }

        function nextMatch() {
            const hits = topicResults();
            if (!hits.length) { notify('NO MATCHES ON THIS TOPIC'); return; }
            if (detailIndex + 1 >= hits.length) detailIndex = -1;
            else detailIndex++;
            detailPage = 0;
            updateDetailButton();
        }

        ui.onClick('BTN_TOPIC', safe('next topic', function () { changeTopic(selectedTopic + 1); }));
        ui.onClick('BTN_DETAIL', safe('details', function () {
            if (detailIndex >= 0) nextMatch();
            else if (topicResults().length) openDetail(0);
            else notify('NO MATCHES ON THIS TOPIC');
        }));
        ui.onClick('BTN_MORE', safe('next page', function () {
            if (detailIndex >= 0) {
                const hit = topicResults()[detailIndex];
                const count = hit ? Math.max(1, Math.ceil(hit.members.length / DETAIL_ROWS)) : 1;
                if (count > 1) detailPage = (detailPage + 1) % count;
                else notify('ALL MEMBERS ARE ON THIS PAGE');
            } else {
                const count = Math.max(1, Math.ceil(topicResults().length / LIST_ROWS));
                if (count > 1) listPage = (listPage + 1) % count;
                else notify('ALL MATCHES ARE ON THIS PAGE');
            }
        }));
        ui.onClick('BTN_SAVE', safe('save report', function () { saveReport(false); }));

        if (ctx.onTab) ctx.onTab(function (index) {
            if (index < 0 || index >= Catalog.TOPICS.length) return null;
            changeTopic(index);
            return true;
        });
        if (ctx.display) {
            ctx.display.customBackBtn = true;
            ctx.display.onBack = function () {
                if (detailIndex < 0) return false;
                detailIndex = -1;
                detailPage = 0;
                updateDetailButton();
                return true;
            };
        }

        function draw() {
            const theme = ctx.theme();
            const cv = ctx.canvas(WIDTH, HEIGHT).clear(theme.bg);
            const hits = topicResults();
            G.pageBottom(cv);
            G.frame(cv, theme, TOPIC_TABS, selectedTopic, [
                { text: document ? interfaceCount + ' INTERFACES' : (readError ? 'CATALOG ERROR' : 'LOADING'), color: readError ? 'crit' : 'dim' },
                { text: hits.length + ' MATCHES', color: hits.length ? 'ok' : 'dim' },
                { text: 'READ ONLY', color: 'dim' }
            ]);
            G.sectionRule(cv, theme, 24, G.TOP || 44, WIDTH - 48, theme.stripes || theme.accent);
            if (detailIndex >= 0 && hits[detailIndex]) drawDetails(cv, theme, hits[detailIndex], hits);
            else drawList(cv, theme, hits);
            if (toast && Date.now() < toast.expires) {
                cv.roundRect(32, HEIGHT - 40, 290, 28, 5, G.withAlpha(theme.panelTop, 0.94));
                cv.text(toast.message, 44, HEIGHT - 21, 14, theme.accent2 || theme.text, { font: 'bold', literal: true });
            }
            return ui.image('MAIN_GFX', cv);
        }

        if (ctx.onLayout) ctx.onLayout(safe('layout render', draw));
        if (ctx.loop) ctx.loop('MAIN', 5, safe('render', draw), { gpuFps: 8 });
        loadLocalCatalog();
        log.info('VKP DEV-SCAN ' + VERSION + ' started; local-file-only mode');
    }
});
