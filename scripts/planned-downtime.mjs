// Planned downtime for the status page (IT-1353). Runs in the PUBLIC status repo.
//
// Upptime keeps an expected outage out of uptime and out of incidents when an OPEN issue
// with the label `maintenance` carries a comment block with start, end, expectedDown and
// expectedDegraded (UPPTIME-NOTES.md, section b). Upptime closes and locks that issue after
// its end, so `ensure` unlocks, re-dates and reopens the ONE standing nightly issue.
//
// Commands (all are dry runs unless --yes is given):
//   ensure                                  tonight's (or the running) nightly window
//   open --from <UTC> --to <UTC> --reason   a full-hibernation window
//   extend --to <UTC>                       move the end of the open hibernation window
//   close                                   end the open hibernation window now
// Flags: --yes  --out <file>  --now <UTC>  --components a,b  --config <dir>
// The state of hibernation windows is planned-downtime.json (our own shape, rewritten by
// every command). Nothing in it depends on Upptime.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const MINUTE = 60_000
const NIGHTLY_TITLE = 'Nightly sleep (test phase)'
const HIBERNATION_TITLE = 'Planned hibernation'

const parseHm = (value) => {
  const [hours, minutes] = String(value).split(':').map(Number)
  return hours * 60 + minutes
}

/** The first nightly window that has not ended yet: the running one, or the next. */
export const nextNightlyWindow = (now, nightly) => {
  const startMin = parseHm(nightly.start)
  const endMin = parseHm(nightly.end)
  const crossesMidnight = endMin <= startMin
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (let day = -1; day <= 1; day += 1) {
    const base = today + day * 24 * 60 * MINUTE
    const start = base + startMin * MINUTE
    const end = base + ((crossesMidnight ? 24 * 60 : 0) + endMin) * MINUTE
    if (end > now.getTime()) return { start: new Date(start), end: new Date(end) }
  }
  throw new Error('no nightly window found')
}

/** South African time (UTC+2, no daylight saving) as "YYYY-MM-DD HH:mm". */
export const sast = (date) => new Date(date.getTime() + 120 * MINUTE).toISOString().slice(0, 16).replace('T', ' ')

/** The issue body Upptime reads. The comment block is the contract; the rest is for people. */
export const maintenanceBody = ({ start, end, components, message }) =>
  [
    '<!--',
    `start: ${start.toISOString()}`,
    `end: ${end.toISOString()}`,
    `expectedDown: ${components.join(', ')}`,
    `expectedDegraded: ${components.join(', ')}`,
    '-->',
    message,
    '',
    `Planned from ${sast(start)} to ${sast(end)} South African time (${start.toISOString()} to ${end.toISOString()} UTC).`,
  ].join('\n')

/** The issue body for a window in the JSON shape (dates as text). */
export const bodyOf = (window) => maintenanceBody({ ...window, start: new Date(window.start), end: new Date(window.end) })

const toWindow = (kind, start, end, components, message) => ({
  kind,
  start: start.toISOString(),
  end: end.toISOString(),
  components,
  message,
})

/** The planned-downtime.json document: only windows that have not ended. */
export const buildWindowsJson = ({ now, nightly, hibernations }) => {
  const night = nextNightlyWindow(now, nightly)
  const windows = [
    toWindow('nightly', night.start, night.end, nightly.components, nightly.message),
    ...hibernations.filter((window) => new Date(window.end).getTime() > now.getTime()),
  ]
  return { generatedAt: now.toISOString(), windows }
}

