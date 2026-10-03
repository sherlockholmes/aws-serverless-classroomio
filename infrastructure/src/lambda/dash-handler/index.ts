/**
 * Dash (Analytics) Handler Lambda
 *
 * Handles:
 * - POST /dash/track                (public event ingest — no auth)
 * - GET  /dash/stats                (org dashboard summary — org member)
 * - GET  /dash/login-activity       (student login-by-day-of-week — org admin)
 * - GET  /dash/login-streak         (current user's login streak — session only)
 * - GET  /dash/landing-stats        (landing/course-page funnel totals — org member)
 * - GET  /dash/country-breakdown    (views/enrollments by country — org member)
 * - GET  /dash/course-funnel        (org/course conversion funnel — org member)
 * - GET  /dash/popular-types        (enrollments/views by course type — org member)
 * - GET  /dash/compliance-overview  (org-wide compliance status tallies — org admin)
 *
 * Mirrors apps/api/src/routes/dash/stats.ts's `dashAnalyticsRouter` 1:1 for
 * auth (authMiddleware + orgMemberMiddleware/orgAdminMiddleware per route,
 * per the actual Hono file — NOT the task description's summary, which
 * undersold login-activity/compliance-overview as merely "admin-only
 * breakdowns" without naming them explicitly) and for the query-string
 * source of orgId/siteName/days/courseId/bust: the org-role helpers below
 * are used ONLY as an auth gate (do the caller's session + `cio-org-id`
 * header resolve to *some* membership/admin role in *some* org), exactly
 * like organization-mutation-handler's PUT /organization/plan* routes use
 * `requireOrgAdmin`/API-key auth as a gate independent of the resource id
 * in the body. The actual `orgId` each service call operates on always
 * comes from the query string, matching Hono's `zValidator('query', ...)`
 * behavior (a caller can legitimately query a *different* org's public
 * stats endpoint than the one in their `cio-org-id` header, as long as
 * they're a member of the org named in the query — Hono's own
 * `orgMemberMiddleware`/`orgAdminMiddleware` only ever look at the header,
 * never at the query `orgId`, so this Lambda replicates that exact
 * (slightly permissive) behavior rather than tightening it).
 *
 * Query validation is re-implemented manually here (not via zValidator/Zod)
 * to mirror packages/utils/src/validation/dash/{stats,login-activity,
 * analytics,track}.ts's ZDashStats / ZLoginActivity / ZDashAnalyticsRange /
 * ZDashCourseFunnel / ZDashComplianceOverview / ZIngestBatch schemas. The
 * 400 response shape below (`{success:false, message}`) is a reasonable
 * approximation of Hono's zValidator rejection shape, not a byte-for-byte
 * replica — same tradeoff as every other handler in this batch.
 *
 * The business logic in getOrganisationAnalytics / getStudentLoginActivity /
 * getCurrentUserLoginStreak / getLandingStats / getCountryBreakdown /
 * getCourseFunnel / getPopularTypes / ingestEventBatch / getOrgComplianceOverview
 * is ported inline from apps/api/src/services/{dash.ts,analytics/reads.ts,
 * analytics/ingest.ts,course/compliance.ts} because those service files sit
 * behind the `@api/*` alias this standalone Lambda bundle can't resolve.
 * Every @cio/db import below uses the folder-level subpath
 * (`@cio/db/queries/dash`, `@cio/db/queries/analytics`,
 * `@cio/db/queries/course` — `getOrgComplianceLearnerRows` is re-exported
 * from that folder's own `index.ts`, which re-exports `./compliance`; there
 * is no separate `@cio/db/queries/course/compliance` subpath, since the
 * package only exposes query functions through each folder's own
 * `index.ts` re-exports, not through individual file paths within it).
 * `@cio/core/utils/redis/*` and `@cio/core/config/env`
 * ARE portable (no `@api/*`/`@cio/db` re-export ambiguity, and `@cio/core`'s
 * package.json exposes both subpaths directly), so the Redis caching layers
 * for org stats, login activity, and the four analytics-reads functions are
 * ported in full rather than cut.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/db, @cio/core, and better-auth.
 *
 * KNOWN GAPS (intentional scope cuts for this first pass — the goal is to
 * eliminate the hard 404 from API Gateway, not to reach full functional
 * parity with the Hono service layer in one change):
 *
 * (a) Query validation does not replicate Zod's exact error message
 *     strings/paths — only the same accept/reject boundaries (required
 *     fields, uuid shape, day range 1-365, at-least-one-of orgId/siteName).
 * (b) `dashLoginActivityKey` / `dashAnalyticsKey` cache-key generators are
 *     reimplemented locally (not imported from
 *     `apps/api/src/utils/redis/key-generators.ts`, which sits behind the
 *     `@api/*` alias) but use the same key shape, so an existing warm cache
 *     entry produced by the Render/Hono process will still be a hit here,
 *     and vice versa.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { env } from '@cio/core/config/env';
import { logRedisUnavailableOnce, redis } from '@cio/core/utils/redis/redis';
import { readOrgStatsVersionAndCache, writeOrgStatsCache } from '@cio/core/utils/redis/org-stats-cache';
import {
  getCourseStats,
  getDashOrgStats,
  getOrgStudentLoginsByDayOfWeek,
  getRecentCertifications,
  getTotalCertificatesIssued,
  getUserLoginStreak
} from '@cio/db/queries/dash';
import { getOrgIdBySiteName } from '@cio/db/queries';
import {
  insertPageEvents,
  selectCountryBreakdown,
  selectCourseDailyRange,
  selectOrgDailyRange,
  selectPopularCourseTypes
} from '@cio/db/queries/analytics';
import { getOrgComplianceLearnerRows, type OrgComplianceLearnerRow } from '@cio/db/queries/course';

import { getSessionUserId } from '../_shared/session';
import { requireOrgAdmin, requireOrgMember } from '../_shared/org-membership';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const LOGIN_ACTIVITY_CACHE_TTL_SECONDS = 86_400;
const DASH_ANALYTICS_TTL_SECONDS = 600;
const CLIENT_EVENT_TYPES = [
  'landing_view',
  'course_page_view',
  'signup_view',
  'signin_view',
  'pricing_view',
  'cta_click'
] as const;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function getHeaderCaseInsensitive(event: APIGatewayProxyEventV2, name: string): string | null {
  const headers = event.headers || {};
  const lowerName = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && value) {
      return value;
    }
  }

  return null;
}

/**
 * Mirrors ZDashAnalyticsRange's `days` clause: coerce to int, clamp
 * [1, 365], default when absent. Returns `undefined` (reject) for a
 * present-but-invalid value, matching Zod's behavior of rejecting rather
 * than silently clamping an out-of-range or non-numeric input.
 */
