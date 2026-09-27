export type CalendarProviderName = 'apple' | 'google' | 'microsoft' | 'caldav';
export type CalendarAuthorization =
  | 'unauthorized'
  | 'authorization_required'
  | 'read_only'
  | 'authorized'
  | 'provider_unavailable'
  | 'provider_error';

export interface Calendar {
  id: string;
  name: string;
  readOnly: boolean;
}

export interface CalendarSelection {
  provider: CalendarProviderName;
  calendarIds: string[];
  /** The calendar used for writes when more than one writable calendar is selected. */
  writeCalendarId?: string;
  updatedAt: Date;
}

export interface CalendarSelectionStore {
  get(userId: string, provider: CalendarProviderName): Promise<CalendarSelection | null>;
  save(userId: string, selection: CalendarSelection): Promise<void>;
}

export class InMemoryCalendarSelectionStore implements CalendarSelectionStore {
  private readonly selections = new Map<string, CalendarSelection>();

  async get(userId: string, provider: CalendarProviderName): Promise<CalendarSelection | null> {
    const selection = this.selections.get(`${userId}:${provider}`);
    return selection ? structuredClone(selection) : null;
  }

  async save(userId: string, selection: CalendarSelection): Promise<void> {
    this.selections.set(`${userId}:${selection.provider}`, structuredClone(selection));
  }
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  authorization(): Promise<CalendarAuthorization>;
  listCalendars(): Promise<Calendar[]>;
  getAvailability(calendarIds: string[], startsAt: Date, endsAt: Date): Promise<CalendarEvent[]>;
  listEvents(calendarId: string, startsAt: Date, endsAt: Date): Promise<CalendarEvent[]>;
  createEvent(event: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent>;
  updateEvent(event: CalendarEvent): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export class CalendarCapability {
  constructor(private readonly provider: CalendarProvider) {}

  get name(): CalendarProviderName {
    return this.provider.name;
  }

  authorization(): Promise<CalendarAuthorization> {
    return this.provider.authorization();
  }

  async authorizationStatus(): Promise<{
    state: CalendarAuthorization;
    action: 'allow_access' | 'open_settings' | 'reconnect' | 'retry' | null;
  }> {
    const state = await this.provider.authorization();
    const action = state === 'unauthorized' ? 'open_settings'
      : state === 'authorization_required' ? 'allow_access'
        : state === 'provider_unavailable' || state === 'provider_error' ? 'retry'
          : null;
    return { state, action };
  }

  listCalendars(): Promise<Calendar[]> {
    return this.provider.listCalendars();
  }

  getAvailability(calendarIds: string[], startsAt: Date, endsAt: Date): Promise<CalendarEvent[]> {
    return this.provider.getAvailability(calendarIds, startsAt, endsAt);
  }

  async createEvent(event: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent> {
    const authorization = await this.provider.authorization();
    if (authorization !== 'authorized') {
      throw new Error(`Calendar write not authorized (${authorization})`);
    }
    return this.provider.createEvent(event);
  }

  async updateEvent(event: CalendarEvent): Promise<CalendarEvent> {
    const authorization = await this.provider.authorization();
    if (authorization !== 'authorized') {
      throw new Error(`Calendar write not authorized (${authorization})`);
    }
    return this.provider.updateEvent(event);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const authorization = await this.provider.authorization();
    if (authorization !== 'authorized') {
      throw new Error(`Calendar write not authorized (${authorization})`);
    }
    await this.provider.deleteEvent(calendarId, eventId);
  }
}

export class CalendarSelectionService {
  constructor(private readonly store: CalendarSelectionStore, private readonly now: () => number = Date.now) {}

  async get(userId: string, provider: CalendarProviderName): Promise<CalendarSelection | null> {
    return this.store.get(userId, provider);
  }

  async save(
    userId: string,
    provider: CalendarProviderName,
    calendars: Calendar[],
    calendarIds: string[],
    writeCalendarId?: string,
  ): Promise<CalendarSelection> {
    const available = new Map(calendars.map((calendar) => [calendar.id, calendar]));
    const selected = [...new Set(calendarIds)].filter((id) => available.has(id));
    if (writeCalendarId && (!selected.includes(writeCalendarId) || available.get(writeCalendarId)?.readOnly)) {
      throw new Error('The write calendar must be selected and writable');
    }
    const writable = selected.filter((id) => !available.get(id)!.readOnly);
    const selection: CalendarSelection = {
      provider,
      calendarIds: selected,
      ...(writeCalendarId ? { writeCalendarId } : writable.length === 1 ? { writeCalendarId: writable[0] } : {}),
      updatedAt: new Date(this.now()),
    };
    await this.store.save(userId, selection);
    return selection;
  }

  async ready(userId: string, provider: CalendarProviderName): Promise<boolean> {
    return Boolean((await this.store.get(userId, provider))?.calendarIds.length);
  }
}
