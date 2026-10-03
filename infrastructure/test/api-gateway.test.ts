import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi } from './helpers';

/**
 * API Gateway (HTTP API) assertions: the API itself, CORS/corsPreflight, stage
 * throttling, the health route, representative domain routes, and a total
 * route-count regression guard.
 */
describe('ApiStack — API Gateway HTTP API', () => {
  let t: Template;

  beforeAll(async () => {
    ({ t } = await synthApi({}));
  });

  it('creates exactly one HTTP API named dev-classroomio-api with the expected CORS config', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'dev-classroomio-api',
      CorsConfiguration: {
        AllowCredentials: true,
        AllowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        AllowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Api-Key'],
        AllowOrigins: ['http://localhost:5173']
      }
    });
  });

  it('configures default-stage throttling (burst 5000 / rate 2000)', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: {
        ThrottlingBurstLimit: 5000,
        ThrottlingRateLimit: 2000
      }
    });
  });

  it('registers the health route and a representative set of domain routes', () => {
    const routeKeys = [
      'GET /health',
      'GET /course',
      'POST /course',
      'GET /course/{id}',
      'GET /lesson/{id}',
      'GET /course/{courseId}/lesson/{lessonId}',
      'PUT /course/{courseId}/lesson/{lessonId}',
      'POST /course/{courseId}/exercise/{exerciseId}/submission',
      'POST /organization/plan/cancel',
      'GET /organization/courses/public'
    ];

    for (const key of routeKeys) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: key });
    }
  });

  it('registers all five methods for the Better Auth catch-all route', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: `${method} /api/auth/{proxy+}`,
        Target: Match.anyValue()
      });
    }
  });

  it('route-count regression guard: 146 routes total (matches the before-template)', () => {
    // N read from the before-template; an accidentally-dropped or added route
    // flips this count and fails loudly.
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 146);
  });
});
