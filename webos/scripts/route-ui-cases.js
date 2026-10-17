'use strict';
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
async function main() {
  const { stopMarkerGroups, renderSvgRoute } = await import(pathToFileURL(path.join(__dirname, '../web/js/routeview.js')));
  const route = { stops: [
    { poiId: 'first', name: '第一站', coord: [104.06, 30.66] },
    { poiId: 'second', name: '第二站', coord: [104.061, 30.66] },
    { poiId: 'third', name: '第三站', coord: [104.06101, 30.66001] },
    { poiId: 'fourth', name: '第四站', coord: [104.063, 30.66] },
    { poiId: 'fifth', name: '末站', coord: [104.064, 30.66] },
  ], legs: [{ geometry: { coordinates: [[104.059, 30.66], [104.064, 30.66]] }, isReturnLeg: true }] };
  const groups = stopMarkerGroups(route, { nextPoiId: 'third' });
  assert.equal(groups.length, 4); assert.equal(groups.find((g) => g.isNext).text, '2·3');
  assert.equal(groups.find((g) => g.endsHere).text, '5/终');
  const nodes = [], labels = [];
  const map = { el: (name, attrs) => { const node = { name, attrs }; nodes.push(node); return node; } };
  renderSvgRoute(map, route, { toXY: (p) => ({ x: p.lng * 1000, y: p.lat * 1000 }) }, { nextPoiId: 'third', labels: 'all', drawLabel: (_m, _p, text) => labels.push(text) });
  assert(nodes.some((n) => n.textContent === '2·3')); assert(nodes.some((n) => n.textContent === '5/终'));
  assert(!nodes.some((n) => n.textContent === '终')); assert.deepEqual(labels, ['第三站']);
  console.log('PASS T7 SVG 25m内合并编号、60m内合并终点、仅当前站显示名称');
  const { AmapRouteMap } = await import(pathToFileURL(path.join(__dirname, '../web/js/ui.js')));
  class MapStub { on() {} getZoom() { return 16; } add() {} remove() {} setFitView() {} }
  class MarkerStub { constructor(options) { this.options = options; } }
  const amap = new AmapRouteMap({ style: {}, classList: { add() {}, toggle() {} } }, { AMap: {
    Map: MapStub, Marker: MarkerStub, Polyline: MarkerStub, LngLat: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } },
  } });
  amap.renderRoute(route, { nextPoiId: 'third', labels: 'all' });
  const markers = amap.overlays.filter((o) => o.options.content);
  assert(markers.some((m) => m.options.content.includes('>2·3</div>')));
  assert(markers.some((m) => m.options.content.includes('>5/终</div>')));
  assert(!markers.some((m) => m.options.content.includes('>终</div>')));
  assert.equal(markers.filter((m) => m.options.label).length, 1);
  console.log('PASS T7 AMap 与SVG共享标记规则，保留当前站高亮');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
