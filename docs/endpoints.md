# API endpoint coverage

This variant migrates the ClassroomIO backend to AWS serverless **one route
group at a time**. Each migrated group is deployed as a native AWS Lambda behind
an Amazon API Gateway HTTP API. Routes that are not yet migrated return a clean
`404` from API Gateway rather than misbehaving.

This document reflects what is deployed as a native Lambda. The AWS API Gateway
HTTP API is the source of truth; see `infrastructure/lib/stacks/api-stack.ts`
and the handlers under `infrastructure/src/lambda/`.

Legend: ✅ migrated · ⬜ not yet migrated · 📌 intentionally out of scope

---

## ✅ Migrated (native Lambda + API Gateway route)

### Platform / health
| Route | Methods |
|---|---|
| `/health` | GET |
| `/api/auth/{proxy+}` | GET, POST, PUT, PATCH, DELETE |

### Account
| Route | Methods |
|---|---|
| `/account` | GET |
| `/account/profile` | GET, PUT |

### Organization — core
| Route | Methods |
|---|---|
| `/organization` | GET, POST, PUT |
| `/organization/first` | GET |
| `/organization/setup` | GET |
| `/organization/auto-join` | POST |
| `/organization/plan`, `/organization/plan/cancel` | POST, PUT |

### Organization — team & audience
| Route | Methods |
|---|---|
| `/organization/team`, `/organization/team/invite`, `/organization/team/{memberId}` | GET, POST, DELETE |
| `/organization/link-invite` | GET, POST, PATCH |
| `/organization/audience` | GET |
| `/organization/audience/{memberId}` | DELETE |
| `/organization/audience/resend-invite`, `/revoke-invite`, `/import`, `/assign-courses` | POST |
| `/organization/audience/{userId}/analytics` | GET |

### Organization — courses listing
| Route | Methods |
|---|---|
| `/organization/courses`, `/courses/public`, `/courses/enrolled`, `/courses/recommended` | GET |

### Onboarding
| Route | Methods |
|---|---|
| `/onboarding/create-org`, `/update-metadata`, `/complete` | POST |

### Dashboard analytics
| Route | Methods |
|---|---|
| `/dash/stats`, `/login-activity`, `/login-streak`, `/landing-stats`, `/country-breakdown`, `/course-funnel`, `/popular-types`, `/compliance-overview` | GET |
| `/dash/track` | POST |

### Domain
| Route | Methods |
|---|---|
| `/domain` | POST |

### Course — core & content
| Route | Methods |
|---|---|
| `/course` | GET, POST |
| `/course/{id}` | GET |
| `/course/{courseId}` | PUT, DELETE |
| `/course/{courseId}/clone` | POST |
| `/course/{id}/enroll` | POST |
| `/course/{courseId}/section*` (base, `reorder`, `promote-ungrouped`, `{sectionId}`) | GET-less: POST, PUT, DELETE |
| `/course/{courseId}/content`, `/content/reorder` | PUT, DELETE |

### Course — lessons
| Route | Methods |
|---|---|
| `/course/{id}/lessons` | GET |
| `/course/{courseId}/lesson`, `/lesson/reorder` | GET, POST |
| `/course/{courseId}/lesson/{lessonId}` | GET, PUT, DELETE |
| `/lesson/{lessonId}/comment`, `/comment/{commentId}` | GET, POST, PUT, DELETE |
| `/lesson/{lessonId}/completion`, `/watch-progress`, `/history` | GET, PUT |
| `/lesson/{lessonId}/language`, `/language/{locale}` | GET, POST, PUT |
| `/lesson/{id}` (standalone), `/lesson/{id}/progress`, `/lesson/{id}/video-url` | GET, POST |

### Course — exercises & submissions
| Route | Methods |
|---|---|
| `/course/{courseId}/exercise`, `/exercise/{exerciseId}` | GET, POST, PUT, DELETE |
| `/exercise/from-template`, `/exercise/template*` | GET, POST |
| `/exercise/{exerciseId}/submission`, `/submissions` | GET, POST |
| `/exercise/{exerciseId}/notify`, `/notify/{jobId}` | GET, POST |
| `/exercise/{exerciseId}/.../video-recording/upload/init`, `/complete`, `/playback` | GET, POST |
| `/course/{courseId}/submission/for-grading`, `/{submissionId}`, `/answer`, `/grades` | GET, PUT, DELETE |

### Course — grading, attendance, compliance
| Route | Methods |
|---|---|
| `/course/{courseId}/mark`, `/mark/gradebook` | GET |
| `/course/{courseId}/attendance` | POST |
| `/course/{courseId}/compliance`, `/learners/{profileId}` | GET |
| `/compliance/reset`, `/extend`, `/waive` | POST |

### Course — members, newsfeed, invites, misc
| Route | Methods |
|---|---|
| `/course/{courseId}/members`, `/{memberId}`, `/{memberId}/reset-progress`, `/{userId}/analytics` | GET, POST, PUT, DELETE |
| `/course/{courseId}/newsfeed`, `/{feedId}`, `/comment`, `/comments`, `/comment/{commentId}`, `/react` | GET, POST, PUT, DELETE |
| `/course/{courseId}/invites`, `/{inviteId}/audit`, `/{inviteId}/revoke` | GET, POST |
| `/course/{courseId}/payment-request` | POST |
| `/course/presign/{proxy+}` | POST |
| `/course/{courseId}/download/{proxy+}`, `/lesson/{lessonId}/download/{proxy+}` | POST |
| `/course/katex` | GET |

### Invites (root)
| Route | Methods |
|---|---|
| `/invite/organization/{token}/preview`, `/accept`, `/{inviteId}/accept-by-id`, `/pending` | GET, POST |
| `/invite/link/{token}/preview`, `/accept` | GET, POST |

---

## ⬜ Not yet migrated

These route groups still have no native Lambda. They are candidates for future
work; until then they are not served by the AWS deployment.

| Group | Notes |
|---|---|
| `cohort/*` | Cohort CRUD, membership, goals, newsfeed |
| `community/*` | Community posts/comments |
| `media/image` | Image upload |
| `organization/tags*`, `quiz*`, `search*` | Tag groups, quiz CRUD, org search |
| `organization/member/email-notifications` | Member self-service setting |
| `agent/*` (non-streaming) | status, usage, history, runs, generate-text, summarize |
| `organization/sso*`, `token-auth*`, `sso/discover` | SSO & token-auth config |
| `organization/ai-tutor`, course-level `ai-tutor` | Confirm streaming before porting |
| `organization/widgets*`, public `widgets/*` | Embeddable widget config & data |
| `organization/automation*` | Automation-key management |
| `transcripts/*`, `mail/*`, `unsplash/*`, `org-site/*` | Transcripts, mail webhook, image search, public org site |
| `hls/*` | Verify CloudFront/R2 coverage before building |
| `jobs/*` (read endpoints) | Media job status reads |

---

## 📌 Intentionally out of scope

Not planned as a native Lambda in this variant, by design.

| Group | Reason |
|---|---|
| `agent/chat` (streaming) | Needs AWS Lambda response streaming via a Function URL; tracked as separate follow-up |
| `jobs` enqueue (`transcribe`, `regenerate-thumbnail`) | Require an SQS queue + worker, outside the route-per-Lambda scope |
| `organization/course-import/*` | Automation-key auth, consumed only by the MCP server |
| `public-api/v1/*` | Separate automation-key auth, Redis-backed rate limiting, and OpenAPI surface |
