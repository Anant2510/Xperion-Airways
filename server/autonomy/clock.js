/* autonomy/clock.js — injectable time so the simulator can replay T-72h → T-0
   deterministically. Domain timestamps (holds, offers, predictions) use this;
   row bookkeeping (created_at) stays on wall time. */
"use strict";
let _now = null;                       // null → wall clock
const now = () => (_now ? new Date(_now) : new Date());
const nowIso = () => now().toISOString();
const set = (iso) => { _now = new Date(iso).getTime(); };
const advance = (ms) => { _now = (_now ?? Date.now()) + ms; };
const reset = () => { _now = null; };
const hour = () => now().getUTCHours();
module.exports = { now, nowIso, set, advance, reset, hour };
