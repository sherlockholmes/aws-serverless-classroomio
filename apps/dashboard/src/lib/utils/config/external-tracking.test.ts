import { isExternalTrackingEnabled } from './external-tracking';

describe('isExternalTrackingEnabled', () => {
  it('enables external tracking only for the exact string true', () => {
    expect(isExternalTrackingEnabled('true')).toBe(true);
  });

  it.each([undefined, '', 'false', 'TRUE', ' true ', '1'])('disables external tracking for %p', (value) => {
    expect(isExternalTrackingEnabled(value)).toBe(false);
  });
});