function parseDays(raw: string | undefined, defaultDays: number): number | undefined {
  if (raw === undefined) return defaultDays;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    return undefined;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Query validation (mirrors packages/utils/src/validation/dash/*)
// ---------------------------------------------------------------------------

type DashStatsQuery = { orgId?: string; siteName?: string; bust: boolean };

function validateDashStats(query: Record<string, string>): DashStatsQuery | { message: string } {
  const orgId = query.orgId || undefined;
  const siteName = query.siteName || undefined;

  if (!orgId && !siteName) {
    return { message: 'Either orgId or siteName is required' };
  }

  const bustRaw = query.bust;
  if (bustRaw !== undefined && bustRaw !== '0' && bustRaw !== '1') {
    return { message: 'bust must be "0" or "1"' };
  }

  return { orgId, siteName, bust: bustRaw === '1' };
}

type LoginActivityQuery = { orgId?: string; siteName?: string; days: number };

function validateLoginActivity(query: Record<string, string>): LoginActivityQuery | { message: string } {
  const orgId = query.orgId || undefined;
  const siteName = query.siteName || undefined;

  if (!orgId && !siteName) {
    return { message: 'Either orgId or siteName is required' };
  }

  const days = parseDays(query.days, 90);
  if (days === undefined) {
    return { message: 'days must be an integer between 1 and 365' };
  }

  return { orgId, siteName, days };
}

type DashAnalyticsRangeQuery = { orgId: string; days: number };

function validateDashAnalyticsRange(query: Record<string, string>): DashAnalyticsRangeQuery | { message: string } {
  const orgId = query.orgId;
  if (!orgId || !UUID_REGEX.test(orgId)) {
    return { message: 'orgId must be a valid UUID' };
  }

  const days = parseDays(query.days, 30);
  if (days === undefined) {
    return { message: 'days must be an integer between 1 and 365' };
  }

  return { orgId, days };
}

type DashCourseFunnelQuery = { orgId: string; days: number; courseId?: string };

function validateDashCourseFunnel(query: Record<string, string>): DashCourseFunnelQuery | { message: string } {
  const range = validateDashAnalyticsRange(query);
  if ('message' in range) return range;

  const courseId = query.courseId;
  if (courseId !== undefined && !UUID_REGEX.test(courseId)) {
    return { message: 'courseId must be a valid UUID' };
  }

  return { ...range, courseId };
}

type DashComplianceOverviewQuery = { orgId: string };

function validateDashComplianceOverview(
  query: Record<string, string>
): DashComplianceOverviewQuery | { message: string } {
  const orgId = query.orgId;
  if (!orgId || !UUID_REGEX.test(orgId)) {
    return { message: 'orgId must be a valid UUID' };
  }

  return { orgId };
}

type TrackEvent = {
  eventType: (typeof CLIENT_EVENT_TYPES)[number];
  occurredAt?: string;
  orgId?: string;
  courseId?: string;
  path?: string;
  referrerHost?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  locale?: string;
  props?: Record<string, string | number | boolean | null>;
};

type IngestBatch = { sessionId: string; events: TrackEvent[] };

function validateTrackEvent(raw: unknown): TrackEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const {
    eventType,
    occurredAt,
    orgId,
    courseId,
    path,
    referrerHost,
    utmSource,
    utmMedium,
    utmCampaign,
    locale,
    props
  } = raw as Record<string, unknown>;

  if (typeof eventType !== 'string' || !CLIENT_EVENT_TYPES.includes(eventType as (typeof CLIENT_EVENT_TYPES)[number])) {
    return null;
  }

  if (orgId !== undefined && (typeof orgId !== 'string' || !UUID_REGEX.test(orgId))) return null;
  if (courseId !== undefined && (typeof courseId !== 'string' || !UUID_REGEX.test(courseId))) return null;
  if (occurredAt !== undefined && typeof occurredAt !== 'string') return null;
  if (path !== undefined && (typeof path !== 'string' || path.length > 2048)) return null;
  if (referrerHost !== undefined && (typeof referrerHost !== 'string' || referrerHost.length > 255)) return null;
  if (utmSource !== undefined && (typeof utmSource !== 'string' || utmSource.length > 128)) return null;
  if (utmMedium !== undefined && (typeof utmMedium !== 'string' || utmMedium.length > 128)) return null;
  if (utmCampaign !== undefined && (typeof utmCampaign !== 'string' || utmCampaign.length > 128)) return null;
  if (locale !== undefined && (typeof locale !== 'string' || locale.length > 8)) return null;
  if (props !== undefined && (typeof props !== 'object' || props === null || Array.isArray(props))) return null;

  return {
    eventType: eventType as (typeof CLIENT_EVENT_TYPES)[number],
    occurredAt: occurredAt as string | undefined,
    orgId: orgId as string | undefined,
    courseId: courseId as string | undefined,
    path: path as string | undefined,
    referrerHost: referrerHost as string | undefined,
    utmSource: utmSource as string | undefined,
    utmMedium: utmMedium as string | undefined,
    utmCampaign: utmCampaign as string | undefined,
    locale: locale as string | undefined,
    props: props as Record<string, string | number | boolean | null> | undefined
  };
}

function validateIngestBatch(body: unknown): IngestBatch | { message: string } {
  if (typeof body !== 'object' || body === null) {
    return { message: 'Invalid request body' };
  }

  const { sessionId, events } = body as Record<string, unknown>;

  if (typeof sessionId !== 'string' || sessionId.length < 8 || sessionId.length > 128) {
    return { message: 'sessionId must be a string between 8 and 128 characters' };
  }

  if (!Array.isArray(events) || events.length < 1 || events.length > 50) {
    return { message: 'events must be an array of 1 to 50 items' };
  }

  const parsedEvents: TrackEvent[] = [];
  for (const rawEvent of events) {
    const parsed = validateTrackEvent(rawEvent);
    if (!parsed) {
      return { message: 'One or more events failed validation' };
    }
    parsedEvents.push(parsed);
  }

  return { sessionId, events: parsedEvents };
}

// ---------------------------------------------------------------------------
// Ported service logic (apps/api/src/services/dash.ts)
// ---------------------------------------------------------------------------

type OrganisationAnalytics = {
  totalCertificates: number;
  numberOfCourses: number;
  totalStudents: number;
  topCourses: Array<{
    id: string;
    title: string;
    enrollments: number;
    completion: number;
    certification: number;
  }>;
  recentCertifications: Array<{
    id: string;
    avatarUrl: string | null;
    name: string | null;
    courseId: string;
    course: string;
    date: string;
  }>;
};

class DashHandlerError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function loadOrganisationAnalyticsFromDatabase(orgId: string): Promise<OrganisationAnalytics> {
  const [stats, topCourses, recentCertificationRows, certificateCountRows] = await Promise.all([
    getDashOrgStats(orgId),
    getCourseStats(orgId),
    getRecentCertifications(orgId),
    getTotalCertificatesIssued(orgId)
  ]);

  return {
    totalCertificates: certificateCountRows[0]?.count ?? 0,
    numberOfCourses: stats?.[0]?.noOfCourses ?? 0,
    totalStudents: stats?.[0]?.enrolledStudents ?? 0,
    topCourses: topCourses.map((course) => ({
      id: course.courseId,
      title: course.courseTitle,
      enrollments: course.totalStudents,
      completion: course.completionPercentage,
      certification: course.certificationPercentage
    })),
    recentCertifications: recentCertificationRows.map((row) => ({
      id: row.profileId,
      avatarUrl: row.avatarUrl,
      name: row.fullname,
      courseId: row.courseId,
      course: row.courseTitle,
      date: row.earnedAt ?? ''
    }))
  };
}

async function getOrganisationAnalytics(
  orgId: string | undefined,
  siteName: string | undefined,
  bustCache: boolean
): Promise<OrganisationAnalytics> {
  let resolvedOrgId = orgId;

  if (!resolvedOrgId && siteName) {
    const [org] = await getOrgIdBySiteName(siteName);
    if (!org) {
      throw new DashHandlerError('Organization not found for the given site name', 404);
    }
    resolvedOrgId = org.id;
  }

  if (!resolvedOrgId) {
    throw new DashHandlerError('Organization not found', 404);
  }

  const { version, data: cached } = await readOrgStatsVersionAndCache<OrganisationAnalytics>(resolvedOrgId);

  if (!bustCache && cached) {
    return cached;
  }

  const analytics = await loadOrganisationAnalyticsFromDatabase(resolvedOrgId);
  await writeOrgStatsCache(resolvedOrgId, version, analytics);

  return analytics;
}

type StudentLoginActivityRow = { day: string; count: number };

function dashLoginActivityKey(orgId: string, days: number): string {
  return `dash:login-activity:v1:${orgId}:${days}`;
}

function parseLoginActivityCache(raw: string): StudentLoginActivityRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== 7) return null;

  const out: StudentLoginActivityRow[] = [];
  for (const item of parsed) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { day?: unknown }).day !== 'string' ||
      typeof (item as { count?: unknown }).count !== 'number' ||
      !Number.isInteger((item as { count: number }).count) ||
      (item as { count: number }).count < 0
    ) {
      return null;
    }
    out.push({ day: (item as { day: string }).day, count: (item as { count: number }).count });
  }

  for (const label of DAY_LABELS) {
    if (!out.some((r) => r.day === label)) return null;
  }

  return out;
}

async function getStudentLoginActivity(orgId: string, days: number): Promise<StudentLoginActivityRow[]> {
  const cacheKey = dashLoginActivityKey(orgId, days);

  if (env.REDIS_URL) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const rows = parseLoginActivityCache(cached);
        if (rows) return rows;
      }
    } catch (error) {
      logRedisUnavailableOnce('Redis get failed for login activity cache, using database', error);
    }
  }

  const rows = await getOrgStudentLoginsByDayOfWeek(orgId, days);
  const countByDow = new Map(rows.map((r) => [r.dayOfWeek, r.count]));
  const result = DAY_LABELS.map((label, index) => ({ day: label, count: countByDow.get(index) ?? 0 }));

  if (env.REDIS_URL) {
    try {
      await redis.setEx(cacheKey, LOGIN_ACTIVITY_CACHE_TTL_SECONDS, JSON.stringify(result));
    } catch (error) {
      logRedisUnavailableOnce('Redis set failed for login activity cache, continuing', error);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ported service logic (apps/api/src/services/analytics/reads.ts)
// ---------------------------------------------------------------------------

type LandingStats = {
  totals: {
    landingViews: number;
    coursePageViews: number;
    uniqueVisitors: number;
    enrollments: number;
    completions: number;
  };
  sparkline: Array<{ date: string; views: number; enrollments: number }>;
};

type CountryBreakdown = Array<{ country: string; views: number; enrollments: number }>;

type CourseFunnel = {
  steps: Array<{
    name: 'landing_view' | 'course_page_view' | 'enrollment_completed' | 'course_completed';
    count: number;
    conversionFromPrev: number | null;
  }>;
};

type PopularTypes = Array<{
  type: string;
  enrollments: number;
  views: number;
  completions: number;
  courseCount: number;
}>;

function dashAnalyticsKey(route: string, orgId: string, days: number, extra?: string): string {
  return `dash:analytics:${route}:${orgId}:${days}${extra ? `:${extra}` : ''}`;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeRange(days: number): { fromDate: string; toDate: string } {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { fromDate: toDateString(from), toDate: toDateString(today) };
}

async function readAnalyticsCache<T>(key: string): Promise<T | null> {
  if (!env.REDIS_URL) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    logRedisUnavailableOnce('Redis get failed for analytics cache, using database', error);
    return null;
  }
}

async function writeAnalyticsCache(key: string, value: unknown): Promise<void> {
  if (!env.REDIS_URL) return;
  try {
    await redis.setEx(key, DASH_ANALYTICS_TTL_SECONDS, JSON.stringify(value));
  } catch (error) {
    logRedisUnavailableOnce('Redis set failed for analytics cache, continuing', error);
  }
}

async function getLandingStats(orgId: string, days: number, bustCache: boolean): Promise<LandingStats> {
  const key = dashAnalyticsKey('landing', orgId, days);
  if (!bustCache) {
    const cached = await readAnalyticsCache<LandingStats>(key);
    if (cached) return cached;
  }

  const { fromDate, toDate } = computeRange(days);
  const rows = await selectOrgDailyRange(orgId, fromDate, toDate);

  const totals = rows.reduce(
    (acc, row) => ({
      landingViews: acc.landingViews + row.landingViews,
      coursePageViews: acc.coursePageViews + row.coursePageViews,
      uniqueVisitors: acc.uniqueVisitors + row.uniqueVisitors,
      enrollments: acc.enrollments + row.enrollments,
      completions: acc.completions + row.completions
    }),
    { landingViews: 0, coursePageViews: 0, uniqueVisitors: 0, enrollments: 0, completions: 0 }
  );

  const sparkline = rows.map((row) => ({
    date: row.date,
    views: row.landingViews + row.coursePageViews,
    enrollments: row.enrollments
  }));

  const result: LandingStats = { totals, sparkline };
  await writeAnalyticsCache(key, result);
  return result;
}

async function getCountryBreakdown(orgId: string, days: number, bustCache: boolean): Promise<CountryBreakdown> {
  const key = dashAnalyticsKey('country', orgId, days);
  if (!bustCache) {
    const cached = await readAnalyticsCache<CountryBreakdown>(key);
    if (cached) return cached;
  }

  const { fromDate, toDate } = computeRange(days);
  const rows = await selectCountryBreakdown(orgId, fromDate, toDate);
  const result: CountryBreakdown = rows.map((row) => ({
    country: row.country,
    views: row.views,
    enrollments: row.enrollments
  }));
  await writeAnalyticsCache(key, result);
  return result;
}

async function getCourseFunnel(
  orgId: string,
  days: number,
  courseId: string | undefined,
  bustCache: boolean
): Promise<CourseFunnel> {
  const key = dashAnalyticsKey('funnel', orgId, days, courseId);
  if (!bustCache) {
    const cached = await readAnalyticsCache<CourseFunnel>(key);
    if (cached) return cached;
  }

  const { fromDate, toDate } = computeRange(days);

  let landingViews = 0;
  let coursePageViews = 0;
  let enrollments = 0;
  let completions = 0;

  if (courseId) {
    const rows = await selectCourseDailyRange(courseId, orgId, fromDate, toDate);
    coursePageViews = rows.reduce((sum, r) => sum + r.views, 0);
    enrollments = rows.reduce((sum, r) => sum + r.enrollments, 0);
    completions = rows.reduce((sum, r) => sum + r.completions, 0);
  } else {
    const rows = await selectOrgDailyRange(orgId, fromDate, toDate);
    landingViews = rows.reduce((sum, r) => sum + r.landingViews, 0);
    coursePageViews = rows.reduce((sum, r) => sum + r.coursePageViews, 0);
    enrollments = rows.reduce((sum, r) => sum + r.enrollments, 0);
    completions = rows.reduce((sum, r) => sum + r.completions, 0);
  }

  const stepValues = [
    { name: 'landing_view' as const, count: landingViews },
    { name: 'course_page_view' as const, count: coursePageViews },
    { name: 'enrollment_completed' as const, count: enrollments },
    { name: 'course_completed' as const, count: completions }
  ];

  const steps = stepValues
    .filter((step) => (courseId ? step.name !== 'landing_view' : true))
    .map((step, index, arr) => {
      const prev = index > 0 ? arr[index - 1].count : null;
      const conversionFromPrev = prev && prev > 0 ? step.count / prev : null;
      return { ...step, conversionFromPrev };
    });

  const result: CourseFunnel = { steps };
  await writeAnalyticsCache(key, result);
  return result;
}

async function getPopularTypes(orgId: string, days: number, bustCache: boolean): Promise<PopularTypes> {
  const key = dashAnalyticsKey('popular-types', orgId, days);
  if (!bustCache) {
    const cached = await readAnalyticsCache<PopularTypes>(key);
    if (cached) return cached;
  }

  const { fromDate, toDate } = computeRange(days);
  const rows = await selectPopularCourseTypes(orgId, fromDate, toDate);
  const result: PopularTypes = rows
    .filter((row) => row.type)
    .map((row) => ({
      type: row.type as string,
      enrollments: row.enrollments,
      views: row.views,
      completions: row.completions,
      courseCount: row.courseCount
    }));
  await writeAnalyticsCache(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Ported service logic (apps/api/src/services/analytics/ingest.ts)
// ---------------------------------------------------------------------------

function deriveDeviceType(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/tablet|ipad/.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/.test(ua)) return 'mobile';
  if (/bot|crawler|spider|crawling/.test(ua)) return 'bot';
  return 'desktop';
}

function clampCountry(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length !== 2) return null;
  return trimmed;
}

async function ingestEventBatch(
  batch: IngestBatch,
  ctx: { country: string | null; userAgent: string | null; userId: string | null }
) {
  const occurredAtFallback = new Date().toISOString();
  const country = clampCountry(ctx.country);
  const deviceType = deriveDeviceType(ctx.userAgent);

  const rows = batch.events.map((event) => ({
    occurredAt: event.occurredAt ?? occurredAtFallback,
    sessionId: batch.sessionId,
    eventType: event.eventType,
    orgId: event.orgId ?? null,
    userId: ctx.userId,
    courseId: event.courseId ?? null,
    path: event.path ?? null,
    referrerHost: event.referrerHost ?? null,
    utmSource: event.utmSource ?? null,
    utmMedium: event.utmMedium ?? null,
    utmCampaign: event.utmCampaign ?? null,
    country,
    deviceType,
    locale: event.locale ?? null,
    props: (event.props ?? {}) as Record<string, unknown>
  }));

  const inserted = await insertPageEvents(rows);
  return { inserted };
}

// ---------------------------------------------------------------------------
// Ported service logic (apps/api/src/services/course/compliance.ts —
// getOrgComplianceOverview only)
// ---------------------------------------------------------------------------

type OrgComplianceStatus =
  | 'not_started'
  | 'in_progress'
  | 'compliant'
  | 'expiring_soon'
  | 'in_grace_period'
  | 'non_compliant'
  | 'waived'
  | 'no_record';

const STATUS_KEYS: OrgComplianceStatus[] = [
  'compliant',
  'expiring_soon',
  'in_grace_period',
  'non_compliant',
  'waived',
  'in_progress',
  'not_started',
  'no_record'
];

function emptyStatusCounts(): Record<OrgComplianceStatus, number> {
  const counts = {} as Record<OrgComplianceStatus, number>;
  for (const status of STATUS_KEYS) counts[status] = 0;
  return counts;
}

async function getOrgComplianceOverview(orgId: string) {
  const rows = await getOrgComplianceLearnerRows(orgId);

  const summaryCounts = emptyStatusCounts();
  const courseMap = new Map<
    string,
    { title: string; learnerCount: number; counts: Record<OrgComplianceStatus, number> }
  >();
  const uniqueLearners = new Set<string>();

  for (const row of rows) {
    const status = row.status as OrgComplianceStatus;
    summaryCounts[status] = (summaryCounts[status] ?? 0) + 1;
    if (row.profileId) uniqueLearners.add(row.profileId);

    let courseAcc = courseMap.get(row.courseId);
    if (!courseAcc) {
      courseAcc = { title: row.courseTitle, learnerCount: 0, counts: emptyStatusCounts() };
      courseMap.set(row.courseId, courseAcc);
    }
    courseAcc.learnerCount += 1;
    courseAcc.counts[status] = (courseAcc.counts[status] ?? 0) + 1;
  }

  return {
    summary: {
      totalLearners: uniqueLearners.size,
      totalCourses: courseMap.size,
      counts: summaryCounts
    },
    courses: Array.from(courseMap.entries()).map(([courseId, c]) => ({
      courseId,
      courseTitle: c.title,
      learnerCount: c.learnerCount,
      counts: c.counts
    })),
    learners: rows.map((row: OrgComplianceLearnerRow) => ({
      groupMemberId: row.groupMemberId,
      profileId: row.profileId,
      fullname: row.profile?.fullname ?? null,
      email: row.email,
      avatarUrl: row.profile?.avatarUrl ?? null,
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      status: row.status as OrgComplianceStatus,
      cycleNumber: row.cycleNumber,
      dueDate: row.dueDate,
      completedAt: row.completedAt,
      validUntil: row.validUntil
    }))
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /dash/track — public ingest, no auth. `userId` is best-effort: a
 * missing/invalid session does NOT reject the request, matching Hono's
 * `c.get('user')` (populated only when a session happens to be present,
 * with no auth middleware guarding this route at all).
 */
async function handleTrack(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateIngestBatch(body);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const userId = await getSessionUserId(event);

  try {
    const result = await ingestEventBatch(validation, {
      country: getHeaderCaseInsensitive(event, 'cf-ipcountry'),
      userAgent: getHeaderCaseInsensitive(event, 'user-agent'),
      userId
    });

    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] ingestEventBatch error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to ingest analytics events' });
  }
}

/**
 * GET /dash/stats — org member auth gate; orgId/siteName come from the
 * query string (Hono's own `orgMemberMiddleware` does not read the query,
 * only the `cio-org-id` header).
 */
async function handleStats(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashStats(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const result = await getOrganisationAnalytics(validation.orgId, validation.siteName, validation.bust);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    if (error instanceof DashHandlerError) {
      return jsonResponse(error.statusCode, { success: false, message: error.message });
    }
    console.error('[dash-handler] getOrganisationAnalytics error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load organisation analytics' });
  }
}

