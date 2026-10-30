// Scheduled hibernate: a namespace goes to sleep and wakes on a clock (e.g.
// dev 21:00 → 09:00, Monday–Friday, Asia/Kolkata). Checked every minute;
// a change freeze skips the step (and says so); the Hibernate feature and its
// schedule flag must be usable for the workspace.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const TZ = /^(UTC|[A-Z][A-Za-z_]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?)$/
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export function cleanSchedule(b) {
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }) }
    if (!NS.test(String(b?.namespace || ''))) bad('namespace is not valid')
    if (!HHMM.test(String(b?.sleep || '')) || !HHMM.test(String(b?.wake || ''))) bad('Sleep and wake: HH:MM (24 h)')
    if (b.sleep === b.wake) bad('Sleep and wake must differ')
    const tz = String(b?.timezone || 'Asia/Kolkata')
    if (!TZ.test(tz)) bad('Time zone like Asia/Kolkata or UTC')
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { bad('Unknown time zone') }
    const days = [...new Set((Array.isArray(b?.days) && b.days.length ? b.days : [1, 2, 3, 4, 5]).map(Number))]
    if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) bad('Days: 0 (Sunday) to 6 (Saturday)')
    return { clusterId: String(b?.clusterId || ''), namespace: b.namespace, sleep: b.sleep, wake: b.wake, timezone: tz, days: days.sort() }
}

/** The local day (0–6) and "HH:MM" at `now` in a time zone. */
export function localClock(now, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(x => [x.type, x.value]))
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), time: `${p.hour}:${p.minute}` }
}
/** What a schedule wants at `now`: 'sleep' | 'wake' | null. A wake is due on the day after a sleep day too. */
export function dueAt(s, now) {
    const { day, time } = localClock(now, s.timezone)
    if (time === s.sleep && s.days.includes(day)) return 'sleep'
    // waking after midnight belongs to the day before (sleep Fri 21:00 → wake Sat 09:00)
    const wakeDay = s.wake < s.sleep ? (day + 6) % 7 : day
    if (time === s.wake && s.days.includes(wakeDay)) return 'wake'
    return null
}

const ran = new Map()   // schedule id → "action@YYYY-MM-DDTHH:MM" last done
/** One tick: run what is due. deps: schedules(), clusterOf(id), usable(orgId), frozen(cluster), hibernate, wake, notify, audit */
export async function tick(deps, now = Date.now()) {
    const minute = new Date(now).toISOString().slice(0, 16)
    const done = []
    for (const s of deps.schedules()) {
        const action = dueAt(s, now)
        if (!action || ran.get(s.id) === `${action}@${minute}`) continue
        ran.set(s.id, `${action}@${minute}`)
        const cluster = await deps.clusterOf(s.clusterId)
        if (!cluster || !deps.usable(cluster.orgId)) continue
        if (deps.frozen(cluster)) { deps.notify(cluster, { severity: 'info', title: `Scheduled ${action} skipped: ${s.namespace} (change freeze)`, text: `The ${action} of ${s.namespace} at ${s[action]} (${s.timezone}) was skipped because a change freeze is active.` }); continue }
        try {
            const r = await (action === 'sleep' ? deps.hibernate : deps.wake)(cluster, s.namespace)
            deps.audit(cluster, `scheduled ${action === 'sleep' ? 'hibernate' : 'wake'} ${s.namespace}: ${r.changed.join(', ') || 'nothing to do'}`, true)
            done.push(`${action} ${s.namespace}`)
        } catch (e) {
            deps.audit(cluster, `scheduled ${action} ${s.namespace} failed: ${e.message}`, false)
            deps.notify(cluster, { severity: 'warning', title: `Scheduled ${action} failed: ${s.namespace}`, text: e.message })
        }
    }
    return done
}
export const _test = { reset: () => ran.clear() }

export async function startHibernateSchedules() {
    const [{ deliveryStore }, { features }, hib, { notifier }, { clusterStore }, { auditLog }] = await Promise.all([
        import('./deliveryStore.js'), import('./features.js'), import('./hibernate.js'), import('./notifier.js'), import('./clusterStore.js'), import('./auditLog.js')])
    const deps = {
        schedules: () => deliveryStore.allHibernateSchedules(),
        clusterOf: async (id) => (await clusterStore.getClusters().catch(() => [])).find(c => c.id === id) || null,
        usable: (orgId) => features.usable(orgId, 'hibernate') && features.usable(orgId, 'hibernateSchedule'),
        frozen: (c) => !!deliveryStore.activeFreeze(c.orgId, c.id),
        hibernate: (c, ns) => hib.hibernate(c, ns), wake: (c, ns) => hib.wake(c, ns),
        notify: (c, ev) => notifier.emit(c.orgId, { type: 'hibernate_schedule', key: `hib|${c.id}|${ev.title}`, clusterId: c.id, clusterName: c.clusterName, ...ev }),
        audit: (c, detail, ok) => auditLog.record({ orgId: c.orgId, actor: { id: 'kubeez', username: 'KubeEZ schedule' }, action: 'hibernate.schedule', target: { clusterId: c.id, clusterName: c.clusterName }, ok, detail })
    }
    const t = setInterval(() => tick(deps).catch(e => console.error(`[HibernateSchedule] ${e.message}`)), 60e3)
    t.unref?.()
}
