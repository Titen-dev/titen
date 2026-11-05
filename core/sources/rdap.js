import { fetchJSON } from '../http.js';

/** Registration date + age of a domain via RDAP (free, no key). Returns null fields when unknown. */
export async function domainAge(domain, { signal } = {}) {
  try {
    const data = await fetchJSON(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal,
      timeoutMs: 12_000,
      accept: 'application/rdap+json, application/json',
    });
    const reg = (data.events || []).find((e) => e.eventAction === 'registration')?.eventDate;
    const registered = reg ? new Date(reg) : null;
    const registrar = (data.entities || [])
      .find((e) => (e.roles || []).includes('registrar'))
      ?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3];
    return {
      registeredAt: registered && !isNaN(registered) ? registered.toISOString() : null,
      ageDays: registered && !isNaN(registered) ? Math.floor((Date.now() - registered.getTime()) / 86_400_000) : null,
      registrar: registrar || null,
      found: true,
    };
  } catch {
    // Not found / TLD without RDAP / network error: report unknown rather than failing the scam check.
    return { registeredAt: null, ageDays: null, registrar: null, found: false };
  }
}