/**
 * GET /dash/login-activity — org admin auth gate.
 */
async function handleLoginActivity(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateLoginActivity(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  if (!validation.orgId) {
    // Hono's route calls getStudentLoginActivity(orgId!, days) — orgId is
    // required in practice even though the schema also allows siteName.
    return jsonResponse(400, { success: false, message: 'orgId is required' });
  }

  try {
    const result = await getStudentLoginActivity(validation.orgId, validation.days);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getStudentLoginActivity error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load login activity' });
  }
}

/**
 * GET /dash/login-streak — session only, no org check.
 */
async function handleLoginStreak(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const result = await getUserLoginStreak(userId);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getUserLoginStreak error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load login streak' });
  }
}

/**
 * GET /dash/landing-stats — org member auth gate.
 */
async function handleLandingStats(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashAnalyticsRange(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const bust = query.bust === '1';

  try {
    const result = await getLandingStats(validation.orgId, validation.days, bust);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getLandingStats error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load landing stats' });
  }
}

/**
 * GET /dash/country-breakdown — org member auth gate.
 */
async function handleCountryBreakdown(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashAnalyticsRange(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const bust = query.bust === '1';

  try {
    const result = await getCountryBreakdown(validation.orgId, validation.days, bust);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getCountryBreakdown error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load country breakdown' });
  }
}

/**
 * GET /dash/course-funnel — org member auth gate.
 */
async function handleCourseFunnel(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashCourseFunnel(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const bust = query.bust === '1';

  try {
    const result = await getCourseFunnel(validation.orgId, validation.days, validation.courseId, bust);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getCourseFunnel error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load course funnel' });
  }
}

/**
 * GET /dash/popular-types — org member auth gate.
 */
async function handlePopularTypes(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashAnalyticsRange(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const bust = query.bust === '1';

  try {
    const result = await getPopularTypes(validation.orgId, validation.days, bust);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getPopularTypes error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load popular course types' });
  }
}

/**
 * GET /dash/compliance-overview — org admin auth gate.
 */
async function handleComplianceOverview(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const validation = validateDashComplianceOverview(query as Record<string, string>);
  if ('message' in validation) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const result = await getOrgComplianceOverview(validation.orgId);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[dash-handler] getOrgComplianceOverview error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to load compliance overview' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/dash/track') && method === 'POST') {
    return handleTrack(event);
  }

  if (path.endsWith('/dash/stats') && method === 'GET') {
    return handleStats(event);
  }

  if (path.endsWith('/dash/login-activity') && method === 'GET') {
    return handleLoginActivity(event);
  }

  if (path.endsWith('/dash/login-streak') && method === 'GET') {
    return handleLoginStreak(event);
  }

  if (path.endsWith('/dash/landing-stats') && method === 'GET') {
    return handleLandingStats(event);
  }

  if (path.endsWith('/dash/country-breakdown') && method === 'GET') {
    return handleCountryBreakdown(event);
  }

  if (path.endsWith('/dash/course-funnel') && method === 'GET') {
    return handleCourseFunnel(event);
  }

  if (path.endsWith('/dash/popular-types') && method === 'GET') {
    return handlePopularTypes(event);
  }

  if (path.endsWith('/dash/compliance-overview') && method === 'GET') {
    return handleComplianceOverview(event);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
