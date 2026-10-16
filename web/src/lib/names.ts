// How the organiser shows people: Dan's admin account as "Dan (Admin)", and
// everyone who isn't an admin as "Name (Host)". Only for display: the stored
// name (used in emails and the diary) is unchanged.

export const ADMIN_EMAIL = 'dan@atechstudio.co.uk';

export function shownName(p: { display_name: string | null; email: string; role: 'host' | 'staff' | 'admin' }): string {
  if (p.role === 'admin') return p.email.toLowerCase() === ADMIN_EMAIL ? 'Dan (Admin)' : (p.display_name ?? p.email);
  return `${p.display_name ?? p.email} (Host)`;
}
