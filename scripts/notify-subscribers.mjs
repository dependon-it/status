// Status emails for subscribers (IT-1357). Runs in the PUBLIC status repo, from an `issues` event.
//
// One short email when a real incident has lasted ten minutes, one when it ends — and NEVER one for
// planned downtime. It makes a Brevo campaign for the status list, the way
// scripts/send-weekly-brevo-newsletter.mjs does for the weekly digest.
//
//   node scripts/notify-subscribers.mjs --event <issue-event.json> [--recheck] [--mode dry-run|draft|send-now] [--yes]
//
// Dry run is the default and makes NO network call. Email cannot be taken back, so the workflow ships
// switched off and in `draft` mode.
//
// The email holds the site's NAME, the times and a link to the status page. It never holds the checked
// address, the issue text, or the name of a person (standing rule D).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

import { nextNightlyWindow, sast } from './planned-downtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BREVO_URL = 'https://api.brevo.com/v3'
const STATUS_PAGE = 'https://status.dependon.it'

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const labelNames = (issue) => (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name))

/** Site name and slug for an incident issue: the slug label, looked up in the config; else the title. */
export const siteOf = (issue, sites) => {
  const slug = labelNames(issue).find((name) => sites.some((site) => site.slug === name))
  if (slug) return { slug, name: sites.find((site) => site.slug === slug).name }
  const fromTitle = String(issue.title ?? '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/ (is down|has degraded performance)$/, '')
  return { slug: null, name: fromTitle || 'DependOn.It' }
}

/** Is `when` inside a planned window that covers this site? Nightly comes from the yml, hibernation from the json. */
export const insidePlannedDowntime = ({ when, slug, nightly, windows }) => {
  const covers = (window) => !slug || window.components.includes(slug)
  const night = nextNightlyWindow(when, nightly)
  if (night.start <= when && when < night.end && covers({ components: nightly.components })) return true
  return windows.some(
    (window) => window.kind === 'hibernation' && new Date(window.start) <= when && when < new Date(window.end) && covers(window)
  )
}

const when = (date) => `${sast(date)} South African time (${date.toISOString().slice(0, 16).replace('T', ' ')} UTC)`

/** The email for one event. Pure. */
export const buildEmail = ({ action, siteName, at }) => {
  const name = escapeHtml(siteName)
  const isOpen = action === 'opened'
  const subject = isOpen ? `DependOn.It: ${siteName} is down` : `DependOn.It: ${siteName} is back`
  const lead = isOpen ? `${name} has a problem. We are looking into it.` : `${name} is working again.`
  const html = [
    '<!doctype html><html><body style="font-family: Arial, sans-serif; line-height: 1.5; color: #1a2b2e">',
    `<h2 style="margin: 0 0 12px">${escapeHtml(subject)}</h2>`,
    `<p>${lead}</p>`,
    `<p>${isOpen ? 'Started' : 'Ended'}: ${escapeHtml(when(at))}.</p>`,
    `<p><a href="${STATUS_PAGE}">See the status page</a> for the latest.</p>`,
    '<hr style="border: 0; border-top: 1px solid #ccd6d8; margin: 20px 0">',
    '<p style="font-size: 12px; color: #5a6b6e">You get this because you asked for DependOn.It status emails. ',
    '<a href="{{ unsubscribe }}">Unsubscribe</a></p>',
    '</body></html>',
  ].join('\n')
  return { subject, html, preview: `${isOpen ? 'Started' : 'Ended'} ${sast(at)} South African time` }
}

const brevo = async (path, apiKey, options, fetchImpl) => {
  const response = await fetchImpl(`${BREVO_URL}${path}`, {
    ...options,
    headers: { accept: 'application/json', 'api-key': apiKey, ...(options?.body ? { 'content-type': 'application/json' } : {}) },
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`Brevo request failed (${response.status}): ${String(payload?.message ?? '').slice(0, 200)}`)
  return payload
}

const campaignExists = async (apiKey, name, fetchImpl) => {
  for (let page = 0; page < 5; page += 1) {
    const payload = await brevo(
      `/emailCampaigns?type=classic&limit=100&offset=${page * 100}&sort=desc&excludeHtmlContent=true`,
      apiKey,
      {},
      fetchImpl
    )
    const campaigns = payload?.campaigns ?? []
    if (campaigns.some((campaign) => campaign.name === name)) return true
    if (campaigns.length < 100) return false
  }
  return false
}

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)

/**
 * Decide and (maybe) send. Returns { outcome, ... }. `outcome` is one of:
 * skipped-not-incident, skipped-planned-downtime, skipped-no-longer-open, skipped-existing, skipped-no-down-email,
 * dry-run, draft-created, sent.
 */
export const run = async ({ event, dir, mode = 'dry-run', recheck = false, env = {}, fetchImpl, log = console.log }) => {
  const issue = event.issue ?? {}
  const action = event.action
  if (!['opened', 'closed'].includes(action) || !labelNames(issue).includes('status')) return { outcome: 'skipped-not-incident' }

  const config = yaml.load(readFileSync(join(dir, '.upptimerc.yml'), 'utf8'))
  const sites = (config.sites ?? []).map((site) => ({
    name: site.name,
    slug:
      site.slug ??
      String(site.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
  }))
  const { slug, name } = siteOf(issue, sites)
  const at = new Date(action === 'opened' ? issue.created_at : (issue.closed_at ?? issue.updated_at ?? new Date()))

  const nightly = yaml.load(readFileSync(join(dir, 'planned-downtime.yml'), 'utf8')).nightly
  const windows = readJson(join(dir, 'planned-downtime.json'), { windows: [] }).windows
  if (insidePlannedDowntime({ when: new Date(issue.created_at ?? at), slug, nightly, windows })) {
    log('skipped: planned downtime')
    return { outcome: 'skipped-planned-downtime' }
  }

  if (recheck) {
    if (!env.GH_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('--recheck needs GH_TOKEN and GITHUB_REPOSITORY')
    const current = await (
      await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${issue.number}`, {
        headers: { Authorization: `Bearer ${env.GH_TOKEN}` },
      })
    ).json()
    if (action === 'opened' && current.state !== 'open') {
      log('skipped: the incident did not last ten minutes')
      return { outcome: 'skipped-no-longer-open' }
    }
  }

  const email = buildEmail({ action, siteName: name, at })
  const campaignName = `DependOn.It status incident ${issue.number} ${action === 'opened' ? 'down' : 'back'}`

  if (mode === 'dry-run') {
    log(`dry run: no network call was made.\ncampaign: ${campaignName}\nsubject: ${email.subject}\n\n${email.html}`)
    return { outcome: 'dry-run', email, campaignName }
  }

  const apiKey = env.BREVO_API_KEY
  const listId = Number(env.BREVO_STATUS_LIST_ID)
  if (!apiKey || !Number.isSafeInteger(listId) || listId <= 0 || !env.BREVO_STATUS_SENDER_EMAIL) {
    throw new Error('BREVO_API_KEY, BREVO_STATUS_LIST_ID and BREVO_STATUS_SENDER_EMAIL are required for draft and send-now')
  }

  if (await campaignExists(apiKey, campaignName, fetchImpl)) return { outcome: 'skipped-existing', campaignName }
  if (action === 'closed' && !(await campaignExists(apiKey, `DependOn.It status incident ${issue.number} down`, fetchImpl))) {
    return { outcome: 'skipped-no-down-email', campaignName }
  }

  const created = await brevo(
    '/emailCampaigns',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        name: campaignName,
        subject: email.subject,
        sender: { email: env.BREVO_STATUS_SENDER_EMAIL, name: env.BREVO_STATUS_SENDER_NAME || 'DependOn.It' },
        recipients: { listIds: [listId] },
        htmlContent: email.html,
        previewText: email.preview,
        mirrorActive: true,
      }),
    },
    fetchImpl
  )
  if (mode === 'send-now') {
    await brevo(`/emailCampaigns/${created.id}/sendNow`, apiKey, { method: 'POST' }, fetchImpl)
    return { outcome: 'sent', campaignName, campaignId: created.id }
  }
  return { outcome: 'draft-created', campaignName, campaignId: created.id }
}

const parseArgs = (argv) => {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[argv[i].slice(2)] = true
    else {
      flags[argv[i].slice(2)] = next
      i += 1
    }
  }
  return flags
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = parseArgs(process.argv.slice(2))
  const mode = typeof flags.mode === 'string' ? flags.mode : 'dry-run'
  if (!['dry-run', 'draft', 'send-now'].includes(mode)) {
    console.error('--mode must be dry-run, draft or send-now')
    process.exit(1)
  }
  if (mode !== 'dry-run' && flags.yes !== true) {
    console.error(`--mode ${mode} needs --yes (it makes a real Brevo call)`)
    process.exit(1)
  }
  if (typeof flags.event !== 'string') {
    console.error('usage: notify-subscribers.mjs --event <issue-event.json> [--recheck] [--mode dry-run|draft|send-now] [--yes]')
    process.exit(1)
  }
  run({
    event: JSON.parse(readFileSync(flags.event, 'utf8')),
    dir: typeof flags.config === 'string' ? flags.config : join(here, '..'),
    mode,
    recheck: flags.recheck === true,
    env: process.env,
    fetchImpl: fetch,
  })
    .then((result) => {
      if (result.outcome !== 'dry-run' && result.outcome !== 'skipped-planned-downtime')
        console.log(`${result.outcome}: ${result.campaignName ?? ''}`.trim())
    })
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
