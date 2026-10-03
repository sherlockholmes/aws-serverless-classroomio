import { env } from '../config/env';

export const EMAIL_IDS = [
  'forgotPassword',
  'inviteTeacher',
  'newsfeedComment',
  'newsfeedPost',
  'onPasswordReset',
  'cohortGoalReminder',
  'quizAssigned',
  'sessionReminder',
  'sessionUpdated',
  'submissionGraded',
  'submissionReceived',
  'studentLimitReached',
  'studentLimitApproaching',
  'studentCourseInvite',
  'studentCourseCompletion',
  'studentCourseWelcome',
  'studentOrgInvite',
  'studentCohortWelcome',
  'studentProvePayment',
  'teacherCourseWelcome',
  'teacherStudentBuyRequest',
  'teacherStudentJoined',
  'verifyEmail',
  'welcome'
] as const;

/**
 * Default sender/reply-to addresses.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Requirement 1.5: THE Default_From_Address SHALL be a
 * @example.com address, replacing the previous
 * notify@mail.classroomio.com default (an upstream ClassroomIO SaaS
 * domain never verified in this deployment's SES account -- sending from
 * it fails with "Email address is not verified").
 * Requirement 1.6: THE Default_Reply_To_Address SHALL likewise be a
 * @example.com address, replacing help@classroomio.com.
 *
 * `notify@example.com`/`help@example.com` are covered by
 * the verified `example.com` domain identity (see
 * infrastructure/lib/stacks/api-stack.ts's SesDomainIdentity) -- SES
 * authorizes sends from ANY address under a verified domain identity, no
 * separate per-address verification needed for the sender side.
 */
const DEFAULT_EMAIL_FROM = '"ClassroomIO" <notify@example.com>';

export const EMAIL_FROM = env.SMTP_SENDER || DEFAULT_EMAIL_FROM;
export const EMAIL_REPLY_TO = '"ClassroomIO" <help@example.com>';
