import { initPosthog, type PosthogBootstrapUser } from '$lib/utils/services/posthog';
import { initUmami } from '$lib/utils/services/umami';
import { initUserJot } from '$lib/utils/services/userjot';

export function setupExternalTracking(user?: PosthogBootstrapUser): void {
  initPosthog(user);
  initUmami();
  initUserJot();
}
