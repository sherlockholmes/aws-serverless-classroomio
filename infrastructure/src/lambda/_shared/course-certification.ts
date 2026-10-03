import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { env } from '@cio/core/config/env';
import {
  exerciseBelongsToCourse,
  getCourseCertificationRow,
  getCourseProgress,
  getExerciseTitleAndMaxPoints,
  getProfileByGroupMemberId,
  getStudentSubmissionsForExercise,
  isExerciseCompletedForMember,
  claimMemberCertificateEarned,
  setMemberCertificationEmailSent
} from '@cio/db/queries/course';
import { getProfileById } from '@cio/db/queries/auth';
import { getActiveOrganizationPlan } from '@cio/db/queries/organization';
import { PLAN } from '@cio/utils/plans';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import { enqueueTemplateEmail } from './email-enqueue';

type CertificationBlocker = {
  code:
    | 'CERT_PROGRESS'
    | 'CERT_DEADLINE_PASSED'
    | 'CERT_NO_CONTENT'
    | 'CERT_FINAL_EXERCISE_NOT_SUBMITTED'
    | 'CERT_FINAL_EXERCISE_PENDING_GRADE'
    | 'CERT_FINAL_EXERCISE_SCORE'
    | 'CERT_FINAL_EXERCISE_MISCONFIGURED';
  params?: Record<string, string | number>;
};

export type CourseCompletionEvaluation = {
  progressPercent: number;
  certificationThreshold: number;
  meetsThreshold: boolean;
  eligibleForCertificate: boolean;
  certificateEarnedAt: string | null;
  blockers: CertificationBlocker[];
  meetsFinalExerciseRule: boolean;
  isNewCompletion: boolean;
};

function calculateProgressPercent(progress: {
  lessonsCompleted: number;
  lessonsCount: number;
  exercisesCompleted: number;
  exercisesCount: number;
}): number {
  const totalItems = progress.lessonsCount + progress.exercisesCount;
  if (totalItems === 0) return 0;

  return Math.round(((progress.lessonsCompleted + progress.exercisesCompleted) / totalItems) * 100);
}

function isBeforeOrEqualDeadline(deadline: string | null | undefined): boolean {
  if (!deadline) return true;

  const deadlineDate = new Date(deadline);
  return Number.isNaN(deadlineDate.getTime()) || Date.now() <= deadlineDate.getTime();
}

async function evaluateFinalExerciseRule(params: {
  courseId: string;
  requiredExerciseId: string | null | undefined;
  minScorePercent: number | null | undefined;
  groupMemberId: string | null;
}): Promise<{ meetsFinalExerciseRule: boolean; blockers: CertificationBlocker[] }> {
  const { courseId, requiredExerciseId, minScorePercent, groupMemberId } = params;
  if (!requiredExerciseId) return { meetsFinalExerciseRule: true, blockers: [] };

  if (!(await exerciseBelongsToCourse(requiredExerciseId, courseId))) {
    return { meetsFinalExerciseRule: true, blockers: [] };
  }

  const requiredPercent = minScorePercent ?? 100;
  if (!groupMemberId) {
    return { meetsFinalExerciseRule: false, blockers: [{ code: 'CERT_FINAL_EXERCISE_NOT_SUBMITTED' }] };
  }

  const { title: exerciseTitle, maxPoints } = await getExerciseTitleAndMaxPoints(requiredExerciseId);
  if (maxPoints <= 0) {
    return {
      meetsFinalExerciseRule: false,
      blockers: [{ code: 'CERT_FINAL_EXERCISE_MISCONFIGURED', params: { exerciseTitle } }]
    };
  }

  const submissions = await getStudentSubmissionsForExercise(groupMemberId, requiredExerciseId);
  if (submissions.length === 0) {
    return {
      meetsFinalExerciseRule: false,
      blockers: [{ code: 'CERT_FINAL_EXERCISE_NOT_SUBMITTED', params: { exerciseTitle } }]
    };
  }

  const completed = submissions.filter((submission) => submission.gradingState === 'completed');
  if (completed.length === 0) {
    return {
      meetsFinalExerciseRule: false,
      blockers: [{ code: 'CERT_FINAL_EXERCISE_PENDING_GRADE', params: { exerciseTitle } }]
    };
  }

  const bestPercent = Math.max(
    ...completed.map((submission) => Math.round((Number(submission.total ?? 0) / maxPoints) * 100))
  );
  if (bestPercent < requiredPercent) {
    return {
      meetsFinalExerciseRule: false,
      blockers: [{ code: 'CERT_FINAL_EXERCISE_SCORE', params: { exerciseTitle, bestPercent, requiredPercent } }]
    };
  }

  return { meetsFinalExerciseRule: true, blockers: [] };
}