export const createGitHub = ({ fetchImpl = fetch, token, repo }) => {
  const call = async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.status === 404 || response.status === 204) return null
    if (!response.ok) throw new Error(`GitHub ${method} ${path} answered ${response.status}`)
    return response.json()
  }
  return {
    listMaintenance: () => call('GET', '/issues?labels=maintenance&state=all&per_page=100'),
    listOpenStatusIssues: (slug) => call('GET', `/issues?labels=status,${slug}&state=open&per_page=5`),
    createIssue: async ({ title, body, labels }) => {
      const issue = await call('POST', '/issues', { title, body, labels })
      await call('PUT', `/issues/${issue.number}/lock`, { lock_reason: 'resolved' })
      return issue
    },
    // Upptime locks its issues; a locked issue cannot be edited by a token without push access,
    // and unlocking an unlocked issue is harmless.
    updateIssue: async (number, patch) => {
      await call('DELETE', `/issues/${number}/lock`)
      const issue = await call('PATCH', `/issues/${number}`, patch)
      await call('PUT', `/issues/${number}/lock`, { lock_reason: 'resolved' })
      return issue
    },
  }
}

/** One standing nightly issue, re-dated and reopened. Running it twice changes nothing. */
export const syncNightlyIssue = async (github, window) => {
  const body = bodyOf(window)
  const existing = ((await github.listMaintenance()) ?? []).find((issue) => issue.title === NIGHTLY_TITLE)
  if (!existing) return { action: 'created', issue: await github.createIssue({ title: NIGHTLY_TITLE, body, labels: ['maintenance'] }) }
  if (existing.state === 'open' && existing.body === body) return { action: 'unchanged', issue: existing }
  return { action: 'updated', issue: await github.updateIssue(existing.number, { body, state: 'open' }) }
}

const findHibernationIssue = async (github) =>
  ((await github.listMaintenance()) ?? []).find((issue) => issue.state === 'open' && issue.title.startsWith(HIBERNATION_TITLE))

export const syncHibernationIssue = async (github, window, { closed = false } = {}) => {
  const body = bodyOf(window)
  const existing = await findHibernationIssue(github)
  if (!existing) {
    if (closed) return { action: 'none' }
    const title = `${HIBERNATION_TITLE} (${window.start.slice(0, 10)})`
    return { action: 'created', issue: await github.createIssue({ title, body, labels: ['maintenance'] }) }
  }
  return { action: 'updated', issue: await github.updateIssue(existing.number, { body, state: closed ? 'closed' : 'open' }) }
}

/**
 * Upptime opens an incident only when a status CHANGES, so a site that went down inside a
 * window and is STILL down after it would never open one (UPPTIME-NOTES.md, section b).
 * After a window: any sleeping site that is down and has no open incident gets one by hand.
 */
export const openMissedIncidents = async ({ github, now, windows, sites, readStatus }) => {
  const insideWindow = windows.some((window) => new Date(window.start) <= now && now < new Date(window.end))
  if (insideWindow) return []
  const slugs = [...new Set(windows.flatMap((window) => window.components))]
  const opened = []
  for (const slug of slugs) {
    const status = readStatus(slug)
    if (status !== 'down' && status !== 'degraded') continue
    if (((await github.listOpenStatusIssues(slug)) ?? []).length > 0) continue
    const name = sites.find((site) => site.slug === slug)?.name ?? slug
    const issue = await github.createIssue({
      title: status === 'down' ? `🛑 ${name} is down` : `⚠️ ${name} has degraded performance`,
      body: `${name} was ${status} when its planned maintenance ended. The checker only opens an incident when a status changes, so this one was opened by the planned-downtime job.`,
      labels: ['status', slug],
    })
    opened.push({ slug, issue: issue.number })
  }
  return opened
}

const readStatusFile = (dir) => (slug) => {
  const file = join(dir, 'history', `${slug}.yml`)
  if (!existsSync(file)) return 'unknown'
  const text = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => (line.startsWith('- ') ? line.slice(2) : line))
    .join('\n')
  return yaml.load(text)?.status ?? 'unknown'
}

const parseArgs = (argv) => {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue
    const key = rest[i].slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return { command, flags }
}

const mustDate = (value, name) => {
  const date = new Date(String(value))
  if (!value || Number.isNaN(date.getTime())) throw new Error(`--${name} must be a date and time in UTC, for example 2026-10-14T18:00:00Z`)
  return date
}

