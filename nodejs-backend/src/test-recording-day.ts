/** Pure checks for recordingDayRule / recordingDateFor. No DB needed. npm run test-recording-day */
import assert from 'assert';
import { recordingDayRule, recordingDateFor, recordingDayEndsAt } from './services/recording-day';

// Karachi wall-clock → Date (UTC+5)
const k = (iso: string) => new Date(`${iso}:00+05:00`);
let n = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  assert.strictEqual(got, want, `${label}: got ${got}, want ${want}`);
  n++;
};

const none = recordingDayRule(null);
eq('no shift boundary', none.boundaryMinutes, 0);
eq('no shift start', none.shiftStartMinutes, 0);
eq('no shift 00:30', recordingDateFor(k('2026-03-10T00:30'), none), '2026-03-10');
eq('no shift 23:59', recordingDateFor(k('2026-03-10T23:59'), none), '2026-03-10');
eq('unparsable shift', recordingDayRule({ checkin: 'abc', checkout: '??' }).boundaryMinutes, 0);

const day = recordingDayRule({ checkin: '09:00', checkout: '18:00' });
eq('09-18 boundary 01:30', day.boundaryMinutes, 90);
eq('09-18 00:30 → previous day', recordingDateFor(k('2026-03-10T00:30'), day), '2026-03-09');
eq('09-18 01:29 → previous day', recordingDateFor(k('2026-03-10T01:29'), day), '2026-03-09');
eq('09-18 01:30 → same day', recordingDateFor(k('2026-03-10T01:30'), day), '2026-03-10');
eq('09-18 09:00 → same day', recordingDateFor(k('2026-03-10T09:00'), day), '2026-03-10');
eq('09-18 across month start', recordingDateFor(k('2026-03-01T00:30'), day), '2026-02-28');

const night = recordingDayRule({ checkin: '19:00', checkout: '04:00' });
eq('19-04 boundary 11:30', night.boundaryMinutes, 690);
eq('19-04 19:00 d → d', recordingDateFor(k('2026-03-10T19:00'), night), '2026-03-10');
eq('19-04 02:00 d+1 → d', recordingDateFor(k('2026-03-11T02:00'), night), '2026-03-10');
eq('19-04 11:00 d+1 → d', recordingDateFor(k('2026-03-11T11:00'), night), '2026-03-10');
eq('19-04 12:00 d+1 → d+1', recordingDateFor(k('2026-03-11T12:00'), night), '2026-03-11');

const early = recordingDayRule({ checkin: '00:00', checkout: '08:00' });
eq('00-08 boundary 16:00', early.boundaryMinutes, 960);
eq('00-08 00:30 d → d', recordingDateFor(k('2026-03-10T00:30'), early), '2026-03-10');
eq('00-08 15:59 d → d', recordingDateFor(k('2026-03-10T15:59'), early), '2026-03-10');
eq('00-08 17:00 d → d+1', recordingDateFor(k('2026-03-10T17:00'), early), '2026-03-11');

const ampm = recordingDayRule({ checkin: '9:00 AM', checkout: '6:00 PM' });
eq('am/pm same rule', JSON.stringify(ampm), JSON.stringify(day));
const ampmNight = recordingDayRule({ checkin: '7:00 PM', checkout: '4:00 AM' });
eq('am/pm night same rule', JSON.stringify(ampmNight), JSON.stringify(night));

// UTC instant → Karachi date (22:00 UTC is already the next day in Karachi)
eq('UTC instant converted to Karachi', recordingDateFor(new Date('2026-03-09T22:00:00Z'), none), '2026-03-10');

// day end = next boundary
eq('09-18 day ends at next 01:30', recordingDayEndsAt('2026-03-10', day).toISOString(), k('2026-03-11T01:30').toISOString());
eq('19-04 day ends 11:30 next day', recordingDayEndsAt('2026-03-10', night).toISOString(), k('2026-03-11T11:30').toISOString());
eq('00-08 day ends 16:00 same day', recordingDayEndsAt('2026-03-10', early).toISOString(), k('2026-03-10T16:00').toISOString());
eq('no shift ends next midnight', recordingDayEndsAt('2026-03-10', none).toISOString(), k('2026-03-11T00:00').toISOString());

console.log(`test-recording-day: ${n} checks passed`);
process.exit(0); // prisma.ts keeps a reconnect timer alive