async function certificatesEnabled(orgId: string): Promise<boolean> {
  if (env.PUBLIC_IS_SELFHOSTED === 'true') return true;

  const activePlan = await getActiveOrganizationPlan(orgId);
  return Boolean(activePlan && activePlan.planName !== PLAN.BASIC);
}

async function sendCompletionEmail(params: {
  courseId: string;
  profileId: string;
  groupMemberId: string;
  courseRow: NonNullable<Awaited<ReturnType<typeof getCourseCertificationRow>>>;
  earnedAt: string;
}): Promise<void> {
  const profile = await getProfileById(params.profileId);
  if (!profile?.email) return;

  const certificateUrl = `${getDashboardBaseUrl({
    siteName: params.courseRow.orgSiteName,
    customDomain: params.courseRow.orgCustomDomain,
    isCustomDomainVerified: params.courseRow.orgIsCustomDomainVerified
  })}/courses/${params.courseId}/certificates`;

  const messageId = await enqueueTemplateEmail({
    kind: 'template',
    template: 'studentCourseCompletion',
    to: profile.email,
    fields: {
      orgName: params.courseRow.orgName,
      courseName: params.courseRow.title,
      studentName: profile.fullname || profile.email,
      certificateUrl,
      customMessage: params.courseRow.certificate?.emailMessage ?? null,
      branding: buildEmailBranding({
        name: params.courseRow.orgName,
        avatarUrl: params.courseRow.orgAvatarUrl,
        theme: params.courseRow.orgTheme
      })
    },
    from: buildEmailFromName(`${params.courseRow.orgName} (via ClassroomIO.com)`)
  });

  if (messageId) {
    await setMemberCertificationEmailSent(params.groupMemberId, new Date().toISOString());
  }
}

export async function evaluateCourseCertification(
  courseId: string,
  profileId: string
): Promise<CourseCompletionEvaluation> {
  const [progress, courseRow] = await Promise.all([
    getCourseProgress(courseId, profileId),
    getCourseCertificationRow(courseId)
  ]);

  if (!courseRow) throw new Error('Course not found');

  const certificate = courseRow.certificate ?? {};
  const progressPercent = calculateProgressPercent(progress);
  const meetsThreshold = progressPercent >= (certificate.threshold ?? 100);
  const withinDeadline = isBeforeOrEqualDeadline(certificate.deadline);
  const hasContent = progress.lessonsCount + progress.exercisesCount > 0;
  const blockers: CertificationBlocker[] = [];

  if (!withinDeadline) blockers.push({ code: 'CERT_DEADLINE_PASSED' });
  if (!meetsThreshold) {
    blockers.push({
      code: 'CERT_PROGRESS',
      params: { current: progressPercent, required: certificate.threshold ?? 100 }
    });
  }
  if (!hasContent) blockers.push({ code: 'CERT_NO_CONTENT' });

  const finalEvaluation = await evaluateFinalExerciseRule({
    courseId,
    requiredExerciseId: certificate.requiredExerciseId,
    minScorePercent:
      certificate.exerciseMinScorePercent ??
      (courseRow.type === 'COMPLIANCE' ? courseRow.compliance?.passingScore : null),
    groupMemberId: progress.groupMemberId
  });
  blockers.push(...finalEvaluation.blockers);

  const eligibleForCertificate = Boolean(
    progress.groupMemberId && meetsThreshold && hasContent && withinDeadline && finalEvaluation.meetsFinalExerciseRule
  );
  let certificateEarnedAt = progress.certificateEarnedAt;
  let isNewCompletion = false;

  if (
    eligibleForCertificate &&
    !certificateEarnedAt &&
    progress.groupMemberId &&
    (await certificatesEnabled(courseRow.orgId))
  ) {
    const earnedAt = new Date().toISOString();
    if (await claimMemberCertificateEarned(progress.groupMemberId, earnedAt)) {
      certificateEarnedAt = earnedAt;
      isNewCompletion = true;
      void sendCompletionEmail({
        courseId,
        profileId,
        groupMemberId: progress.groupMemberId,
        courseRow,
        earnedAt
      }).catch((error) => console.error('[course-certification] completion email failed:', error));
    }
  }

  return {
    progressPercent,
    certificationThreshold: certificate.threshold ?? 100,
    meetsThreshold,
    eligibleForCertificate,
    certificateEarnedAt,
    blockers,
    meetsFinalExerciseRule: finalEvaluation.meetsFinalExerciseRule,
    isNewCompletion
  };
}

export async function triggerCertificationIfExerciseComplete(
  courseId: string,
  exerciseId: string,
  groupMemberId: string
): Promise<void> {
  const profile = await getProfileByGroupMemberId(groupMemberId);
  if (!profile?.id || !(await isExerciseCompletedForMember(exerciseId, groupMemberId))) return;

  void evaluateCourseCertification(courseId, profile.id).catch((error) => {
    console.error('[course-certification] exercise evaluation failed:', error);
  });
}
