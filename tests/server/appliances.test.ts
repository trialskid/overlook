// Home → Appliances card text (src/desktop/Home.tsx applianceView). Run: node --import tsx --test tests/server/appliances.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applianceView } from '../../src/desktop/Home.tsx';

const base = { progress: null, remainingMin: null, finishAt: null, battery: null, areaM2: null, lastAt: null, energyTodayKwh: null, maintenance: null };

test('laundry running shows time left and a progress bar only while running; off is quiet', () => {
  const run = applianceView({ ...base, kind: 'laundry', name: 'Washer', state: 'running', remainingMin: 72, energyTodayKwh: 0.4 });
  assert.equal(run.word, 'Running');
  assert.deepEqual(run.lines.map(l => l.text), ['1 h 12 min left', '0.4 kWh today']);
  const off = applianceView({ ...base, kind: 'laundry', name: 'Dryer', state: 'off', energyTodayKwh: 0 });
  assert.deepEqual([off.word, off.lines.length, off.progress], ['Off', 0, null]);
});

test('vacuum: overdue maintenance is amber; no data says so and shows nothing else', () => {
  const v = applianceView({ ...base, kind: 'vacuum', name: 'Vacuum', state: 'cleaning', progress: 53, areaM2: 30.1, battery: 76, maintenance: { name: 'Sensors', hoursLeft: -32 } });
  assert.equal(v.progress, 53);
  assert.deepEqual(v.lines.map(l => [l.text, !!l.warn]), [['53% done', false], ['battery 76%', false], ['Sensors: clean now (32 h overdue)', true]]);
  assert.deepEqual(applianceView({ ...base, kind: 'vacuum', name: 'Vacuum', state: 'no-data' }), { word: 'No data', tone: 'var(--mut-3)', lines: [], progress: null });
});

test('thermostat and bed: temperature is the word; a setpoint only while not off', () => {
  const g = applianceView({ ...base, kind: 'thermostat', name: 'Garage', state: 'off', tempC: 17.22, targetC: 10, humidity: 20, battery: 75 });
  assert.deepEqual([g.word, g.lines.map(l => l.text)], ['17.2°', ['Off', 'battery 75%']]);
  const b = applianceView({ ...base, kind: 'bed', name: 'Bed', state: 'heating', tempC: 21, targetC: 27, inBed: true, sleptMin: 489 });
  assert.deepEqual(b.lines.map(l => l.text), ['bed · heating · set 27.0°']);
});
