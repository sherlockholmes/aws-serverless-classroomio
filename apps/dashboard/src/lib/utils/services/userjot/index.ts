import * as publicEnv from '$env/static/public';
import { isExternalTrackingEnabled } from '$lib/utils/config/external-tracking';

const USERJOT_APP_ID = 'cm4a6vcmp00jpmdb5n66rmkzz';
const externalTrackingEnabled = isExternalTrackingEnabled(publicEnv.PUBLIC_ENABLE_EXTERNAL_TRACKING);

let isInitialized = false;

export function isUserJotEnabled(): boolean {
  return externalTrackingEnabled;
}

function ensureSdkLoaded(): void {
  if (window.uj) {
    return;
  }

  window.$ujq = window.$ujq || [];
  window.uj =
    window.uj ||
    (new Proxy({} as Window['uj'], {
      get:
        (_, prop) =>
        (...args: unknown[]) =>
          window.$ujq.push([prop, ...args])
    }) as Window['uj']);

  const script = document.createElement('script');
  script.type = 'module';
  script.async = true;
  script.src = 'https://cdn.userjot.com/sdk/v2/uj.js';
  // Browsers hide the nonce attribute in the DOM; read via the IDL property.
  const nonceSource = document.querySelector('script[nonce]') as HTMLScriptElement | null;
  const nonce = nonceSource?.nonce || nonceSource?.getAttribute('nonce');
  if (nonce) script.setAttribute('nonce', nonce);
  document.head.appendChild(script);
}

export function initUserJot(): void {
  if (isInitialized) {
    return;
  }

  if (!isUserJotEnabled()) {
    return;
  }

  ensureSdkLoaded();

  window.uj.init(USERJOT_APP_ID, {
    trigger: 'custom',
    position: 'right',
    theme: 'auto'
  });

  isInitialized = true;
}

type UserJotIdentity = {
  id: string;
  email?: string;
  fullname?: string | null;
  avatarUrl?: string | null;
};

export function identifyUserJotUser({ id, email, fullname, avatarUrl }: UserJotIdentity): void {
  if (!isUserJotEnabled()) {
    return;
  }

  ensureSdkLoaded();

  const [firstName, ...rest] = (fullname ?? '').trim().split(/\s+/);
  const lastName = rest.join(' ');

  window.uj.identify({
    id,
    email,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    avatar: avatarUrl ?? undefined
  });
}

export function clearUserJotUser(): void {
  if (!isUserJotEnabled()) {
    return;
  }

  ensureSdkLoaded();

  window.uj.identify(null);
}

export type UserJotWidgetSection = 'feedback' | 'roadmap' | 'updates';

export function showUserJotWidget(section: UserJotWidgetSection): void {
  if (!isUserJotEnabled()) {
    return;
  }

  ensureSdkLoaded();

  window.uj.showWidget({ section });
}
