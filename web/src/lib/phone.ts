import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function parseAndNormalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const phone = parsePhoneNumberFromString(raw);
  if (!phone || !phone.isValid()) return null;
  const e164 = phone.format('E.164');
  if (!e164.startsWith('+')) return null;
  return e164;
}
