import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, buildAttention, csvCell, isActive } from '../src/features/attendance/attendance.js';

test('roster retains absentees, labels duplicates and identifies late arrivals', () => {
  const students = [{ id: '1', full_name: 'Alex', student_id: '1' }, { id: '2', full_name: 'Alex', student_id: '2' }, { id: '3', full_name: 'Mia' }];
  const logs = [{ student_name: 'Alex (1)', status: 'Present', date: new Date(2026, 9, 27, 9, 8) }, { student_name: 'Alex (2)', status: 'Present', date: new Date(2026, 9, 27, 9, 2) }];
  const roster = buildRoster(students, logs, 540);
  assert.equal(roster.find(s => s.id === '1').late, true);
  assert.equal(roster.find(s => s.id === '2').late, false);
  assert.equal(roster.find(s => s.id === '3').status, 'Absent');
});
test('CSV escapes quotes and spreadsheet formula prefixes', () => {
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('A "quote"'), '"A ""quote"""');
});
test('shutdown and stale heartbeat never report active', () => {
  const heartbeat = new Date('2026-10-27T09:00:00Z');
  assert.equal(isActive({ heartbeat }, heartbeat.getTime() + 1000), true);
  assert.equal(isActive({ heartbeat }, heartbeat.getTime() + 181000), false);
  assert.equal(isActive({ heartbeat, shutdown: heartbeat }, heartbeat.getTime()), false);
});
test('attention averages only present numeric samples', () => {
  const date = new Date(2026, 9, 27, 9, 0);
  assert.deepEqual(buildAttention([{ status: 'Present', date, attention_score: 50 }, { status: 'Present', date, attention_score: 70 }, { status: 'Absent', date, attention_score: 0 }]), [{ time: '09:00', attention: 60 }]);
});
