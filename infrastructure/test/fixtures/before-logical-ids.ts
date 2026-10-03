/**
 * Committed before-template logical IDs (Phase 6).
 *
 * Extracted from the UNTOUCHED pre-refactor ApiStack template dumps captured in step 0
 * (see .agents/tasks/phase6-verification.md). The preservation test asserts these IDs still
 * exist after the refactor, proving no stateful/named resource was replaced.
 *
 * DO NOT hand-edit: regenerate from a fresh before-template if the baseline changes.
 */

export interface FunctionLogicalIds {
  /** AWS::Lambda::Function logical ID */
  fn: string;
  /** AWS::Logs::LogGroup logical ID (absent for email-worker, which imports its log group) */
  logGroup?: string;
  /** CfnOutput logical ID for the function ARN */
  outArn: string;
  /** CfnOutput logical ID for the function name */
  outName: string;
}

/** functionName (physical, incl. -<env>) -> its four path-derived logical IDs. */
export const BEFORE_FUNCTION_LOGICAL_IDS: Record<string, FunctionLogicalIds> = {
  'neon-test-dev': {
    fn: 'NeonTestFunction870477C4',
    logGroup: 'NeonTestFunctionLogGroup182C04AE',
    outArn: 'NeonTestFunctionFunctionArn05DEC2B0',
    outName: 'NeonTestFunctionFunctionName3B05EB8A'
  },
  'migration-router-dev': {
    fn: 'MigrationRouterFunction15DBBA3B',
    logGroup: 'MigrationRouterFunctionLogGroup1F8A3680',
    outArn: 'MigrationRouterFunctionFunctionArn83D2A298',
    outName: 'MigrationRouterFunctionFunctionNameFC7D2B22'
  },
  'email-worker-dev': {
    fn: 'EmailWorkerFunction9B506D58',
    outArn: 'EmailWorkerFunctionFunctionArn0B416CA5',
    outName: 'EmailWorkerFunctionFunctionName8D31ABB7'
  },
  'auth-handler-dev': {
    fn: 'AuthHandlerFunctionB0B8DBF0',
    logGroup: 'AuthHandlerFunctionLogGroup508DC236',
    outArn: 'AuthHandlerFunctionFunctionArn011782DA',
    outName: 'AuthHandlerFunctionFunctionName3BC4C3B8'
  },
  'account-profile-dev': {
    fn: 'AccountProfileFunction9ECAEF94',
    logGroup: 'AccountProfileFunctionLogGroupE26B9CAE',
    outArn: 'AccountProfileFunctionFunctionArn8EEE3335',
    outName: 'AccountProfileFunctionFunctionName3A81C4A5'
  },
  'account-handler-dev': {
    fn: 'AccountHandlerFunctionB6085004',
    logGroup: 'AccountHandlerFunctionLogGroup0B08631A',
    outArn: 'AccountHandlerFunctionFunctionArnAC38E4FB',
    outName: 'AccountHandlerFunctionFunctionName5861C3A0'
  },
  'course-listing-dev': {
    fn: 'CourseListingFunctionE83C4152',
    logGroup: 'CourseListingFunctionLogGroupA35208DA',
    outArn: 'CourseListingFunctionFunctionArn5CD8E2C9',
    outName: 'CourseListingFunctionFunctionName5408E6C9'
  },
  'course-details-dev': {
    fn: 'CourseDetailsFunction84D1B19A',
    logGroup: 'CourseDetailsFunctionLogGroupDDB478A0',
    outArn: 'CourseDetailsFunctionFunctionArn1572850E',
    outName: 'CourseDetailsFunctionFunctionName249A58EF'
  },
  'course-enrollment-dev': {
    fn: 'CourseEnrollmentFunction3DAF84FD',
    logGroup: 'CourseEnrollmentFunctionLogGroup933633F0',
    outArn: 'CourseEnrollmentFunctionFunctionArn5F251F4D',
    outName: 'CourseEnrollmentFunctionFunctionName132A91A6'
  },
  'course-mutation-handler-dev': {
    fn: 'CourseMutationHandlerFunction68D24051',
    logGroup: 'CourseMutationHandlerFunctionLogGroupB21CDF20',
    outArn: 'CourseMutationHandlerFunctionFunctionArnD983C3A6',
    outName: 'CourseMutationHandlerFunctionFunctionName2A4BCB81'
  },
  'lesson-listing-dev': {
    fn: 'LessonListingFunctionCB736929',
    logGroup: 'LessonListingFunctionLogGroupB44E05F7',
    outArn: 'LessonListingFunctionFunctionArn1991314C',
    outName: 'LessonListingFunctionFunctionName421A3F21'
  },
  'lesson-details-dev': {
    fn: 'LessonDetailsFunction0C7EB0FE',
    logGroup: 'LessonDetailsFunctionLogGroup264DE06C',
    outArn: 'LessonDetailsFunctionFunctionArn9CDEFE3B',
    outName: 'LessonDetailsFunctionFunctionName3503DB1B'
  },
  'lesson-progress-dev': {
    fn: 'LessonProgressFunction7359DCA8',
    logGroup: 'LessonProgressFunctionLogGroup7AB5B58B',
    outArn: 'LessonProgressFunctionFunctionArn2BDB6939',
    outName: 'LessonProgressFunctionFunctionNameD672AB9C'
  },
  'video-url-generator-dev': {
    fn: 'VideoUrlGeneratorFunction875DD2DC',
    logGroup: 'VideoUrlGeneratorFunctionLogGroup1B6B64E3',
    outArn: 'VideoUrlGeneratorFunctionFunctionArn30A1CD24',
    outName: 'VideoUrlGeneratorFunctionFunctionName0BAAEBE9'
  },
  'organization-handler-dev': {
    fn: 'OrganizationHandlerFunction40F1123E',
    logGroup: 'OrganizationHandlerFunctionLogGroup31B404B4',
    outArn: 'OrganizationHandlerFunctionFunctionArn60A5BE29',
    outName: 'OrganizationHandlerFunctionFunctionNameAAAD8C6D'
  },
  'organization-courses-handler-dev': {
    fn: 'OrganizationCoursesHandlerFunction26B71036',
    logGroup: 'OrganizationCoursesHandlerFunctionLogGroup9EFA51A5',
    outArn: 'OrganizationCoursesHandlerFunctionFunctionArn165E1E2E',
    outName: 'OrganizationCoursesHandlerFunctionFunctionName42F509CC'
  },
  'organization-setup-handler-dev': {
    fn: 'OrganizationSetupHandlerFunction3134A1AE',
    logGroup: 'OrganizationSetupHandlerFunctionLogGroup350BAF44',
    outArn: 'OrganizationSetupHandlerFunctionFunctionArnFBE22E4C',
    outName: 'OrganizationSetupHandlerFunctionFunctionName6036FD54'
  },
  'organization-team-handler-dev': {
    fn: 'OrganizationTeamHandlerFunction6BC71065',
    logGroup: 'OrganizationTeamHandlerFunctionLogGroup885D6AB5',
    outArn: 'OrganizationTeamHandlerFunctionFunctionArn41AB2FBC',
    outName: 'OrganizationTeamHandlerFunctionFunctionName4CD417DB'
  },
  'organization-audience-handler-dev': {
    fn: 'OrganizationAudienceHandlerFunctionA284B600',
    logGroup: 'OrganizationAudienceHandlerFunctionLogGroup377CD325',
    outArn: 'OrganizationAudienceHandlerFunctionFunctionArn681FD2B9',
    outName: 'OrganizationAudienceHandlerFunctionFunctionName7BF10A90'
  },
  'organization-mutation-handler-dev': {
    fn: 'OrganizationMutationHandlerFunctionD769B055',
    logGroup: 'OrganizationMutationHandlerFunctionLogGroup2AACB32D',
    outArn: 'OrganizationMutationHandlerFunctionFunctionArnF71AEAAD',
    outName: 'OrganizationMutationHandlerFunctionFunctionName9AE17B7C'
  },
  'dash-handler-dev': {
    fn: 'DashHandlerFunctionBD82B735',
    logGroup: 'DashHandlerFunctionLogGroup7C66910F',
    outArn: 'DashHandlerFunctionFunctionArnDCF25973',
    outName: 'DashHandlerFunctionFunctionName27FC0FDF'
  },
  'onboarding-handler-dev': {
    fn: 'OnboardingHandlerFunction22F4201B',
    logGroup: 'OnboardingHandlerFunctionLogGroup6A3956E1',
    outArn: 'OnboardingHandlerFunctionFunctionArn043CFB13',
    outName: 'OnboardingHandlerFunctionFunctionName1986A628'
  },
  'domain-handler-dev': {
    fn: 'DomainHandlerFunction454ECEBE',
    logGroup: 'DomainHandlerFunctionLogGroupB6C9ABEB',
    outArn: 'DomainHandlerFunctionFunctionArn71F6A491',
    outName: 'DomainHandlerFunctionFunctionNameA4581E2F'
  },
  'course-section-handler-dev': {
    fn: 'CourseSectionHandlerFunctionC2EBECDD',
    logGroup: 'CourseSectionHandlerFunctionLogGroup622D5F0E',
    outArn: 'CourseSectionHandlerFunctionFunctionArn07D7AE9C',
    outName: 'CourseSectionHandlerFunctionFunctionName15F2CBBE'
  },
  'course-content-handler-dev': {
    fn: 'CourseContentHandlerFunction949C6E2F',
    logGroup: 'CourseContentHandlerFunctionLogGroup245D49EF',
    outArn: 'CourseContentHandlerFunctionFunctionArn786BE25E',
    outName: 'CourseContentHandlerFunctionFunctionName7E21199E'
  },
  'course-mark-handler-dev': {
    fn: 'CourseMarkHandlerFunctionBF1ABB5C',
    logGroup: 'CourseMarkHandlerFunctionLogGroup0C929036',
    outArn: 'CourseMarkHandlerFunctionFunctionArnAA959DAD',
    outName: 'CourseMarkHandlerFunctionFunctionNameA7258AB6'
  },
  'course-attendance-handler-dev': {
    fn: 'CourseAttendanceHandlerFunction996614DC',
    logGroup: 'CourseAttendanceHandlerFunctionLogGroup42901844',
    outArn: 'CourseAttendanceHandlerFunctionFunctionArn8E5ABBDD',
    outName: 'CourseAttendanceHandlerFunctionFunctionName0D819EC7'
  },
  'course-compliance-handler-dev': {
    fn: 'CourseComplianceHandlerFunction5DAD2057',
    logGroup: 'CourseComplianceHandlerFunctionLogGroupF1D68BDD',
    outArn: 'CourseComplianceHandlerFunctionFunctionArnF603ED54',
    outName: 'CourseComplianceHandlerFunctionFunctionName47469037'
  },
  'course-newsfeed-handler-dev': {
    fn: 'CourseNewsfeedHandlerFunction2659DB84',
    logGroup: 'CourseNewsfeedHandlerFunctionLogGroupF69147D3',
    outArn: 'CourseNewsfeedHandlerFunctionFunctionArn7CBE6AA0',
    outName: 'CourseNewsfeedHandlerFunctionFunctionName4D46276A'
  },
  'course-presign-handler-dev': {
    fn: 'CoursePresignHandlerFunctionC2644E4F',
    logGroup: 'CoursePresignHandlerFunctionLogGroupF6B949B5',
    outArn: 'CoursePresignHandlerFunctionFunctionArn3AC347F8',
    outName: 'CoursePresignHandlerFunctionFunctionName3061A0ED'
  },
  'course-payment-request-handler-dev': {
    fn: 'CoursePaymentRequestHandlerFunction35F474B8',
    logGroup: 'CoursePaymentRequestHandlerFunctionLogGroup3681BF6E',
    outArn: 'CoursePaymentRequestHandlerFunctionFunctionArn5426AF7A',
    outName: 'CoursePaymentRequestHandlerFunctionFunctionName079A0C71'
  },
  'course-utility-handler-dev': {
    fn: 'CourseUtilityHandlerFunction026C81E8',
    logGroup: 'CourseUtilityHandlerFunctionLogGroupF7AFCA1F',
    outArn: 'CourseUtilityHandlerFunctionFunctionArnDAE572F4',
    outName: 'CourseUtilityHandlerFunctionFunctionNameA101D06E'
  },
  'course-people-handler-dev': {
    fn: 'CoursePeopleHandlerFunction20405448',
    logGroup: 'CoursePeopleHandlerFunctionLogGroupBABED660',
    outArn: 'CoursePeopleHandlerFunctionFunctionArn423D7103',
    outName: 'CoursePeopleHandlerFunctionFunctionNameCF5CE10E'
  },
  'course-invite-handler-dev': {
    fn: 'CourseInviteHandlerFunction592133F3',
    logGroup: 'CourseInviteHandlerFunctionLogGroup3C1B33CC',
    outArn: 'CourseInviteHandlerFunctionFunctionArnDD2BBACD',
    outName: 'CourseInviteHandlerFunctionFunctionName5CB9C723'
  },
  'lesson-extended-handler-dev': {
    fn: 'LessonExtendedHandlerFunction44979136',
    logGroup: 'LessonExtendedHandlerFunctionLogGroupB563BB7A',
    outArn: 'LessonExtendedHandlerFunctionFunctionArnF7DA9056',
    outName: 'LessonExtendedHandlerFunctionFunctionName8515DA41'
  },
  'lesson-mutation-handler-dev': {
    fn: 'LessonMutationHandlerFunctionE3CFB182',
    logGroup: 'LessonMutationHandlerFunctionLogGroupD027FB75',
    outArn: 'LessonMutationHandlerFunctionFunctionArn479651B1',
    outName: 'LessonMutationHandlerFunctionFunctionName0367D945'
  },
  'invite-handler-dev': {
    fn: 'InviteHandlerFunctionAF633673',
    logGroup: 'InviteHandlerFunctionLogGroup4BC887B6',
    outArn: 'InviteHandlerFunctionFunctionArnDDE713DB',
    outName: 'InviteHandlerFunctionFunctionNameD10ED017'
  },
  'course-exercise-handler-dev': {
    fn: 'CourseExerciseHandlerFunctionB5BF4425',
    logGroup: 'CourseExerciseHandlerFunctionLogGroup03C0C6E5',
    outArn: 'CourseExerciseHandlerFunctionFunctionArnDFB0F21D',
    outName: 'CourseExerciseHandlerFunctionFunctionNameC36B0B41'
  },
  'course-submission-handler-dev': {
    fn: 'CourseSubmissionHandlerFunctionDEDD7348',
    logGroup: 'CourseSubmissionHandlerFunctionLogGroup2B6B6B8F',
    outArn: 'CourseSubmissionHandlerFunctionFunctionArnC8130941',
    outName: 'CourseSubmissionHandlerFunctionFunctionNameB6104C28'
  }
};

/** Logical IDs of the non-function resources that must be preserved. */
export const BEFORE_NAMED_LOGICAL_IDS = {
  httpApi: 'HttpApiF5A9A8A7',
  stage: 'HttpApiDefaultStage3EEB07D6',
  sesConfigSet: 'SesConfigurationSet4DAFC9AF',
  sesEventDest: 'SesConfigurationSetBounceComplaintToCloudWatch89B01788',
  emailWorkerEventSource: 'EmailWorkerFunctionSqsEventSourceQEmailQueueBE677BB647563A13',
  sesDomainIdentity: 'SesDomainIdentity9A66B56D'
} as const;