export const main = async (argv, { fetchImpl, log = console.log, env = process.env } = {}) => {
  const { command, flags } = parseArgs(argv)
  if (!['ensure', 'open', 'extend', 'close'].includes(command)) {
    throw new Error(
      'usage: planned-downtime.mjs ensure | open --from --to --reason | extend --to | close  [--yes] [--out file] [--now UTC]'
    )
  }
  const dir = flags.config ? String(flags.config) : join(here, '..')
  const config = yaml.load(readFileSync(join(dir, 'planned-downtime.yml'), 'utf8'))
  const sites = (yaml.load(readFileSync(join(dir, '.upptimerc.yml'), 'utf8'))?.sites ?? []).map((site) => ({
    name: site.name,
    slug:
      site.slug ??
      String(site.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
  }))
  const now = flags.now ? mustDate(flags.now, 'now') : new Date()
  const yes = flags.yes === true
  const outFile = flags.out ? String(flags.out) : join(dir, 'planned-downtime.json')

  const previous = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { windows: [] }
  let hibernations = (previous.windows ?? []).filter((window) => window.kind === 'hibernation' && new Date(window.end) > now)
  const github = yes ? createGitHub({ fetchImpl, token: env.GH_TOKEN, repo: env.GITHUB_REPOSITORY }) : null
  if (yes && (!env.GH_TOKEN || !env.GITHUB_REPOSITORY)) throw new Error('--yes needs GH_TOKEN and GITHUB_REPOSITORY')

  const effects = []
  if (command === 'open') {
    if (hibernations.length > 0) throw new Error('a hibernation window is already open; use extend or close')
    const from = mustDate(flags.from, 'from')
    const to = mustDate(flags.to, 'to')
    if (to <= from) throw new Error('--to must be after --from')
    const components =
      typeof flags.components === 'string' ? flags.components.split(',').map((slug) => slug.trim()) : sites.map((site) => site.slug)
    const reason = typeof flags.reason === 'string' ? flags.reason : 'The service is fully hibernated to save cost during the test phase.'
    hibernations = [toWindow('hibernation', from, to, components, reason)]
    if (yes) effects.push(await syncHibernationIssue(github, hibernations[0]))
  } else if (command === 'extend') {
    if (hibernations.length === 0) throw new Error('there is no open hibernation window to extend')
    const to = mustDate(flags.to, 'to')
    if (to <= new Date(hibernations[0].start)) throw new Error('--to must be after the window start')
    hibernations = [{ ...hibernations[0], end: to.toISOString() }]
    if (yes) effects.push(await syncHibernationIssue(github, hibernations[0]))
  } else if (command === 'close') {
    if (hibernations.length > 0) {
      const ended = { ...hibernations[0], end: now.toISOString() }
      if (yes) effects.push(await syncHibernationIssue(github, ended, { closed: true }))
      hibernations = []
    }
  }

  const document = buildWindowsJson({ now, nightly: config.nightly, hibernations })
  if (command === 'ensure' && yes) {
    effects.push(await syncNightlyIssue(github, document.windows[0]))
    const missed = await openMissedIncidents({
      github,
      now,
      windows: [...document.windows, ...previous.windows.filter((window) => window.kind === 'nightly')],
      sites,
      readStatus: readStatusFile(flags.history ? String(flags.history) : process.cwd()),
    })
    if (missed.length > 0) effects.push({ action: 'missed-incidents', missed })
  }

  log(JSON.stringify(document, null, 2))
  if (command === 'ensure' || command === 'open') {
    for (const window of document.windows) {
      log(`--- issue body (${window.kind}) ---\n${bodyOf(window)}`)
    }
  }
  if (yes) {
    writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`)
    log(`wrote ${outFile}; GitHub: ${effects.map((effect) => effect.action).join(', ') || 'nothing to do'}`)
  } else {
    if (flags.out) writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`)
    log('dry run: no network call was made. Add --yes to write to GitHub.')
  }
  return { document, effects }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
