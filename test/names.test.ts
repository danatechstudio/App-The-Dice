import { describe, expect, it } from 'vitest';
import { shownName } from '../web/src/lib/names';

describe('names in the organiser', () => {
  it("always shows Dan's admin account as Dan (Admin)", () => {
    expect(shownName({ display_name: 'Daniel', email: 'Dan@AtechStudio.co.uk', role: 'admin' })).toBe('Dan (Admin)');
    expect(shownName({ display_name: null, email: 'dan@atechstudio.co.uk', role: 'admin' })).toBe('Dan (Admin)');
  });

  it('shows everyone who is not an admin as a host', () => {
    expect(shownName({ display_name: 'Sam', email: 'sam@example.com', role: 'host' })).toBe('Sam (Host)');
    expect(shownName({ display_name: 'Michelle', email: 'michelle@example.com', role: 'staff' })).toBe('Michelle (Host)');
    expect(shownName({ display_name: null, email: 'sam@example.com', role: 'host' })).toBe('sam@example.com (Host)');
  });

  it('leaves any other admin as they are', () => {
    expect(shownName({ display_name: 'Pat', email: 'pat@example.com', role: 'admin' })).toBe('Pat');
  });
});
