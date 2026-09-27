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
