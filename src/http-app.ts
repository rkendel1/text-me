import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toDataURL } from 'qrcode';
import {
  DEFAULT_AUTH_SKIP_ROUTES,
  handleAuthProxyRequest,
  processAuthMiddleware,
} from '@neondatabase/auth/server';

import { HttpError } from './errors.js';
import { presentConversation, presentConversationSummary } from './http/presenters.js';
import type { Conversation } from './domain/conversation.js';
import { openOwnerRequest } from './domain/owner-requests.js';
import type { ConversationRepository } from './repositories/conversation-repository.js';
import { ConversationService } from './services/conversation-service.js';
import { FakeTelephonyProvider } from './telephony/fake-provider.js';
import type { IncomingCall, ProviderResponse, TelephonyProvider } from './telephony/provider.js';
import { TwilioProvider } from './telephony/twilio-provider.js';
import { FakeConversationModel } from './conversation/fake-model.js';
import type { ConversationModel } from './conversation/model.js';
import { ConversationEngine } from './services/conversation-engine.js';
import { FakeSpeechProvider } from './speech/fake-provider.js';
import type { SpeechProvider } from './speech/provider.js';
import { FakeVoiceProvider } from './voice/fake-provider.js';
import type { VoiceProvider } from './voice/provider.js';
import { AccountMessenger, type MessagingProvider } from './messaging/provider.js';
import { FakeMessagingProvider } from './messaging/fake-provider.js';
import type { OwnerChannel } from './owner/channel.js';
import { OwnerDeviceService, pairingQrPayload } from './owner/device.js';
import type { MessagesCapabilities } from './owner/mac-messages-adapter.js';
import type { MacMessagesAdapter } from './owner/mac-messages-adapter.js';
import { ConfigurationConflictError, OwnerConfigurationService, type OwnerConfigurationPatch } from './owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, type OwnerMessageDeliveryStore } from './owner/delivery.js';
import { InProcessConversationRuntimeController, type ConversationRuntimeController } from './runtime/controller.js';
import { RuntimeControlService, type RuntimeConfigurationPatch } from './runtime/service.js';
import {
  InMemoryConversationRuntimeEventStore,
  InMemoryConversationRuntimeStore,
  InMemoryRuntimeOverrideStore,
  type ConversationRuntimeEventStore,
  type ConversationRuntimeStore,
  type RuntimeOverrideStore,
} from './runtime/store.js';
import twilio from 'twilio';
import type { RuntimeEventBus } from './runtime/event-bus.js';
import { runtimeIdFor, type RuntimeCommand, type RuntimeCommandStore } from './runtime/commands.js';
import { OwnerAttentionService } from './attention/service.js';
import { FakePhoneNumberClient, PhoneNumberService, type PhoneNumberClient } from './telephony/phone-number.js';
import { attentionUrl, createSurfaceDeviceId, type OwnerDeviceCapability } from './attention/model.js';
import { NotificationRouter } from './attention/router.js';
import { MacMessagesSurface, OwnerSmsSurface, VapidPushSender, WebPushSurface, type PushSender } from './attention/surfaces.js';
import {
  InMemoryAppSecretStore,
  InMemoryNotificationDeliveryStore,
  InMemoryOwnerAttentionStore,
  InMemoryOwnerSurfaceDeviceStore,
  type AppSecretStore,
  type NotificationDeliveryStore,
  type OwnerAttentionStore,
  type OwnerSurfaceDeviceStore,
} from './attention/stores.js';
import { realtimeVoiceStatus, type RealtimeVoiceService } from './voice/realtime/realtime-voice.js';
import { buildInstructions, outboundGreeting } from './voice/realtime/session-config.js';
import { OwnerReplyService } from './services/owner-reply.js';
import type { ApnsSender } from './attention/apns.js';
import { AuthService, InMemoryAuthSessionStore, type AuthSession, type AuthSessionStore } from './auth/sessions.js';
import { InMemoryTenancyStore, type TenancyStore } from './tenancy/store.js';
import { TenancyService } from './tenancy/service.js';
import { NotificationChannelResolver } from './tenancy/channels.js';
import { assertJobOwnership, authorize, type TenantAction, type TenantContext } from './tenancy/authorization.js';
import { checkout, portal, verifyWebhook, type StripeBilling } from './billing/stripe.js';
import { createCallApplication } from './appport/call-application.js';
import { CallCapabilityClient } from './appport/call-client.js';
import { appPortSessionFor } from './appport/session.js';
import { isTerminal } from './calls/model.js';
import { DefaultOutboundPolicy, type OutboundPolicy } from './calls/outbound-policy.js';
import { FakeCallProvider, type CallProvider } from './calls/provider.js';
import { CallSessionService } from './calls/service.js';
import { InMemoryCallSessionStore, type CallSessionStore } from './calls/store.js';

export interface AppOptions {
  repository: ConversationRepository;
  providers?: TelephonyProvider[];
  includeFakeProviderRoutes?: boolean;
  speechProvider?: SpeechProvider;
  conversationModel?: ConversationModel;
  voiceProvider?: VoiceProvider;
  /** Platform SMS provider; every message is sent from the sending account's own assistant line. */
  messagingProvider?: MessagingProvider;
  twilioAuthToken?: string;
  /** Accounts, users, memberships, phone numbers, planes: the tenancy model. */
  tenancyStore?: TenancyStore;
  ownerChannel?: OwnerChannel;
  ownerDeviceService?: OwnerDeviceService;
  ownerMessagesAdapter?: MacMessagesAdapter;
  ownerConfigurationService?: OwnerConfigurationService;
  ownerDeliveryStore?: OwnerMessageDeliveryStore;
  qrCodeDataUrl?: (content: string) => Promise<string>;
  runtimeStore?: ConversationRuntimeStore;
  runtimeEventStore?: ConversationRuntimeEventStore;
  runtimeOverrideStore?: RuntimeOverrideStore;
  runtimeController?: ConversationRuntimeController;
  runtimeControlService?: RuntimeControlService;
  runtimeEventBus?: RuntimeEventBus;
  runtimeCommandStore?: RuntimeCommandStore;
  attentionStore?: OwnerAttentionStore;
  notificationDeliveryStore?: NotificationDeliveryStore;
  surfaceDeviceStore?: OwnerSurfaceDeviceStore;
  appSecretStore?: AppSecretStore;
  pushSender?: PushSender;
  /** Durable CallSessions: the canonical record of every call, inbound or outbound. */
  callSessionStore?: CallSessionStore;
  /** Places and ends calls at the telephony provider (Twilio in production). */
  callProvider?: CallProvider;
  /** Let agents place outbound calls through `call.create`. Off unless a deployment turns it on. */
  outboundAgentCalls?: boolean;
  /** Authenticates Vercel Cron (`Authorization: Bearer <CRON_SECRET>`). Unset: the cron routes refuse every request. */
  cronSecret?: string;
  /** Bounds for reconciling outbound dials whose outcome was never learned. Enabled unless turned off. */
  callReconciliation?: { enabled?: boolean; batchSize?: number; graceMs?: number; maxAttempts?: number; retryIntervalMs?: number };
  /** Replaces the default outbound policy (tests, or a stricter deployment). */
  outboundPolicy?: OutboundPolicy;
  /** Account phone numbers (assistant lines and verified personal numbers). */
  phoneNumbers?: PhoneNumberService;
  /** The platform's number provider, when `phoneNumbers` isn't given (tests and local development use a fake pool). */
  phoneNumberClient?: PhoneNumberClient;
  /** Let accounts buy a new assistant line when the platform pool is empty. */
  allowNumberPurchase?: boolean;
  /** Public origin put in pairing QR codes so the Mac bridge needs no server address typed in. */
  publicBaseUrl?: string;
  /** Answers phone calls with a realtime voice agent through the AI Gateway. */
  realtimeVoice?: RealtimeVoiceService;
  /** Resolved before any request is handled (e.g. lazy database setup on a cold start). */
  beforeRequest?: Promise<void> | (() => Promise<void>);
  /** Let the assistant answer caller texts itself (production, with the AI SDK text agent). */
  autoReplyToCallerTexts?: boolean;
  /** User sign-in sessions (web and iOS share them). */
  authSessionStore?: AuthSessionStore;
  /** Managed Neon Auth (Google/Apple); omitted in local/test environments that use password auth only. */
  neonAuth?: { baseUrl: string; cookieSecret: string };
  /**
   * Production composition: every authoritative store and the AI model must be
   * supplied, and fake provider routes must be off. Missing pieces fail startup
   * instead of silently falling back to in-memory or fake implementations.
   */
  production?: boolean;
  /** Native iOS notifications (APNs). Without it, iOS app registrations are refused. */
  apnsSender?: ApnsSender;
  /** Apple Team ID, for the app-site-association file that lets links open the iOS app. */
  appleTeamId?: string;
  /** Readiness probe for /health/ready (e.g. a database round trip). */
  healthCheck?: () => Promise<void>;
  /** Shown by /health: which build is running. */
  release?: { environment: string; commit?: string };
  /** One explicit temporary test account that may activate without Stripe. */
  billingBypassAccountId?: string;
  stripe?: StripeBilling;
}

/** What production must be given explicitly; the in-memory defaults exist only for tests and local demos. */
const PRODUCTION_REQUIREMENTS: Array<[keyof AppOptions, string]> = [
  ['runtimeStore', 'runtime state store'],
  ['runtimeEventStore', 'runtime event store'],
  ['runtimeOverrideStore', 'runtime override store'],
  ['runtimeCommandStore', 'runtime command store'],
  ['callSessionStore', 'call session store'],
  ['callProvider', 'call provider'],
  ['runtimeEventBus', 'cross-instance event bus'],
  ['attentionStore', 'owner attention store'],
  ['notificationDeliveryStore', 'notification delivery store'],
  ['surfaceDeviceStore', 'notification device store'],
  ['ownerDeviceService', 'owner device service'],
  ['ownerConfigurationService', 'owner configuration service'],
  ['ownerDeliveryStore', 'owner delivery store'],
  ['authSessionStore', 'sign-in session store'],
  ['tenancyStore', 'account store'],
  ['phoneNumbers', 'phone number service'],
  ['messagingProvider', 'SMS provider'],
  ['conversationModel', 'AI text model'],
  ['realtimeVoice', 'realtime voice agent'],
  ['pushSender', 'push sender'],
  ['twilioAuthToken', 'TWILIO_AUTH_TOKEN'],
];

export function assertProductionComposition(options: AppOptions): void {
  const missing = PRODUCTION_REQUIREMENTS.filter(([key]) => !options[key]).map(([, label]) => label);
  if (options.includeFakeProviderRoutes !== false) missing.push('fake provider routes must be disabled');
  if ((options.providers ?? []).some((provider) => provider.name === 'fake')) missing.push('the fake telephony provider must not be registered');
  if (missing.length) {
    throw new Error(`Refusing to start in production without: ${missing.join(', ')}`);
  }
}

function createProviderMap(
  providers: TelephonyProvider[],
): Map<string, TelephonyProvider> {
  return new Map(providers.map((provider) => [provider.name, provider]));
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.header('Authorization') ?? '';
  if (authorization.slice(0, 6).toLowerCase() !== 'bearer' || authorization[6]?.trim() !== '') return undefined;
  return authorization.slice(7).trim() || undefined;
}

/** Callers who reach a number that isn't any account's active line hear this; no conversation is created. */
function notInService(): string {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('The number you have called is not in service.');
  twiml.hangup();
  return twiml.toString();
}

/** Turn an owner's control-plane shortcut into words that make sense to the caller. */
function ownerVoiceReply(ownerName: string, instruction: string): string {
  const name = ownerName.trim() || 'the account owner';
  if (/another time/i.test(instruction)) {
    return `${name} asked me to find another time. What other day and time would work for you?`;
  }
  if (/call (?:them|you) back/i.test(instruction)) {
    return `${name} will call you back. Is the number you're calling from the best number to use?`;
  }
  return `${name} says: ${instruction}`;
}

/** The id that ties a request's log lines together: Vercel's, else the caller's, else none. */
function requestTraceId(request: Request): string | undefined {
  return request.header('x-vercel-id') ?? request.header('x-request-id') ?? undefined;
}

/** Records (or resolves) the CallSession for a call arriving at a line. Returns null, and logs, if it cannot. */
async function openCallSession(
  calls: CallSessionService,
  providerName: string,
  accountId: string,
  incoming: IncomingCall,
  conversationId: string,
  traceId?: string,
) {
  try {
    const outbound = incoming.direction === 'outbound';
    return await calls.openProviderCall({
      accountId,
      provider: providerName,
      providerCallId: incoming.providerCallId,
      direction: incoming.direction ?? 'inbound',
      // For a call the application placed (the owner test call) the webhook's caller/called roles are swapped.
      from: outbound ? incoming.calledNumber : incoming.callerPhone,
      to: outbound ? incoming.callerPhone : incoming.calledNumber,
      conversationId,
      traceId,
    });
  } catch (error) {
    console.error('[call] could not record call session', JSON.stringify({
      providerCallId: incoming.providerCallId, conversationId, traceId: traceId ?? null,
      error: error instanceof Error ? error.message : 'unknown',
    }));
    return null;
  }
}

function registerIncomingCallRoute(
  app: express.Express,
  path: string,
  provider: TelephonyProvider,
  service: ConversationService,
  configuration: OwnerConfigurationService,
  phoneNumbers: PhoneNumberService,
  calls: CallSessionService,
  transform?: (request: Request, call: IncomingCall) => IncomingCall | Promise<IncomingCall>,
  reject?: (request: Request) => ProviderResponse | undefined | Promise<ProviderResponse | undefined>,
  /** The call was placed by the application for an agent: the owner's "answer incoming calls" setting and the inbound greeting do not apply. */
  agentOutbound = false,
): void {
  app.post(path, async (request, response, next) => {
    try {
      const rejected = await reject?.(request);
      if (rejected) {
        response.status(200).type(rejected.contentType).send(rejected.body);
        return;
      }
      const parsed = provider.parseIncomingCall(request.body);
      const incomingCall = transform ? await transform(request, parsed) : parsed;
      // The called number is the only thing that says whose call this is. Unknown line: fail closed.
      const line = incomingCall.calledNumber ? await phoneNumbers.resolveLine(incomingCall.calledNumber) : null;
      if (!line) {
        console.warn('[webhook] call to a number no account owns', JSON.stringify({ provider: provider.name }));
        response.status(200).type('text/xml; charset=utf-8').send(notInService());
        return;
      }
      const conversation = await service.incomingCall(incomingCall, line.accountId);
      const traceId = requestTraceId(request);
      // A call we placed carries our own id in the URL we gave the provider. If our request to create the call never
      // came back, this is what ties the provider's call to its session.
      const hint = typeof request.query.callId === 'string' ? request.query.callId : '';
      if (hint) await calls.adoptDialedCall(hint, incomingCall.providerCallId).catch(() => null);
      // The durable CallSession is the record of this call; a failure to keep it must never drop the call itself.
      const callSession = await openCallSession(calls, provider.name, line.accountId, incomingCall, conversation.id, traceId);
      // Callers dialed the owner's real number; their carrier forwarded the call here.
      const forwardedFrom = typeof incomingCall.payload.ForwardedFrom === 'string' ? incomingCall.payload.ForwardedFrom : '';
      if (forwardedFrom && !conversation.events.some((event) => event.type === 'call.forwarded')) {
        await service.recordEvent(conversation.id, 'call.forwarded', { from: forwardedFrom });
      }
      const settings = await configuration.get(conversation.accountId);
      if (!settings.calls.answerCalls && !agentOutbound) {
        // "Answer incoming calls" is off: no assistant. Take a voicemail if allowed, else ask them to text.
        const twiml = new twilio.twiml.VoiceResponse();
        const owner = settings.assistant.ownerName || 'The person you called';
        if (settings.calls.voicemailFallback) {
          twiml.say(`${owner} can't take your call right now. Please leave a message after the tone.`);
          twiml.record({
            maxLength: 120, playBeep: true, trim: 'trim-silence', method: 'POST',
            action: `/webhooks/twilio/voicemail?conversationId=${encodeURIComponent(conversation.id)}`,
          });
        } else {
          twiml.say(`${owner} can't take calls right now. Please send a text message instead.`);
        }
        twiml.hangup();
        await service.answerCall(conversation.id, incomingCall.payload);
        await calls.transition(callSession?.id ?? '', 'answered', { mode: 'lenient' }).catch(() => undefined);
        await service.recordEvent(conversation.id, 'call.declined', { voicemail: settings.calls.voicemailFallback });
        response.status(200).type('text/xml; charset=utf-8').send(twiml.toString());
        return;
      }
      const providerResponse = provider.answerCall(conversation, {
        greeting: agentOutbound ? outboundGreeting(settings.assistant.ownerName) : settings.assistant.greeting,
        ...(callSession ? { callSessionId: callSession.id } : {}),
      });
      await service.answerCall(conversation.id, incomingCall.payload);
      if (callSession) await calls.transition(callSession.id, 'answered', { mode: 'lenient' }).catch(() => undefined);
      if (providerResponse.spokenGreeting && !conversation.events.some((event) =>
        event.type === 'ai.response' && event.payload.callbackId === `${conversation.providerCallId}:greeting`)) {
        await service.recordEvent(conversation.id, 'ai.response', {
          callbackId: `${conversation.providerCallId}:greeting`,
          speaker: 'assistant',
          text: providerResponse.spokenGreeting,
          source: 'telephony_tts',
          sequence: 0,
        });
      }
      // Passive by default: the owner is only interrupted if they opted in to call-start notifications.
      await service.raiseAttention(conversation.id, {
        type: 'conversation_started',
        title: (name) => agentOutbound ? `Your assistant is calling ${name}` : `${name} is calling`,
        body: agentOutbound ? 'An outbound call is in progress' : 'Your assistant is answering',
        dedupeKey: `started:${conversation.id}`,
      });
      response
        .status(200)
        .type(providerResponse.contentType)
        .send(providerResponse.body);
    } catch (error) {
      next(error);
    }
  });
}

function registerStatusRoute(
  app: express.Express,
  path: string,
  provider: TelephonyProvider,
  service: ConversationService,
  calls: CallSessionService,
): void {
  app.post(path, async (request, response, next) => {
    try {
      const update = provider.parseStatusUpdate(request.body);
      const traceId = requestTraceId(request);
      let session = await calls.findByProviderCall(update.providerCallId, update.provider);
      // A callback that beat our own record of the provider's id: the `callId` in the URL we gave the provider says whose it is.
      const hint = typeof request.query.callId === 'string' ? request.query.callId : '';
      if (!session && hint) session = await calls.adoptDialedCall(hint, update.providerCallId).catch(() => null);
      const conversation = await service.findByProviderCall(update.provider, update.providerCallId);
      // A call that predates CallSessions, or whose first callback beat its own registration.
      if (!session && conversation) session = await calls.adoptConversation(conversation).catch(() => null);

      if (!session) {
        if (!conversation) {
          // Early lifecycle events of a call still being registered are expected; anything else is an unknown call.
          if (update.status === 'initiating' || update.status === 'ringing') {
            response.status(200).json({ ignored: 'unknown_call' });
            return;
          }
          throw new HttpError(404, 'Conversation not found for provider call');
        }
        // No CallSession could be kept for it: keep the conversation correct as before.
        const fallback = update.status === 'answered' ? 'answered' : update.status && isTerminal(update.status) ? 'completed' : null;
        const updated = fallback
          ? await service.updateCallStatus({ provider: update.provider, providerCallId: update.providerCallId, lifecycle: fallback, durationSeconds: update.durationSeconds, payload: update.payload })
          : conversation;
        response.status(200).json(presentConversation(updated));
        return;
      }

      const { outcome } = await calls.applyProviderEvent({
        provider: update.provider,
        providerCallId: update.providerCallId,
        eventId: update.eventId,
        rawStatus: update.rawStatus,
        status: update.status,
        sequence: update.sequence,
        providerTimestamp: update.providerTimestamp,
        traceId,
      });
      const current = conversation ?? (session.conversationId ? await service.getConversation(session.conversationId) : null);

      if (outcome === 'rejected') throw new HttpError(409, `Invalid call status transition to ${update.rawStatus}`);
      // A call the application placed has no conversation until the callee answers and the provider asks for instructions.
      if (!current) {
        response.status(200).json({ callId: session.id, outcome });
        return;
      }
      // Redelivered, late, already applied, or not a status the domain models: acknowledged, and nothing happens twice.
      if (outcome !== 'applied' || !update.status) {
        response.status(200).json(presentConversation(current));
        return;
      }

      // The owner-facing conversation follows the CallSession lifecycle.
      let projected = current;
      if (update.status === 'answered') {
        projected = await service.updateCallStatus({ provider: update.provider, providerCallId: update.providerCallId, lifecycle: 'answered', durationSeconds: update.durationSeconds, payload: update.payload });
      } else if (isTerminal(update.status)) {
        projected = await service.updateCallStatus({ provider: update.provider, providerCallId: update.providerCallId, lifecycle: 'completed', durationSeconds: update.durationSeconds, payload: update.payload });
        await service.resolveAttention(projected.id, ['conversation_started'], 'call ended');
        if (update.status === 'completed') {
          await service.raiseAttention(projected.id, {
            type: 'conversation_completed',
            title: (name) => `${name.split(' ')[0]}'s ${projected.state === 'text_active' ? 'call' : 'conversation'} is complete`,
            body: projected.state === 'text_active' ? 'The conversation continues by text' : 'Handled by your assistant',
            dedupeKey: `completed:${projected.id}`,
          });
        }
      }
      response.status(200).json(presentConversation(projected));
    } catch (error) {
      next(error);
    }
  });
}

function presentRuntime(
  runtime: Awaited<ReturnType<RuntimeControlService['getRuntimeForConversation']>>,
  conversation?: Conversation,
) {
  // The spec's owner-facing vocabulary; `state` keeps the fine-grained activity.
  const status = runtime.state === 'stopped' ? 'ended'
    : runtime.state === 'paused' ? 'paused'
      : runtime.aiMode === 'owner_only' ? 'takeover'
        : runtime.state === 'waiting_for_owner' || (conversation && openOwnerRequest(conversation)) ? 'owner_needed'
          : runtime.state === 'text_active' ? 'text_active'
            : runtime.state === 'idle' || runtime.state === 'starting' ? 'idle' : 'active';
  return {
    ...runtime,
    status,
    runtimeId: runtimeIdFor(runtime.conversationId),
    mode: runtime.aiMode === 'owner_assist' ? 'ask_owner' : runtime.aiMode,
    overriddenFields: runtime.overriddenFields ?? [],
    temporarySettings: (runtime.overriddenFields ?? []).length > 0,
    revision: runtime.configurationRevision,
    startedAt: runtime.startedAt?.toISOString() ?? null,
    pausedAt: runtime.pausedAt?.toISOString() ?? null,
    stoppedAt: runtime.stoppedAt?.toISOString() ?? null,
    updatedAt: runtime.updatedAt.toISOString(),
    interaction: {
      enabled: runtime.assistantEnabled,
      mode: runtime.aiMode,
      responseStyle: runtime.responseStyle,
      verbosity: runtime.verbosity,
      askOwnerWhen: runtime.askOwnerWhen,
      allowCommitments: runtime.allowCommitments,
      allowScheduling: runtime.allowScheduling,
      allowCallerFollowups: runtime.allowCallerFollowups,
      customInstructions: runtime.customInstructions,
    },
  };
}

export function createApp(options: AppOptions): express.Express {
  if (options.production) assertProductionComposition(options);
  const ensureReady = (): Promise<void> => typeof options.beforeRequest === 'function'
    ? options.beforeRequest()
    : options.beforeRequest ?? Promise.resolve();
  const app = express();
  // Vercel places one proxy in front of the app and forwards the client IP.
  // This is required for express-rate-limit to safely use X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use((request, response, next) => {
    const startedAt = Date.now();
    const requestId = request.header('x-vercel-id') ?? request.header('x-request-id');
    const path = request.path;
    response.on('finish', () => {
      console.info('[http]', JSON.stringify({
        requestId: requestId ?? null,
        method: request.method,
        path,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
        environment: options.release?.environment ?? process.env.NODE_ENV ?? 'development',
        commit: options.release?.commit ?? null,
      }));
    });
    response.on('close', () => {
      if (!response.writableEnded) {
        console.warn('[http] client disconnected', JSON.stringify({ requestId: requestId ?? null, method: request.method, path }));
      }
    });
    next();
  });
  const providers = createProviderMap(
    options.providers ?? [new TwilioProvider(), new FakeTelephonyProvider()],
  );
  const messaging = options.messagingProvider ?? new FakeMessagingProvider();
  const ownerDevices = options.ownerDeviceService ?? new OwnerDeviceService();
  const ownerConfiguration = options.ownerConfigurationService ?? new OwnerConfigurationService();
  // Tenancy: which account owns what. Nothing about any customer comes from the deployment.
  const tenancyStore = options.tenancyStore ?? new InMemoryTenancyStore();
  const phoneNumbers = options.phoneNumbers ?? new PhoneNumberService(
    tenancyStore,
    options.phoneNumberClient ?? new FakePhoneNumberClient(),
    options.publicBaseUrl ?? 'http://localhost:3000',
    messaging,
    { allowPurchase: options.allowNumberPurchase ?? !options.production },
  );
  // Every text is sent as an account, from that account's own assistant line.
  const accountMessaging = new AccountMessenger(messaging, phoneNumbers);
  // CallSessions: the durable record of every call. One AppPort application exposes the operations on it; the
  // voice runtime and the control plane reach it in-process, and the MCP projection (src/appport/mcp.ts) reaches the same one.
  const publicOrigin = options.publicBaseUrl ?? 'http://localhost:3000';
  const callSessions: CallSessionService = new CallSessionService(options.callSessionStore ?? new InMemoryCallSessionStore(), {
    provider: options.callProvider ?? new FakeCallProvider(),
    assistantLine: (accountId) => phoneNumbers.assistantLine(accountId),
    // Whether and from where an outbound call may be placed: decided before anything is created or dialed.
    policy: options.outboundPolicy ?? new DefaultOutboundPolicy({
      agentCallsEnabled: options.outboundAgentCalls ?? false,
      ownedCallerIds: (accountId) => phoneNumbers.ownedCallerIds(accountId),
      activeOutboundDestinations: (accountId) => callSessions.activeOutboundDestinations(accountId),
    }),
    // The URLs the provider is given are built here from our own configuration and the session's id; a request never supplies one.
    dialUrls: (session, origin) => ({
      answerUrl: origin === 'owner_test'
        ? `${publicOrigin}/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(session.from ?? '')}&callId=${encodeURIComponent(session.id)}`
        : `${publicOrigin}/webhooks/twilio/voice/outbound?callId=${encodeURIComponent(session.id)}`,
      statusUrl: `${publicOrigin}/webhooks/twilio/status?callId=${encodeURIComponent(session.id)}`,
    }),
  });
  phoneNumbers.bindCallSessions(callSessions);
  const callApplication = createCallApplication({ calls: callSessions });
  // In-process access to the call capabilities (no HTTP round trip) for code that owns the app: the voice runtime, the control plane, tests.
  app.locals.appport = { calls: callApplication };
  const ownerDeliveries = options.ownerDeliveryStore ?? new InMemoryOwnerMessageDeliveryStore();
  const runtime = options.runtimeControlService ?? new RuntimeControlService(
    options.repository,
    ownerConfiguration,
    options.runtimeStore ?? new InMemoryConversationRuntimeStore(),
    options.runtimeEventStore ?? new InMemoryConversationRuntimeEventStore(),
    options.runtimeOverrideStore ?? new InMemoryRuntimeOverrideStore(),
    options.runtimeController ?? new InProcessConversationRuntimeController(),
    options.runtimeEventBus,
    options.runtimeCommandStore,
  );
  const renderQrCode = options.qrCodeDataUrl ?? ((content: string) => toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  }));
  const ownerDeviceRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const staticAssetRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  // Owner attention: surfaces are optional add-ons; none of them is required for a conversation to work.
  const attentionStore = options.attentionStore ?? new InMemoryOwnerAttentionStore();
  const surfaceDevices = options.surfaceDeviceStore ?? new InMemoryOwnerSurfaceDeviceStore();
  const pushSender = options.pushSender ?? new VapidPushSender(options.appSecretStore ?? new InMemoryAppSecretStore());
  const attention = new OwnerAttentionService(
    attentionStore,
    options.notificationDeliveryStore ?? new InMemoryNotificationDeliveryStore(attentionStore),
    new NotificationRouter({
      push: new WebPushSurface(surfaceDevices, pushSender, options.apnsSender),
      mac: options.ownerChannel ? new MacMessagesSurface(options.ownerChannel, options.repository) : undefined,
      sms: new OwnerSmsSurface(accountMessaging, (id) => phoneNumbers.personalNumber(id)),
    }),
    // event → conversation's account → that account's preferences and channels → delivery.
    async (id) => {
      const { messages } = await ownerConfiguration.get(id);
      return {
        notifyOwner: messages.notifyOwner, interruptOnlyWhenNeeded: messages.interruptOnlyWhenNeeded,
        webEnabled: messages.webEnabled, macosMessagesEnabled: messages.macosMessagesEnabled,
        includeSummary: messages.includeSummary, includeSuggestedResponse: messages.includeSuggestedResponse,
        smsEnabled: messages.smsEnabled,
      };
    },
    (raised) => runtime.publishAttention(raised.conversationId, {
      attentionId: raised.id, attentionType: raised.type, status: raised.status, priority: raised.priority,
    }),
  );
  const service = new ConversationService(
    options.repository, accountMessaging, attention,
    async (id) => (await ownerConfiguration.get(id)).assistant.ownerName,
  );
  const channels = new NotificationChannelResolver({
    surfaceDevices,
    macDevices: ownerDevices,
    configuration: ownerConfiguration,
    personalNumber: (id) => phoneNumbers.personalNumber(id),
    nativePush: Boolean(options.apnsSender),
    messaging: Boolean(options.messagingProvider) || !options.production,
  });
  const tenancy = new TenancyService(tenancyStore, { configuration: ownerConfiguration, phoneNumbers, channels });
  const engine = new ConversationEngine(
    options.repository,
    options.speechProvider ?? new FakeSpeechProvider(),
    options.conversationModel ?? new FakeConversationModel(),
    options.voiceProvider ?? new FakeVoiceProvider(),
    accountMessaging,
    runtime,
    {
      autoReplyToCallerTexts: options.autoReplyToCallerTexts ?? false,
      contextFor: async (conversationId, channel = 'text') => {
        const conversation = await service.getConversation(conversationId);
        if (!conversation) return {};
        const configuration = await ownerConfiguration.get(conversation.accountId);
        const snapshot = await runtime.getRuntimeForConversation(conversation);
        const callSession = channel === 'voice' ? await callSessions.findByConversation(conversation.accountId, conversation.id).catch(() => null) : null;
        return {
          instructions: buildInstructions(snapshot, configuration, channel, callSession ? { direction: callSession.direction, objective: callSession.objective } : undefined),
          ownerName: configuration.assistant.ownerName,
          tools: {
            askOwner: async (question, suggestedReplies) => {
              const source = channel === 'voice' ? 'voice' : 'sms';
              const requestId = await service.requestOwner(conversationId, { question, suggestedReplies, source });
              await options.repository.appendEvent(conversationId, 'assistant.activity', {
                tool: 'ask_owner', summary: `Asked ${configuration.assistant.ownerName}: "${question}"`, requestId, source,
              }, new Date());
              await runtime.noteOwnerNeeded(conversationId, requestId, question);
            },
            noteCaller: async (name, reason) => {
              await options.repository.appendEvent(conversationId, 'caller.identified', {
                ...(name ? { name } : {}), ...(reason ? { reason } : {}), source: channel,
              }, new Date());
            },
          },
        };
      },
    },
  );
  const ownerReplies = new OwnerReplyService(options.repository, service, engine, runtime, Boolean(options.realtimeVoice));
  const fakeRoutesEnabled = options.includeFakeProviderRoutes ?? true;
  const realtimeVoice = options.realtimeVoice;
  realtimeVoice?.bind({
    repository: options.repository,
    runtime,
    conversations: service,
    configuration: ownerConfiguration,
    calls: callSessions,
  });
  const presentVoice = (conversation: Conversation) => ({
    realtime: Boolean(realtimeVoice),
    model: realtimeVoice?.modelId ?? null,
    ...realtimeVoiceStatus(conversation),
  });

  // Liveness: answers even while the database is still being prepared.
  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      environment: options.release?.environment ?? 'development',
      commit: options.release?.commit ?? null,
      time: new Date().toISOString(),
    });
  });
  // Universal links: https://<domain>/conversations/<id>/live opens the iOS app when it's installed.
  app.get('/.well-known/apple-app-site-association', (_request, response) => {
    if (!options.appleTeamId || !options.apnsSender) {
      response.status(404).json({ error: 'The iOS app isn’t configured for this deployment' });
      return;
    }
    const appId = `${options.appleTeamId}.${options.apnsSender.bundleId}`;
    response.type('application/json').json({
      applinks: { details: [{ appIDs: [appId], components: [{ '/': '/conversations/*/live' }, { '/': '/' }] }] },
      webcredentials: { apps: [appId] },
    });
  });

  // Readiness / smoke: the checks a production deployment must pass. No secrets are returned.
  app.get('/health/ready', async (_request, response) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await ensureReady();
      await options.healthCheck?.();
      checks.database = { ok: true, ...(options.healthCheck ? {} : { detail: 'in-memory (not production)' }) };
    } catch (error) {
      checks.database = { ok: false, detail: error instanceof Error ? error.message.slice(0, 120) : 'unavailable' };
    }
    // Accounts sign up and sign in with their own credentials; there is no deployment-wide access key.
    checks.authentication = { ok: Boolean(options.authSessionStore && options.tenancyStore), ...(options.authSessionStore && options.tenancyStore ? { detail: 'accounts' } : { detail: 'in-memory accounts (not production)' }) };
    checks.webhookSignatures = { ok: Boolean(options.twilioAuthToken) };
    checks.realtimeVoice = { ok: Boolean(options.realtimeVoice), ...(options.realtimeVoice ? { detail: options.realtimeVoice.modelId } : { detail: 'not configured' }) };
    checks.publicUrl = { ok: Boolean(options.publicBaseUrl && /^https:\/\//.test(options.publicBaseUrl)), detail: options.publicBaseUrl ?? 'unset' };
    checks.productionComposition = { ok: Boolean(options.production), ...(options.production ? {} : { detail: 'development composition' }) };
    // Needed only for the native iOS app; the browser and Home Screen app use Web Push.
    const optional = { nativePush: { ok: Boolean(options.apnsSender), detail: options.apnsSender ? options.apnsSender.bundleId : 'APNs not configured' } };
    const ok = Object.values(checks).every((check) => check.ok);
    response.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', environment: options.release?.environment ?? 'development', checks, optional });
  });

  if (options.beforeRequest) {
    // The app shell loads even while the database is unavailable; API calls then get a clear 503.
    const shell = /^\/(?:$|sw\.js$|manifest\.webmanifest$|icon[\w.-]*$|conversations\/[^/]+\/live$|api\/auth(?:\/|$)|auth\/callback$|\.well-known\/)/;
    app.use((request, _response, next) => {
      if (request.method === 'GET' && shell.test(request.path)) return next();
      ensureReady().then(() => next(), (error) => {
        next(new HttpError(503, 'Can’t reach the database right now. Try again in a moment.', 'database_unavailable'));
        void error;
      });
    });
  }
  // Vercel Cron: GET with `Authorization: Bearer <CRON_SECRET>`. Fails closed: no configured secret, no access.
  // Reconciliation only asks the provider what exists; nothing here can create a call.
  app.get('/api/internal/cron/reconcile-calls', async (request, response, next) => {
    try {
      const secret = options.cronSecret;
      const presented = bearerToken(request);
      const digest = (value: string) => createHash('sha256').update(value).digest();
      if (!secret || !presented || !timingSafeEqual(digest(secret), digest(presented))) {
        response.status(secret ? 401 : 503).json({ error: secret ? 'Unauthorized' : 'Cron is not configured' });
        return;
      }
      const settings = options.callReconciliation ?? {};
      if (settings.enabled === false) {
        response.json({ status: 'disabled' });
        return;
      }
      const report = await callSessions.reconcileUnconfirmedDials({
        limit: settings.batchSize, graceMs: settings.graceMs, maxAttempts: settings.maxAttempts, retryIntervalMs: settings.retryIntervalMs,
      });
      response.json({ status: 'ok', ...report });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.json({ verify: (request, _response, buffer) => {
    (request as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
  } }));
  app.use(express.urlencoded({ extended: false }));

  const auth = new AuthService(options.authSessionStore ?? new InMemoryAuthSessionStore());
  const authMessages = {
    missing: 'Authentication required', invalid: 'Authentication required',
    expired: 'Your session expired. Sign in again.', revoked: 'This device was signed out. Sign in again.',
  } as const;
  type AuthedRequest = Request & { authSession?: AuthSession; tenant?: TenantContext };

  const neonWebRequest = (request: Request): globalThis.Request => {
    const forwardedProto = (request.header('X-Forwarded-Proto') ?? request.protocol).split(',')[0].trim();
    const requestOrigin = options.publicBaseUrl ?? `${forwardedProto}://${request.get('host')}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    headers.set('origin', requestOrigin);
    const method = request.method.toUpperCase();
    const rawBody = (request as Request & { rawBody?: string }).rawBody;
    return new globalThis.Request(new URL(request.originalUrl, requestOrigin), {
      method,
      headers,
      ...(!['GET', 'HEAD'].includes(method) ? { body: rawBody ?? JSON.stringify(request.body ?? {}) } : {}),
    });
  };
  const neonSessionRequest = (request: Request): globalThis.Request => {
    const source = neonWebRequest(request);
    const headers = new Headers(source.headers);
    // Neon's get-session route is a body-less GET even though our same-origin
    // browser handoff is POST (so it cannot be triggered by navigation).
    headers.delete('content-type');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    return new globalThis.Request(source.url, { method: 'GET', headers });
  };
  const copyNeonCookies = (upstream: globalThis.Response, response: Response): void => {
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) response.setHeader('Set-Cookie', cookies);
  };
  const sendNeonResponse = async (upstream: globalThis.Response, response: Response): Promise<void> => {
    copyNeonCookies(upstream, response);
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('Content-Type', contentType);
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  };

  if (options.neonAuth) {
    const neon = options.neonAuth;
    app.get('/auth/providers', async (_request, response, next) => {
      try { response.json({ providers: await tenancyStore.authProviders?.() ?? ['google', 'apple'] }); }
      catch (error) { next(error); }
    });
    app.all(/^\/api\/auth\/(.+)$/, async (request, response, next) => {
      try {
        const path = request.path.slice('/api/auth/'.length);
        const upstream = await handleAuthProxyRequest({
          request: neonWebRequest(request), path, baseUrl: neon.baseUrl,
          cookieSecret: neon.cookieSecret, sameSite: 'lax',
        });
        await sendNeonResponse(upstream, response);
      } catch (error) { next(error); }
    });
    app.get('/auth/callback', async (request, response, next) => {
      try {
        if (typeof request.query.error === 'string') {
          response.redirect(302, `/signin?auth_error=${encodeURIComponent(request.query.error)}`);
          return;
        }
        const result = await processAuthMiddleware({
          request: neonWebRequest(request), pathname: request.path,
          skipRoutes: DEFAULT_AUTH_SKIP_ROUTES, loginUrl: '/signin',
          baseUrl: neon.baseUrl, cookieSecret: neon.cookieSecret, sameSite: 'lax',
        });
        if (result.action === 'redirect_oauth') {
          if (result.cookies.length) response.setHeader('Set-Cookie', result.cookies);
          response.redirect(302, '/?auth=complete');
          return;
        }
        response.redirect(302, '/signin?auth_error=oauth_callback_failed');
      } catch (error) { next(error); }
    });
    app.post('/auth/neon/session', async (request, response, next) => {
      try {
        const upstream = await handleAuthProxyRequest({
          request: neonSessionRequest(request), path: 'get-session', baseUrl: neon.baseUrl,
          cookieSecret: neon.cookieSecret, sameSite: 'lax',
        });
        copyNeonCookies(upstream, response);
        const identity = await upstream.json() as { user?: { email?: string; name?: string; emailVerified?: boolean }; session?: unknown };
        if (!upstream.ok || !identity.session || !identity.user?.email || identity.user.emailVerified !== true) {
          throw new HttpError(401, 'Your provider session could not be verified. Please try again.', 'oauth_session_invalid');
        }
        const { user, account } = await tenancy.signInExternal({ email: identity.user.email, name: identity.user.name });
        const created = await auth.createSession(user.id, account.id, { platform: 'web', label: 'Browser' });
        response.status(201).json({ token: created.token });
      } catch (error) { next(error); }
    });
  } else {
    app.get('/auth/providers', (_request, response) => response.json({ providers: [] }));
  }
  /** The authenticated principal: a live, unexpired, unrevoked session. Nothing about an account yet. */
  const principal = (request: Request, _response: Response, next: NextFunction): void => {
    // EventSource can't set headers, so live streams (and only they) accept ?token=.
    const streamToken = request.method === 'GET' && request.path.endsWith('/events') && typeof request.query?.token === 'string'
      ? request.query.token : undefined;
    const token = bearerToken(request) ?? streamToken;
    auth.authenticate(token).then((result) => {
      if (!result.ok) {
        next(new HttpError(401, authMessages[result.reason], result.reason === 'expired' || result.reason === 'revoked' ? `session_${result.reason}` : 'unauthenticated'));
        return;
      }
      (request as AuthedRequest).authSession = result.session;
      next();
    }, next);
  };
  /**
   * principal → membership → account → action. The account is the session's
   * active account, re-checked against a live membership on every request, so a
   * removed member loses access immediately on every instance. Fails closed.
   */
  const tenant = (action: TenantAction) => (request: Request, response: Response, next: NextFunction): void => {
    principal(request, response, (error?: unknown) => {
      if (error) return next(error);
      const session = (request as AuthedRequest).authSession!;
      tenancy.resolveContext(session.userId, session.accountId, session.id).then((context) => {
        if (!context) {
          next(new HttpError(403, 'You’re not a member of this account.', 'no_membership'));
          return;
        }
        (request as AuthedRequest).tenant = authorize(context, action);
        next();
      }).catch(next);
    });
  };
  const currentSession = (request: Request) => (request as AuthedRequest).authSession;
  const tenantOf = (request: Request): TenantContext => {
    const context = (request as AuthedRequest).tenant;
    if (!context) throw new HttpError(401, 'Authentication required', 'unauthenticated');
    return context;
  };
  /** The authorized account for this request. Never from the body, a phone number or the deployment. */
  const accountOf = (request: Request): string => tenantOf(request).accountId;

  if (options.twilioAuthToken) {
    app.use((request, _response, next) => {
      if (!request.path.startsWith('/webhooks/twilio/')) return next();
      const signature = request.header('X-Twilio-Signature');
      // Twilio signs the URL it was configured with. Behind Vercel's proxy request.protocol is http,
      // so check the public URL and the forwarded one, not just what Express sees.
      const forwardedProto = (request.header('X-Forwarded-Proto') ?? request.protocol).split(',')[0].trim();
      const urls = new Set([
        ...(options.publicBaseUrl ? [`${options.publicBaseUrl}${request.originalUrl}`] : []),
        `${forwardedProto}://${request.get('host')}${request.originalUrl}`,
        `${request.protocol}://${request.get('host')}${request.originalUrl}`,
      ]);
      if (!signature || ![...urls].some((url) => twilio.validateRequest(options.twilioAuthToken!, signature, url, request.body))) {
        next(new HttpError(403, 'Invalid webhook signature'));
        return;
      }
      next();
    });
  }

  const twilioProvider = providers.get('twilio') as TwilioProvider | undefined;
  if (!twilioProvider) {
    throw new Error('Twilio provider is required');
  }

  registerIncomingCallRoute(app, '/webhooks/twilio/voice', twilioProvider, service, ownerConfiguration, phoneNumbers, callSessions);
  registerIncomingCallRoute(app, '/webhooks/twilio/voice/test', twilioProvider, service, ownerConfiguration, phoneNumbers, callSessions, (request, call) => {
    const assistantLine = typeof request.query.assistantLine === 'string' ? request.query.assistantLine : '';
    if (!assistantLine) throw new HttpError(400, 'assistantLine is required');
    // An outbound test rings the owner's phone. Treat the destination as the caller and the
    // signed query parameter as the account line so the rest is the exact inbound call path.
    return { ...call, callerPhone: call.calledNumber ?? call.callerPhone, calledNumber: assistantLine };
  }, (request) => {
    const assistantLine = typeof request.query.assistantLine === 'string' ? request.query.assistantLine : '';
    if (!assistantLine) throw new HttpError(400, 'assistantLine is required');
    const confirmed = request.query.confirmed === '1';
    const digit = typeof request.body?.Digits === 'string' ? request.body.Digits : '';
    if (confirmed && digit === '1') return undefined;

    const twiml = new twilio.twiml.VoiceResponse();
    if (!confirmed) {
      const gather = twiml.gather({
        input: ['dtmf'],
        numDigits: 1,
        timeout: 10,
        method: 'POST',
        action: `/webhooks/twilio/voice/test?assistantLine=${encodeURIComponent(assistantLine)}&confirmed=1${typeof request.query.callId === 'string' ? `&callId=${encodeURIComponent(request.query.callId)}` : ''}`,
      });
      gather.say('Press 1 to talk to your assistant.');
    }
    // Live Voicemail cannot press a key, and an unexpected key must not start a
    // conversation that would make a recording look like the real caller.
    twiml.hangup();
    return { body: twiml.toString(), contentType: 'text/xml; charset=utf-8' };
  });
  // The callee answered a call the application placed for an agent. Twilio asks here for instructions; the call then
  // enters the same voice runtime as any other (conversation, CallSession, realtime stream or turn-based speech).
  // The session is named by the `callId` we put in this URL (signed by Twilio). If it is gone, over, or not this
  // account's, nothing starts: the callee hears silence and the call ends.
  const outboundSessions = new WeakMap<Request, { from: string | null; to: string | null }>();
  const hangUp = (): ProviderResponse => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    return { body: twiml.toString(), contentType: 'text/xml; charset=utf-8' };
  };
  registerIncomingCallRoute(app, '/webhooks/twilio/voice/outbound', twilioProvider, service, ownerConfiguration, phoneNumbers, callSessions, (request, call) => {
    const known = outboundSessions.get(request);
    // The session's numbers, not the request's: the callee is the "caller" of the conversation, the account's line is the line.
    return { ...call, callerPhone: known?.to ?? call.calledNumber ?? call.callerPhone, calledNumber: known?.from ?? call.callerPhone, direction: 'outbound' };
  }, async (request) => {
    const callId = typeof request.query.callId === 'string' ? request.query.callId : '';
    const sid = typeof request.body?.CallSid === 'string' ? request.body.CallSid : '';
    const session = callId ? await callSessions.findSession(callId) : null;
    if (!session || session.direction !== 'outbound' || !sid || isTerminal(session.status) || session.status === 'ending') {
      console.warn('[call] outbound answer for a call that is unknown or over', JSON.stringify({ callId: callId || null, providerCallId: sid || null, status: session?.status ?? null, traceId: requestTraceId(request) ?? null }));
      return hangUp();
    }
    const attached = await callSessions.adoptDialedCall(callId, sid);
    const line = session.from ? await phoneNumbers.resolveLine(session.from) : null;
    if (!attached || !line || line.accountId !== session.accountId) return hangUp();
    outboundSessions.set(request, { from: session.from, to: session.to });
    return undefined;
  }, true);
  app.post('/webhooks/twilio/voice/turn', async (request, response, next) => {
    try {
      const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : '';
      const turn = Math.max(1, Math.min(20, Number(request.query.turn) || 1));
      const callSid = typeof request.body?.CallSid === 'string' ? request.body.CallSid : '';
      const speech = typeof request.body?.SpeechResult === 'string' ? request.body.SpeechResult.trim() : '';
      if (!conversationId || !callSid) throw new HttpError(400, 'conversationId and CallSid are required');
      const conversation = await service.getConversation(conversationId);
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      // The first spoken turn is the assistant conversing: the CallSession moves from answered to in progress.
      const turnSession = await callSessions.findByConversation(conversation.accountId, conversationId).catch(() => null);
      if (turnSession?.status === 'answered') await callSessions.markInProgress(turnSession.id);

      // Provider termination is normally immediate, but this also prevents a
      // Gather already in flight (or a transient Twilio REST failure) from
      // starting another assistant turn after the owner pressed Stop.
      const currentRuntime = await runtime.getRuntimeForConversation(conversation);
      if (currentRuntime.state === 'stopped' || !currentRuntime.assistantEnabled) {
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.hangup();
        response.status(200).type('text/xml; charset=utf-8').send(twiml.toString());
        return;
      }

      if (turn >= 20) {
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('Thanks for calling. Goodbye.');
        twiml.hangup();
        response.status(200).type('text/xml; charset=utf-8').send(twiml.toString());
        return;
      }

      // Turn-based calls cannot receive a pushed WebSocket command. Consume the
      // owner's queued answer on Twilio's next Gather callback and speak it once.
      const relayedMessageIds = new Set(conversation.events
        .filter((event) => event.type === 'owner.message.relayed' && typeof event.payload.messageId === 'string')
        .map((event) => String(event.payload.messageId)));
      const pendingOwnerReply = [...conversation.events].reverse().find((event) =>
        event.type === 'owner.message' && event.payload.channel === 'voice' &&
        event.payload.delivery === 'queued_for_voice' && typeof event.payload.text === 'string' &&
        typeof event.payload.messageId === 'string' && !relayedMessageIds.has(String(event.payload.messageId)));
      if (pendingOwnerReply) {
        const messageId = String(pendingOwnerReply.payload.messageId);
        const callbackId = `${callSid}:owner:${messageId}`;
        const sequence = conversation.events.reduce((highest, event) => {
          const value = Number(event.payload.sequence);
          return Number.isFinite(value) ? Math.max(highest, value) : highest;
        }, 0) + 1;

        // Preserve anything the caller said while the owner was answering. The
        // owner instruction takes precedence for this spoken turn.
        if (speech && !conversation.events.some((event) =>
          event.type === 'speech.transcript' && event.payload.callbackId === `${callSid}:gather:${turn}`)) {
          const speechCallbackId = `${callSid}:gather:${turn}`;
          await service.recordEvent(conversationId, 'speech.started', { callbackId: speechCallbackId, sequence });
          await runtime.noteSpeechStarted(conversationId, speechCallbackId);
          await service.recordEvent(conversationId, 'speech.transcript', {
            callbackId: speechCallbackId, speaker: 'caller', text: speech, sequence,
          });
          await runtime.noteTranscript(conversationId, speechCallbackId, speech);
        }

        const configuration = await ownerConfiguration.get(conversation.accountId);
        const prompt = ownerVoiceReply(configuration.assistant.ownerName, String(pendingOwnerReply.payload.text));
        await service.recordEvent(conversationId, 'ai.response', {
          callbackId, speaker: 'assistant', text: prompt, source: 'owner_relay',
          messageId, sequence: sequence + 1,
        });
        await service.recordEvent(conversationId, 'owner.message.relayed', {
          messageId, requestId: pendingOwnerReply.payload.requestId,
          instruction: pendingOwnerReply.payload.text, text: prompt, channel: 'voice',
        });
        await runtime.noteAiCompleted(conversationId, callbackId, prompt);
        const providerResponse = twilioProvider.turn(conversationId, prompt, turn + 1);
        response.status(200).type(providerResponse.contentType).send(providerResponse.body);
        return;
      }

      // "I'll call them back" is a terminal owner decision. Once the caller
      // confirms the return number (or supplies a different one), acknowledge
      // it and end the call instead of feeding "yes" back into appointment
      // intake and asking the owner the same question again.
      const callbackRelay = [...conversation.events].reverse().find((event) =>
        event.type === 'owner.message.relayed' && typeof event.payload.instruction === 'string' &&
        /call (?:them|you) back/i.test(String(event.payload.instruction)));
      const callbackClosed = callbackRelay && conversation.events.some((event) =>
        event.type === 'assistant.activity' && event.payload.activity === 'callback_confirmed' &&
        event.occurredAt.getTime() >= callbackRelay.occurredAt.getTime());
      if (callbackRelay && !callbackClosed && speech) {
        const speechCallbackId = `${callSid}:gather:${turn}`;
        const sequence = conversation.events.reduce((highest, event) => {
          const value = Number(event.payload.sequence);
          return Number.isFinite(value) ? Math.max(highest, value) : highest;
        }, 0) + 1;
        if (!conversation.events.some((event) =>
          event.type === 'speech.transcript' && event.payload.callbackId === speechCallbackId)) {
          await service.recordEvent(conversationId, 'speech.started', { callbackId: speechCallbackId, sequence });
          await runtime.noteSpeechStarted(conversationId, speechCallbackId);
          await service.recordEvent(conversationId, 'speech.transcript', {
            callbackId: speechCallbackId, speaker: 'caller', text: speech, sequence,
          });
          await runtime.noteTranscript(conversationId, speechCallbackId, speech);
        }

        const askedForDifferentNumber = conversation.events.some((event) =>
          event.type === 'ai.response' && event.payload.source === 'owner_callback_number' &&
          event.occurredAt.getTime() >= callbackRelay.occurredAt.getTime());
        if (/^(?:no|nope|not that one)\b/i.test(speech) && !askedForDifferentNumber) {
          const prompt = 'What number should they use to call you back?';
          await service.recordEvent(conversationId, 'ai.response', {
            callbackId: `${callSid}:callback-number:${turn}`, speaker: 'assistant', text: prompt,
            source: 'owner_callback_number', sequence: sequence + 1,
          });
          const providerResponse = twilioProvider.turn(conversationId, prompt, turn + 1);
          response.status(200).type(providerResponse.contentType).send(providerResponse.body);
          return;
        }

        const configuration = await ownerConfiguration.get(conversation.accountId);
        const ownerName = configuration.assistant.ownerName.trim() || 'The account owner';
        const prompt = `Thank you. ${ownerName} will call you back. Goodbye.`;
        const callbackId = `${callSid}:callback-confirmed:${turn}`;
        await service.recordEvent(conversationId, 'ai.response', {
          callbackId, speaker: 'assistant', text: prompt,
          source: 'owner_callback_complete', sequence: sequence + 1,
        });
        await service.recordEvent(conversationId, 'assistant.activity', {
          activity: 'callback_confirmed', source: 'owner_relay', instruction: callbackRelay.payload.instruction,
        });
        await runtime.noteAiCompleted(conversationId, callbackId, prompt);
        await runtime.stop(conversationId, conversation.accountId, { commandId: `callback-complete:${callbackId}` });
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say(prompt);
        twiml.hangup();
        response.status(200).type('text/xml; charset=utf-8').send(twiml.toString());
        return;
      }

      let prompt = "I didn't hear anything. What can I help you with?";
      if (speech) {
        const callbackId = `${callSid}:gather:${turn}`;
        let updated;
        try {
          updated = await engine.respond(conversationId, { callbackId, audio: speech });
        } catch (error) {
          // Twilio treats a 500 from a voice webhook as an application error and
          // plays its own recording. Always give the caller a useful, valid
          // TwiML response even when the AI provider or its billing is down.
          console.error(`[voice turn ${conversationId}] assistant unavailable`, error);
          await service.raiseAttention(conversationId, {
            type: 'error',
            title: (name) => `Assistant couldn't answer ${name}`,
            body: `The caller said: “${speech.slice(0, 180)}”`,
            dedupeKey: `voice-assistant-failed:${callbackId}`,
            priority: 'interrupt',
            actions: ['open', 'take_over'],
            metadata: { callbackId, channel: 'voice' },
          });
          const configuration = await ownerConfiguration.get(conversation.accountId).catch(() => undefined);
          const ownerName = configuration?.assistant.ownerName.trim();
          const twiml = new twilio.twiml.VoiceResponse();
          twiml.say(ownerName
            ? `I'm sorry, I'm having trouble helping right now. I'll let ${ownerName} know you called. Goodbye.`
            : "I'm sorry, I'm having trouble helping right now. I'll let the account owner know you called. Goodbye.");
          twiml.hangup();
          response.status(200).type('text/xml; charset=utf-8').send(twiml.toString());
          return;
        }
        const reply = [...updated.events].reverse().find((event) =>
          event.type === 'ai.response' && event.payload.callbackId === callbackId);
        prompt = typeof reply?.payload.text === 'string' && reply.payload.text.trim()
          ? reply.payload.text.trim()
          : 'Let me check on that. Is there anything else you would like me to know?';
      }
      const providerResponse = twilioProvider.turn(conversationId, prompt, turn + 1);
      response.status(200).type(providerResponse.contentType).send(providerResponse.body);
    } catch (error) {
      next(error);
    }
  });
  registerStatusRoute(app, '/webhooks/twilio/status', twilioProvider, service, callSessions);

  // A caller left a voicemail (only offered when the owner turned off answering calls).
  app.post('/webhooks/twilio/voicemail', async (request, response, next) => {
    try {
      const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : '';
      const recordingUrl = typeof request.body?.RecordingUrl === 'string' ? request.body.RecordingUrl : '';
      if (!conversationId || !recordingUrl) throw new HttpError(400, 'conversationId and RecordingUrl are required');
      const duration = Number(request.body?.RecordingDuration ?? 0);
      await service.recordEvent(conversationId, 'voicemail.recorded', {
        recordingUrl, recordingSid: request.body?.RecordingSid, durationSeconds: Number.isFinite(duration) ? duration : null,
      });
      await service.raiseAttention(conversationId, {
        type: 'voicemail',
        title: (name) => `${name} left a voicemail`,
        body: Number.isFinite(duration) && duration > 0 ? `${duration} second message` : 'New voicemail',
        dedupeKey: `voicemail:${conversationId}:${request.body?.RecordingSid ?? recordingUrl}`,
        actions: ['open'],
      });
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say('Thanks. Goodbye.');
      twiml.hangup();
      response.type('text/xml; charset=utf-8').send(twiml.toString());
    } catch (error) {
      next(error);
    }
  });

  // Twilio continues here once a realtime media stream ends.
  app.post('/webhooks/twilio/voice/continue', async (request, response, next) => {
    try {
      const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : '';
      const conversation = conversationId ? await service.getConversation(conversationId) : null;
      const twiml = new twilio.twiml.VoiceResponse();
      if (!conversation || realtimeVoiceStatus(conversation).outcome === 'failed') {
        twiml.say("Sorry, the assistant can't take your call right now. Please send a text to this number instead.");
      }
      twiml.hangup();
      response.type('text/xml; charset=utf-8').send(twiml.toString());
    } catch (error) {
      next(error);
    }
  });

  app.post('/webhooks/twilio/sms', async (request, response, next) => {
    try {
      if (!twilioProvider.parseIncomingSms) throw new HttpError(501, 'SMS is not supported');
      const message = twilioProvider.parseIncomingSms(request.body);
      // Whose text is this? The line it was sent to. A number no account owns is refused.
      const line = message.to ? await phoneNumbers.resolveLine(message.to) : null;
      if (!line) throw new HttpError(404, 'Unknown line');
      const accountId = line.accountId;
      if (message.from === await phoneNumbers.personalNumber(accountId)) {
        // The account's owner texted their own line back: it answers whichever of *their* conversations waits on them.
        const target = await service.findConversationForOwnerReply(accountId);
        if (!target) throw new HttpError(404, 'No conversation is waiting for you');
        const conversation = await ownerReplies.reply({
          conversationId: target.id, accountId, body: message.body,
          idempotencyKey: `sms:${message.providerMessageId}`, source: 'sms',
        });
        response.json(presentConversation(conversation));
        return;
      }
      const received = await service.receiveSms(accountId, message);
      let conversation = received;
      try {
        conversation = await engine.respondToCallerText(received.id, message.providerMessageId);
      } catch (error) {
        // The caller's text is saved; if the assistant can't reply, the owner must see it.
        console.error(`[sms ${received.id}] assistant reply failed`, error);
        await service.requestOwner(received.id, {
          question: `New text: "${message.body}" — the assistant couldn't reply. Can you answer?`,
          source: 'sms', callId: message.providerMessageId,
        }).catch(() => undefined);
        await runtime.noteOwnerNeeded(received.id, message.providerMessageId, message.body).catch(() => undefined);
        conversation = (await service.getConversation(received.id)) ?? received;
      }
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });

  if (fakeRoutesEnabled) {
    const fake = providers.get('fake');
    if (fake) {
      registerIncomingCallRoute(app, '/webhooks/fake/voice', fake, service, ownerConfiguration, phoneNumbers, callSessions);
      registerStatusRoute(app, '/webhooks/fake/status', fake, service, callSessions);
    }
  }

  app.post('/owner/devices/pair', tenant('device.manage'), async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        accountOf(request),
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
        tenantOf(request).userId,
      );
      response.status(201).json({
        pairingUri: result.pairingUri,
        deviceId: result.device.id,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
        },
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/pair/qr', tenant('device.manage'), async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        accountOf(request),
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
        tenantOf(request).userId,
      );
      // The QR holds only a single-use token and the server to redeem it at.
      const origin = options.publicBaseUrl ?? `${request.protocol}://${request.get('host')}`;
      const payload = pairingQrPayload(result.pairingCode, origin);
      response.status(201).json({
        deviceId: result.device.id,
        pairingUri: payload,
        qrDataUrl: await renderQrCode(payload),
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // The iPhone polls this while it shows the QR: "Waiting for Mac…" → "Mac connected".
  app.get('/owner/devices/pair/:id', tenant('device.manage'), async (request, response, next) => {
    try {
      const device = await ownerDevices.get(String(request.params.id));
      if (!device || device.accountId !== accountOf(request)) throw new HttpError(404, 'Device not found');
      response.json({ deviceId: device.id, name: device.name, status: device.status });
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/:id/activate', async (request, response, next) => {
    try {
      const code = typeof request.body?.pairingCredential === 'string'
        ? request.body.pairingCredential.replace(/^attn:\/\/pair\//, '')
        : typeof request.body?.pairingCode === 'string' ? request.body.pairingCode : '';
      const result = await ownerDevices.activate(String(request.params.id), code);
      response.json({
        ...result,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
          lastSeenAt: result.device.lastSeenAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      next(new HttpError(401, error instanceof Error ? error.message : 'Pairing failed'));
    }
  });

  app.post('/owner/devices/activate', async (request, response, next) => {
    try {
      const credential = typeof request.body?.pairingCredential === 'string' ? request.body.pairingCredential : '';
      const result = await ownerDevices.activatePairing(credential);
      await ownerConfiguration.recordChange(result.device.accountId, 'device.connected', 'macos_bridge').catch(() => undefined);
      response.json({
        ...result,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
          lastSeenAt: result.device.lastSeenAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      next(new HttpError(401, error instanceof Error ? error.message : 'Pairing failed'));
    }
  });

  const deviceAuth = async (request: Request) => {
    const token = bearerToken(request) ?? '';
    const device = await ownerDevices.authenticate(token);
    if (!device || device.id !== String(request.params.id)) throw new HttpError(401, 'Device authentication required');
    return { device, token };
  };

  app.get('/owner/devices/:id/status', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json({
        id: device.id,
        accountId: device.accountId,
        status: device.status,
        setupStatus: device.setupStatus,
        assistantChat: device.assistantChat,
        messagesIdentity: device.messagesIdentity,
        lastSeenAt: device.lastSeenAt,
      });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.post('/owner/devices/:id/heartbeat', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      // The bridge measures capabilities on the Mac and reports them; there is no Messages access on the server.
      const reported = request.body?.capabilities;
      let capabilities: MessagesCapabilities;
      if (reported && typeof reported === 'object') {
        const identity = reported.authorizedIdentity;
        capabilities = {
          messagesAccess: reported.messagesAccess === true,
          sendCapability: reported.sendCapability === true,
          watcher: reported.watcher === true,
          ...(identity && (identity.service === 'imessage' || identity.service === 'sms') && typeof identity.address === 'string'
            ? { authorizedIdentity: { service: identity.service, address: identity.address.slice(0, 200) } } : {}),
        };
      } else if (options.ownerMessagesAdapter?.checkCapabilities) {
        capabilities = await options.ownerMessagesAdapter.checkCapabilities();
      } else {
        throw new HttpError(400, 'capabilities are required');
      }
      const version = typeof request.body?.bridgeVersion === 'string' ? request.body.bridgeVersion.slice(0, 40) : undefined;
      response.json(await ownerDevices.reportHealth(token, capabilities, version));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Device authentication required'));
    }
  });

  app.get('/owner/devices/:id/messages/chats', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      if (!options.ownerMessagesAdapter) throw new HttpError(501, 'Messages chat discovery is unavailable');
      const chats = await ownerDevices.discoverChats(token, options.ownerMessagesAdapter);
      response.json(chats.map(({ id, service, displayName, address, isGroup }) => ({ id, service, displayName, address, isGroup })));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Chat discovery failed'));
    }
  });

  // The bridge reports candidate assistant chats it found on the Mac (its owner's own threads only).
  app.post('/owner/devices/:id/messages/chats', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      const chats = Array.isArray(request.body?.chats) ? request.body.chats : null;
      if (!chats) throw new HttpError(400, 'chats are required');
      const valid = chats.filter((chat: Record<string, unknown>) => typeof chat?.id === 'string' &&
        (chat.service === 'imessage' || chat.service === 'sms'))
        .map((chat: Record<string, unknown>) => ({
          id: String(chat.id).slice(0, 200), service: chat.service as 'imessage' | 'sms',
          displayName: typeof chat.displayName === 'string' ? chat.displayName.slice(0, 120) : undefined,
          address: typeof chat.address === 'string' ? chat.address.slice(0, 200) : undefined,
          isGroup: chat.isGroup === true,
        }));
      const device = await ownerDevices.reportChats(token, valid);
      response.json({ discoveredChats: device.discoveredChats.length });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Device authentication required'));
    }
  });

  // Test connection: the owner asks, the bridge checks and answers; nothing visible is sent.
  app.post('/owner/devices/:id/test', tenant('device.manage'), async (request, response, next) => {
    try {
      const device = await ownerDevices.requestProbe(accountOf(request), String(request.params.id));
      response.status(202).json({ probe: device.probe });
    } catch (error) {
      next(new HttpError(404, error instanceof Error ? error.message : 'Device not found'));
    }
  });

  app.post('/owner/devices/:id/probe/:probeId', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      const body = request.body ?? {};
      const device = await ownerDevices.completeProbe(token, String(request.params.probeId), {
        messagesAccess: body.messagesAccess === true,
        sendCapability: body.sendCapability === true,
        watcher: body.watcher === true,
        assistantChatFound: body.assistantChatFound === true,
      });
      response.json({ probe: device.probe });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Connection test failed'));
    }
  });

  app.post('/owner/devices/:id/messages/chat', ownerDeviceRateLimit, tenant('device.manage'), async (request, response, next) => {
    try {
      const service = request.body?.service;
      const chatId = request.body?.chatId;
      if ((service !== 'imessage' && service !== 'sms') || typeof chatId !== 'string' || !chatId.trim()) {
        throw new HttpError(400, 'chatId and service are required');
      }
      const device = await ownerDevices.authorizeChat(
        accountOf(request), String(request.params.id), chatId, service,
      );
      await ownerConfiguration.recordChange(device.accountId, 'assistant.chat.changed');
      response.json(device);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Chat authorization failed'));
    }
  });

  app.get('/owner/devices/:id/deliveries', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json(await ownerDeliveries.listPending(device.id));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/requested', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const providerRequestId = typeof request.body?.providerRequestId === 'string' ? request.body.providerRequestId.trim() : '';
      if (!providerRequestId) throw new HttpError(400, 'providerRequestId is required');
      const delivery = await ownerDeliveries.markSent(device.id, String(request.params.deliveryId), providerRequestId);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery update failed'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/observed', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const externalId = typeof request.body?.externalId === 'string' ? request.body.externalId.trim() : '';
      if (!externalId) throw new HttpError(400, 'externalId is required');
      const delivery = await ownerDeliveries.markObserved(device.id, String(request.params.deliveryId), externalId);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      assertJobOwnership({ id: delivery.id, accountId: delivery.accountId, resourceId: device.id }, device);
      await options.repository.appendEvent(delivery.conversationId, 'owner.delivery.sent', {
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        externalId,
        providerRequestId: delivery.providerRequestId,
        source: 'macos_messages',
      }, new Date());
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery confirmation failed'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/failed', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const message = typeof request.body?.error === 'string' && request.body.error.trim()
        ? request.body.error.trim()
        : 'Delivery failed';
      const delivery = await ownerDeliveries.markFailed(device.id, String(request.params.deliveryId), message);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      assertJobOwnership({ id: delivery.id, accountId: delivery.accountId, resourceId: device.id }, device);
      await options.repository.appendEvent(delivery.conversationId, 'owner.delivery.failed', {
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        error: message,
        source: 'macos_messages',
      }, new Date());
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery failure could not be recorded'));
    }
  });

  app.post('/owner/devices/:id/messages/replies', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const externalId = typeof request.body?.externalId === 'string' ? request.body.externalId.trim() : '';
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      if (!externalId || !body) throw new HttpError(400, 'externalId and body are required');
      const deliveryId = typeof request.body?.deliveryId === 'string' ? request.body.deliveryId : undefined;
      const replyToExternalId = typeof request.body?.replyToExternalId === 'string' ? request.body.replyToExternalId : undefined;
      const delivery = await ownerDeliveries.claimReplyTarget(device.id, externalId, deliveryId, replyToExternalId);
      if (!delivery) throw new HttpError(409, 'No owner delivery is awaiting a reply');
      // The queued delivery is a job: it, the Mac and the conversation must all belong to one account.
      assertJobOwnership({ id: delivery.id, accountId: delivery.accountId, resourceId: device.id }, device);
      assertJobOwnership({ id: delivery.id, accountId: delivery.accountId, resourceId: delivery.conversationId },
        await service.getConversation(delivery.conversationId));
      await options.repository.appendEvent(delivery.conversationId, 'owner.message.received', {
        deliveryId: delivery.id,
        externalId,
        body,
        source: 'macos_messages',
      }, new Date());
      const conversation = await ownerReplies.reply({
        conversationId: delivery.conversationId,
        accountId: device.accountId,
        body,
        idempotencyKey: `macos:${device.id}:${externalId}`,
        source: 'macos_messages',
      });
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Owner reply failed'));
    }
  });

  // ---- Owner surfaces: push registration (web now; ios/macos later use the same records) ----
  const presentSurfaceDevice = (device: Awaited<ReturnType<OwnerSurfaceDeviceStore['list']>>[number]) => ({
    id: device.id, platform: device.platform, capabilities: device.capabilities, label: device.label ?? null,
    status: device.status, createdAt: device.createdAt.toISOString(), lastSeenAt: device.lastSeenAt.toISOString(),
  });

  app.get('/owner/push/config', tenant('device.register'), async (_request, response, next) => {
    try {
      response.json({ publicKey: await pushSender.publicKey(), nativePush: Boolean(options.apnsSender) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/owner/push/devices', tenant('account.read'), async (request, response, next) => {
    try {
      response.json((await surfaceDevices.list(accountOf(request))).map(presentSurfaceDevice));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/push/devices', tenant('device.register'), async (request, response, next) => {
    try {
      // The native iOS app registers its APNs token here too: same devices, same attention, same deep links.
      if (request.body?.platform === 'ios') {
        const apnsToken = typeof request.body?.apnsToken === 'string' ? request.body.apnsToken.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{64,200}$/.test(apnsToken)) throw new HttpError(400, 'A valid APNs device token is required');
        if (!options.apnsSender) throw new HttpError(409, 'Native notifications aren’t set up on this server (APNs)', 'apns_not_configured');
        const now = new Date();
        const device = await surfaceDevices.upsert({
          id: createSurfaceDeviceId(), accountId: accountOf(request), userId: tenantOf(request).userId, platform: 'ios', deviceToken: apnsToken,
          capabilities: ['push', 'deep_link', 'interactive_notification'],
          label: typeof request.body?.label === 'string' ? request.body.label.slice(0, 60) : 'iPhone app',
          sessionId: currentSession(request)?.id, status: 'active', createdAt: now, lastSeenAt: now,
        });
        await tenancy.refreshOnboarding(accountOf(request));
        response.status(201).json(presentSurfaceDevice(device));
        return;
      }
      const subscription = request.body?.subscription;
      const endpoint = subscription?.endpoint;
      if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) ||
        typeof subscription?.keys?.p256dh !== 'string' || typeof subscription?.keys?.auth !== 'string') {
        throw new HttpError(400, 'A valid push subscription is required');
      }
      // Capabilities are what we can actually do for a web push device; action buttons only where the browser shows them.
      const capabilities: OwnerDeviceCapability[] = ['push', 'deep_link'];
      if (request.body?.supportsActions === true) capabilities.push('interactive_notification');
      const now = new Date();
      const device = await surfaceDevices.upsert({
        id: createSurfaceDeviceId(), accountId: accountOf(request), userId: tenantOf(request).userId, platform: 'web',
        deviceToken: JSON.stringify({ endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }),
        capabilities, label: typeof request.body?.label === 'string' ? request.body.label.slice(0, 60) : undefined,
        sessionId: currentSession(request)?.id,
        status: 'active', createdAt: now, lastSeenAt: now,
      });
      await tenancy.refreshOnboarding(accountOf(request));
      response.status(201).json(presentSurfaceDevice(device));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/owner/push/devices/:id', tenant('device.register'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const device = (await surfaceDevices.list(context.accountId)).find((candidate) => candidate.id === String(request.params.id));
      if (!device) throw new HttpError(404, 'Device not found');
      // Anyone may remove their own device; removing someone else's needs device management.
      if (device.userId !== context.userId) authorize(context, 'device.manage');
      await surfaceDevices.setStatus(context.accountId, device.id, 'revoked');
      await tenancy.refreshOnboarding(context.accountId);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/push/test', tenant('device.register'), async (request, response, next) => {
    try {
      const devices = (await surfaceDevices.list(accountOf(request))).filter((device) => device.status === 'active' && device.platform === 'web');
      if (!devices.length) throw new HttpError(409, 'Turn on notifications on this device first');
      const payload = JSON.stringify({ title: 'Notifications are on', body: 'You’ll hear from your assistant only when it needs you.', url: '/', tag: 'test' });
      const results = await Promise.all(devices.map((device) => pushSender.send(JSON.parse(device.deviceToken), payload, { ttlSeconds: 60, urgency: 'normal' })
        .then(() => 'sent', () => 'failed')));
      response.json({ sent: results.filter((result) => result === 'sent').length, failed: results.filter((result) => result === 'failed').length });
    } catch (error) {
      next(error);
    }
  });

  // ---- Owner attention: what needs the owner, and one-tap actions from a notification ----
  const presentAttention = (item: Awaited<ReturnType<OwnerAttentionService['list']>>[number]) => ({
    id: item.id, conversationId: item.conversationId, type: item.type, priority: item.priority, title: item.title,
    body: item.body, actions: item.actions, status: item.status, url: attentionUrl(item),
    createdAt: item.createdAt.toISOString(), resolvedAt: item.resolvedAt?.toISOString() ?? null,
  });

  app.get('/owner/attention', tenant('conversation.read'), async (request, response, next) => {
    try {
      response.json((await attention.list(accountOf(request), {
        open: request.query.open === 'true',
        conversationId: typeof request.query.conversationId === 'string' ? request.query.conversationId : undefined,
        limit: 50,
      })).map(presentAttention));
    } catch (error) {
      next(error);
    }
  });

  const requireAttention = async (request: Request) => {
    const item = await attention.get(String(request.params.id), accountOf(request));
    if (!item) throw new HttpError(404, 'Not found');
    return item;
  };

  app.get('/owner/attention/:id', tenant('conversation.read'), async (request, response, next) => {
    try {
      response.json(presentAttention(await requireAttention(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/attention/:id/opened', tenant('conversation.read'), async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      await attention.markOpened(item);
      response.json(presentAttention((await attention.get(item.id, accountOf(request)))!));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/attention/:id/dismiss', tenant('conversation.control'), async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      await attention.dismiss(item);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /**
   * Act on a notification. The conversation comes from the stored attention,
   * never from the client, and the action runs as a durable runtime command.
   */
  app.post('/owner/attention/:id/actions', tenant('conversation.control'), async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      const action = request.body?.action;
      const commandId = typeof request.body?.commandId === 'string' ? request.body.commandId : `attention:${item.id}:${action}`;
      // A stale notification (answered elsewhere, dismissed, or no longer relevant) never acts;
      // the surface shows the conversation's current state instead. Replaying the same command is fine.
      const replay = item.status === 'acted' && item.metadata?.commandId === commandId;
      if (['acted', 'dismissed', 'resolved'].includes(item.status) && !replay) {
        throw new HttpError(409, item.status === 'acted' ? 'Already handled on another device.' : 'This no longer needs you.', 'attention_resolved');
      }
      if (action === 'take_over') {
        const snapshot = await runtime.takeOver(item.conversationId, item.accountId, { commandId });
        await attention.markActed(item, 'take_over', commandId);
        response.json({ conversationId: item.conversationId, runtime: presentRuntime(snapshot) });
        return;
      }
      if (action === 'reply') {
        const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
        if (!body || body.length > 2000) throw new HttpError(400, 'Reply must be between 1 and 2000 characters');
        const conversation = await ownerReplies.reply({
          conversationId: item.conversationId, accountId: item.accountId, body, idempotencyKey: commandId, source: 'web',
        });
        await attention.markActed(item, 'reply', commandId);
        response.json({ conversationId: item.conversationId, conversation: presentConversation(conversation) });
        return;
      }
      throw new HttpError(400, 'Unknown action');
    } catch (error) {
      next(error);
    }
  });

  // Owner-wide live stream: every change in any of the owner's conversations, including new attention.
  app.get('/owner/events', tenant('conversation.read'), (request, response) => {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    response.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = runtime.subscribeOwner(accountOf(request), (event) => {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() })}\n\n`);
    });
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ---- The control-plane contract: the browser and the iOS app use exactly these routes ----
  const signInLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const billingLimit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const presentSession = (session: AuthSession, current?: AuthSession) => ({
    id: session.id, platform: session.platform, label: session.label, accountId: session.accountId,
    createdAt: session.createdAt.toISOString(), lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(), current: session.id === current?.id,
  });
  const presentUser = (user: { id: string; name: string; email: string }) => ({ id: user.id, name: user.name, email: user.email });
  const presentPhone = (number: import('./tenancy/model.js').PhoneNumber | null) => number ? {
    id: number.id, kind: number.kind, number: number.number, status: number.status, provider: number.provider,
    verificationStatus: number.verificationStatus, verifiedAt: number.verifiedAt?.toISOString() ?? null,
    createdAt: number.createdAt.toISOString(), updatedAt: number.updatedAt.toISOString(),
  } : null;
  const sessionInput = (request: Request) => ({
    platform: request.body?.platform === 'ios' ? 'ios' as const : 'web' as const,
    label: typeof request.body?.label === 'string' ? request.body.label : undefined,
  });
  /** A device signed in to one account at a time: its registrations elsewhere stop when it leaves. */
  const retireSessionDevices = async (userId: string, sessionId: string, exceptAccountId?: string) => {
    for (const membership of await tenancy.memberships(userId)) {
      if (membership.accountId === exceptAccountId) continue;
      for (const device of await surfaceDevices.list(membership.accountId)) {
        if (device.sessionId === sessionId && device.status === 'active') await surfaceDevices.setStatus(membership.accountId, device.id, 'revoked');
      }
    }
  };
  // Signing a device out also stops its notifications, in every account it was registered in.
  const revokeSession = async (userId: string, sessionId: string) => {
    if (!(await auth.revoke(userId, sessionId))) return false;
    await retireSessionDevices(userId, sessionId);
    return true;
  };

  /** Bootstrap for any surface: who you are, which accounts you belong to, the active one and its setup state. */
  const describeMe = async (session: AuthSession) => {
    const [user, memberships] = await Promise.all([tenancy.getUser(session.userId), tenancy.memberships(session.userId)]);
    if (!user) throw new HttpError(401, 'Authentication required', 'unauthenticated');
    const active = memberships.find((membership) => membership.accountId === session.accountId);
    const account = active ? await tenancy.getAccount(active.accountId) : null;
    return {
      user: presentUser(user),
      memberships: memberships.map((membership) => ({ accountId: membership.accountId, accountName: membership.accountName, role: membership.role })),
      activeAccountId: active ? session.accountId : null,
      account: account ? {
        id: account.id, name: account.name, role: active!.role,
        subscription: (await tenancy.getSubscription(account.id))?.status ?? 'pending',
      } : null,
      onboarding: account ? await tenancy.refreshOnboarding(account.id) : null,
      session: presentSession(session, session),
    };
  };

  // Anyone can create an account: no deployment configuration names its customers.
  app.post('/auth/signup', signInLimit, async (request, response, next) => {
    try {
      const { user, account } = await tenancy.signUp({
        email: request.body?.email, password: request.body?.password, name: request.body?.name, accountName: request.body?.accountName,
      });
      const { token, session } = await auth.createSession(user.id, account.id, sessionInput(request));
      response.status(201).json({ token, ...(await describeMe(session)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/auth/sessions', signInLimit, async (request, response, next) => {
    try {
      const user = await tenancy.signIn(request.body?.email, request.body?.password);
      if (!user) throw new HttpError(401, 'That email and password don’t match.', 'invalid_credentials');
      const memberships = await tenancy.memberships(user.id);
      // Resume in the account asked for (if the user belongs to it), else the first one they joined.
      const requested = typeof request.body?.accountId === 'string' ? request.body.accountId : undefined;
      const account = memberships.find((membership) => membership.accountId === requested) ?? memberships[0];
      if (!account) throw new HttpError(403, 'You’re not a member of any account.', 'no_membership');
      const { token, session } = await auth.createSession(user.id, account.accountId, sessionInput(request));
      response.status(201).json({ token, ...(await describeMe(session)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/billing/checkout', billingLimit, principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      const subscription = await tenancy.getSubscription(session.accountId);
      if (subscription?.status === 'active') {
        response.status(409).json({ error: 'This account already has an active subscription.', code: 'already_subscribed' });
        return;
      }
      if (options.billingBypassAccountId === session.accountId) {
        await tenancyStore.updateSubscription(session.accountId, { status: 'active' });
        response.json({ url: `${options.publicBaseUrl ?? 'http://localhost:3000'}/?checkout=bypassed`, status: 'active' });
        return;
      }
      if (!options.stripe) throw new HttpError(503, 'Billing is not configured.', 'billing_unavailable');
      const user = await tenancy.getUser(session.userId);
      if (!user) throw new HttpError(401, 'Authentication required', 'unauthenticated');
      const result = await checkout(options.stripe, { accountId: session.accountId, email: user.email });
      await tenancyStore.updateSubscription(session.accountId, {
        stripeCustomerId: result.customer,
      });
      response.json({ url: result.url, status: 'pending' });
    } catch (error) { next(error); }
  });

  app.get('/billing', tenant('account.read'), async (request, response, next) => {
    try {
      const subscription = await tenancy.getSubscription(accountOf(request));
      response.json(subscription ? {
        plan: 'Just Text Me', price: '$19.99/month', status: subscription.status,
        nextBillingDate: subscription.currentPeriodEnd?.toISOString() ?? null,
        manageBilling: Boolean(options.stripe && subscription.stripeCustomerId),
      } : null);
    } catch (error) { next(error); }
  });

  app.post('/billing/portal', billingLimit, tenant('account.manage'), async (request, response, next) => {
    try {
      const subscription = await tenancy.getSubscription(accountOf(request));
      if (!options.stripe || !subscription?.stripeCustomerId) throw new HttpError(409, 'No Stripe customer is associated with this account.', 'billing_not_ready');
      response.json({ url: await portal(options.stripe, subscription.stripeCustomerId) });
    } catch (error) { next(error); }
  });

  app.post('/webhooks/stripe', billingLimit, async (request, response) => {
    if (!options.stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      response.status(503).json({ error: 'Stripe webhooks are not configured.' });
      return;
    }
    try {
      const event = verifyWebhook((request as Request & { rawBody?: string }).rawBody ?? '', request.header('stripe-signature') ?? '', process.env.STRIPE_WEBHOOK_SECRET);
      const object = (event.data as { object?: Record<string, unknown> } | undefined)?.object;
      const customer = typeof object?.customer === 'string' ? object.customer : undefined;
      const subscriptionId = typeof object?.id === 'string' ? object.id : undefined;
      const existing = customer ? await tenancyStore.findSubscriptionByStripeId(customer) : subscriptionId ? await tenancyStore.findSubscriptionByStripeId(subscriptionId) : null;
      if (existing) {
        const statuses: Record<string, 'pending' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete'> = {
          active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'unpaid', incomplete: 'incomplete',
        };
        const status = statuses[String(object?.status)] ?? (event.type === 'customer.subscription.deleted' ? 'canceled' : existing.status);
        await tenancyStore.updateSubscription(existing.accountId, {
          status, ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(typeof object?.current_period_end === 'number' ? { currentPeriodEnd: new Date(object.current_period_end * 1000) } : {}),
        });
      }
      response.json({ received: true });
    } catch {
      response.status(400).json({ error: 'Invalid Stripe webhook.' });
    }
  });

  app.get('/auth/session', principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      response.json({ userId: session.userId, accountId: session.accountId, credential: 'session', session: presentSession(session, session) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/auth/session', principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      await revokeSession(session.userId, session.id);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.get('/auth/sessions', principal, async (request, response, next) => {
    try {
      const current = currentSession(request)!;
      response.json((await auth.list(current.userId)).map((session) => presentSession(session, current)));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/auth/sessions/:id', principal, async (request, response, next) => {
    try {
      if (!(await revokeSession(currentSession(request)!.userId, String(request.params.id)))) throw new HttpError(404, 'Session not found');
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /** Switch this session to another account the user belongs to. The membership is checked here and on every later request. */
  app.post('/auth/session/account', principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      const accountId = typeof request.body?.accountId === 'string' ? request.body.accountId : '';
      const context = await tenancy.resolveContext(session.userId, accountId, session.id);
      if (!context) throw new HttpError(404, 'Account not found');
      const switched = await auth.switchAccount(session, accountId);
      await retireSessionDevices(session.userId, session.id, accountId);
      await tenancy.audit(accountId, 'session.account_switched', { sessionId: session.id }, session.userId);
      response.json(await describeMe(switched));
    } catch (error) {
      next(error);
    }
  });

  app.get('/me', principal, async (request, response, next) => {
    try {
      response.json(await describeMe(currentSession(request)!));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/me', principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      await tenancy.updateProfile(session.userId, { name: request.body?.name });
      response.json(await describeMe(session));
    } catch (error) {
      next(error);
    }
  });

  /** Another account for the same user (its own line, devices and data). The session switches to it. */
  app.post('/accounts', principal, async (request, response, next) => {
    try {
      const session = currentSession(request)!;
      const name = typeof request.body?.name === 'string' ? request.body.name : '';
      const { account } = await tenancy.createAccount(session.userId, name);
      const switched = await auth.switchAccount(session, account.id);
      await retireSessionDevices(session.userId, session.id, account.id);
      response.status(201).json(await describeMe(switched));
    } catch (error) {
      next(error);
    }
  });

  app.get('/account', tenant('account.read'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const [account, plane, subscription, onboarding] = await Promise.all([
        tenancy.getAccount(context.accountId), tenancy.getPlane(context.accountId),
        tenancy.getSubscription(context.accountId), tenancy.refreshOnboarding(context.accountId),
      ]);
      response.json({
        id: account!.id, name: account!.name, role: context.role, onboarding,
        plane: plane ? { id: plane.id, name: plane.name, status: plane.status } : null,
        subscription: subscription ? { plan: subscription.plan, status: subscription.status, entitlements: subscription.entitlements } : null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/onboarding', tenant('account.read'), async (request, response, next) => {
    try {
      response.json(await tenancy.refreshOnboarding(accountOf(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/onboarding/identity', tenant('account.manage'), async (request, response, next) => {
    try {
      response.json(await tenancy.configureIdentity(tenantOf(request), { name: request.body?.name, accountName: request.body?.accountName }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/onboarding/phone-choice', tenant('phone.manage'), async (request, response, next) => {
    try {
      response.json(await tenancy.configurePhoneChoice(tenantOf(request), { choice: request.body?.choice }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/members', tenant('account.read'), async (request, response, next) => {
    try {
      response.json(await tenancy.members(accountOf(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/members', tenant('members.manage'), async (request, response, next) => {
    try {
      const membership = await tenancy.addMember(tenantOf(request), { email: request.body?.email, role: request.body?.role });
      response.status(201).json({ userId: membership.userId, role: membership.role });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/account/members/:userId', tenant('members.manage'), async (request, response, next) => {
    try {
      await tenancy.removeMember(tenantOf(request), String(request.params.userId));
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/audit', tenant('account.manage'), async (request, response, next) => {
    try {
      response.json((await tenancy.listAudit(accountOf(request), 100)).map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })));
    } catch (error) {
      next(error);
    }
  });

  /** The account's numbers: its assistant line and the owner's verified personal number. */
  const describePhone = async (accountId: string) => {
    const status = await phoneNumbers.status(accountId);
    // Forwarding is proven by a real forwarded call to this account, not assumed from a setting.
    const forwarded = (await service.listConversations(accountId))
      .flatMap((conversation) => conversation.events.filter((event) => event.type === 'call.forwarded'))
      .map((event) => event.occurredAt.getTime())
      .sort((left, right) => right - left);
    const verified = status.personal && (status.personal.status === 'verified' || status.personal.status === 'active');
    return {
      available: true,
      assistantLine: status.assistantLine?.number ?? null,
      phoneNumber: status.assistantLine?.number ?? null,
      ownerNumber: verified ? status.personal!.number : null,
      found: Boolean(status.assistantLine),
      connected: status.connected,
      forwarding: status.forwarding,
      verificationChannels: phoneNumbers.verificationChannels(),
      ...(status.error ? { error: status.error } : {}),
      numbers: { assistantLine: presentPhone(status.assistantLine), personal: presentPhone(status.personal) },
      forwardingSeen: forwarded.length > 0,
      lastForwardedAt: forwarded.length ? new Date(forwarded[0]).toISOString() : null,
    };
  };

  app.get(['/account/phone', '/owner/phone'], tenant('account.read'), async (request, response, next) => {
    try {
      response.json(await describePhone(accountOf(request)));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(502, 'Couldn’t reach your phone provider. Try again in a moment.'));
    }
  });

  /** Claim this account's assistant line from the platform's pool (idempotent). */
  app.post('/account/phone/line', tenant('phone.manage'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const subscription = await tenancy.getSubscription(context.accountId);
      await phoneNumbers.claimAssistantLine(context.accountId, subscription?.entitlements.maxAssistantLines ?? 0, context.userId);
      await tenancy.refreshOnboarding(context.accountId);
      response.json(await describePhone(context.accountId));
    } catch (error) {
      next(error);
    }
  });

  app.post(['/account/phone/connect', '/owner/phone/connect'], tenant('phone.manage'), async (request, response, next) => {
    try {
      const result = await phoneNumbers.connect(accountOf(request));
      await tenancy.refreshOnboarding(accountOf(request));
      response.json(result);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(502, error instanceof Error ? error.message : 'Couldn’t connect your number'));
    }
  });

  const testCallLimit = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  app.post(['/account/phone/test-call', '/owner/phone/test-call'], testCallLimit, tenant('phone.manage'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const call = await phoneNumbers.placeTestCall(context.accountId, context.userId);
      response.status(202).json(call);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(502, error instanceof Error ? error.message : 'Couldn’t place the test call'));
    }
  });

  const verificationLimit = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
  /** Start verifying the owner's personal number: a code is texted to it from the account's own line. */
  app.post('/account/phone/personal', verificationLimit, tenant('phone.manage'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const number = typeof request.body?.number === 'string' ? request.body.number : '';
      const channel = request.body?.channel === 'call' ? 'call' : 'sms';
      const record = await phoneNumbers.startPersonalVerification(context.accountId, number, context.userId, channel);
      response.status(202).json({ personal: presentPhone(record) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/account/phone/personal/verify', tenant('phone.manage'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      await phoneNumbers.confirmPersonalVerification(context.accountId, String(request.body?.code ?? ''), context.userId);
      await tenancy.refreshOnboarding(context.accountId);
      response.json(await describePhone(context.accountId));
    } catch (error) {
      next(error);
    }
  });

  /** Onboarding: create (or rename) the plane — the assistant that answers this account's line. */
  app.post('/account/plane', tenant('account.manage'), async (request, response, next) => {
    try {
      const plane = await tenancy.configurePlane(tenantOf(request), { name: request.body?.name, behavior: request.body?.behavior });
      response.json({ id: plane.id, name: plane.name, status: plane.status, onboarding: await tenancy.onboarding(plane.accountId) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/account/notifications', tenant('account.read'), async (request, response, next) => {
    try {
      response.json(await channels.list(accountOf(request)));
    } catch (error) {
      next(error);
    }
  });

  /** Opt in (or out) of texts to the account's verified personal number. */
  app.post('/account/notifications/sms', tenant('settings.manage'), async (request, response, next) => {
    try {
      const accountId = accountOf(request);
      const enabled = request.body?.enabled !== false;
      if (enabled && !(await phoneNumbers.personalNumber(accountId))) {
        throw new HttpError(409, 'Verify your number first.', 'no_verified_number');
      }
      await ownerConfiguration.update(accountId, { messages: { smsEnabled: enabled } }, 'web');
      await tenancy.refreshOnboarding(accountId);
      response.json(await channels.list(accountId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/owner/me', tenant('account.read'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const [configuration, user] = await Promise.all([ownerConfiguration.get(context.accountId), tenancy.getUser(context.userId)]);
      const session = currentSession(request);
      response.json({
        accountId: context.accountId, userId: context.userId, role: context.role,
        name: configuration.assistant.ownerName, user: user ? presentUser(user) : null,
        session: session ? presentSession(session, session) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * One snapshot to bootstrap any surface, after authentication: who you are,
   * the active account and its setup state, the plane (the assistant answering
   * the account's line) and its status, what's live, and what needs you. Live
   * updates then arrive on /owner/events; after any event, re-read this.
   */
  app.get('/owner/control-plane', tenant('account.read'), async (request, response, next) => {
    try {
      const context = tenantOf(request);
      const accountId = context.accountId;
      const [configuration, account, planeRecord, user, onboarding, lines] = await Promise.all([
        ownerConfiguration.get(accountId), tenancy.getAccount(accountId), tenancy.getPlane(accountId),
        tenancy.getUser(context.userId), tenancy.refreshOnboarding(accountId), phoneNumbers.status(accountId),
      ]);
      const conversations = await service.listConversations(accountId);
      const summaries = await Promise.all(conversations.map(async (conversation) => ({
        ...presentConversationSummary(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
        voice: presentVoice(conversation),
      })));
      const live = summaries.filter((item) => item.voice.live ||
        ['active', 'paused', 'owner_needed', 'takeover', 'text_active'].includes(item.runtime.status));
      const open = (await attention.list(accountId, { open: true, limit: 50 })).map(presentAttention);
      const needsOwner = open.some((item) => item.priority === 'interrupt') || live.some((item) => item.runtime.status === 'owner_needed');
      const status = !planeRecord ? 'setup'
        : !configuration.calls.answerCalls ? 'offline'
          : needsOwner ? 'awaiting_attention'
            : live.length ? 'working' : 'online';
      const session = currentSession(request);
      response.json({
        owner: { id: accountId, name: configuration.assistant.ownerName },
        user: user ? presentUser(user) : null,
        account: { id: accountId, name: account?.name ?? '', role: context.role },
        onboarding,
        session: session ? presentSession(session, session) : null,
        plane: {
          id: planeRecord?.id ?? null,
          name: planeRecord?.name ?? null,
          status,
          answering: configuration.calls.answerCalls,
          assistantLine: lines.assistantLine?.status === 'active' ? lines.assistantLine.number : null,
          voice: { realtime: Boolean(realtimeVoice), model: realtimeVoice?.modelId ?? null },
          liveConversations: live.length,
          openAttention: open.length,
        },
        live,
        attention: open,
        configuration: { revision: configuration.revision },
        serverTime: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/owner/configuration', tenant('account.read'), async (request, response) => {
    response.json(await ownerConfiguration.get(accountOf(request)));
  });

  app.patch('/owner/configuration', tenant('settings.manage'), async (request, response, next) => {
    try {
      const { expectedRevision, ...patch } = (request.body ?? {}) as OwnerConfigurationPatch & { expectedRevision?: unknown };
      for (const key of Object.keys(patch)) {
        if (!['assistant', 'calls', 'messages', 'onboarding'].includes(key)) throw new HttpError(400, `Unknown settings section: ${key}`);
      }
      response.json(await ownerConfiguration.update(
        accountOf(request),
        patch as OwnerConfigurationPatch,
        'web',
        typeof expectedRevision === 'number' ? expectedRevision : undefined,
      ));
    } catch (error) {
      if (error instanceof ConfigurationConflictError) next(new HttpError(409, error.message));
      else next(error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : 'Invalid configuration'));
    }
  });

  // Who changed what, when (no message contents).
  app.get('/owner/configuration/events', tenant('account.read'), async (request, response, next) => {
    try {
      response.json((await ownerConfiguration.events(accountOf(request))).map((event) => ({
        ...event, occurredAt: event.occurredAt.toISOString(),
      })));
    } catch (error) {
      next(error);
    }
  });

  app.get('/owner/devices/:id/configuration', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const configuration = await ownerConfiguration.get(device.accountId);
      response.json({
        deviceId: device.id,
        accountId: device.accountId,
        revision: configuration.revision,
        // What the Mac executes; it never edits any of this.
        bridge: {
          messagesChannelEnabled: configuration.messages.macosMessagesEnabled,
          assistantChat: device.assistantChat,
          ownerIdentity: device.messagesIdentity?.address ?? null,
          needsChatDiscovery: !device.assistantChat,
          pendingProbe: device.probe && !device.probe.completedAt ? { id: device.probe.id } : null,
        },
        configuration,
      });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.get('/owner/devices', tenant('account.read'), async (request, response, next) => {
    try {
      const devices = await ownerDevices.list(accountOf(request));
      // Online = the bridge checked in recently; health itself is what the bridge measured on the Mac.
      response.json(devices.map((device) => ({
        ...device,
        online: device.status === 'active' && Boolean(device.lastSeenAt) && Date.now() - new Date(device.lastSeenAt!).getTime() < 120_000,
        ready: ownerDevices.isReady(device),
      })));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/:id/revoke', tenant('device.manage'), async (request, response, next) => {
    try {
      await ownerDevices.revoke(
        accountOf(request),
        String(request.params.id),
      );
      await ownerConfiguration.recordChange(accountOf(request), 'device.revoked').catch(() => undefined);
      response.status(204).send();
    } catch (error) {
      next(new HttpError(404, error instanceof Error ? error.message : 'Device not found'));
    }
  });

  app.post('/owner/devices/:id/primary', tenant('device.manage'), async (request, response, next) => {
    try {
      const device = await ownerDevices.setPrimary(
        accountOf(request),
        String(request.params.id),
      );
      response.json(device);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Device cannot be primary'));
    }
  });

  const runtimeInput = (request: Request) => ({
    commandId: typeof request.body?.commandId === 'string' ? request.body.commandId : undefined,
    expectedRevision: typeof request.body?.expectedRevision === 'number'
      ? request.body.expectedRevision
      : undefined,
  });

  const runtimeOwner = (request: Request) => accountOf(request);

  app.get('/conversations/:id/runtime', tenant('conversation.read'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.getRuntime(String(request.params.id), accountOf(request))));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id/runtime/events', tenant('conversation.read'), async (request, response, next) => {
    try {
      const snapshot = await runtime.getRuntime(String(request.params.id), accountOf(request));
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();
      response.write(`event: runtime.state_changed\n`);
      response.write(`data: ${JSON.stringify({ runtime: presentRuntime(snapshot) })}\n\n`);
      const unsubscribe = runtime.subscribe(String(request.params.id), (event) => {
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        })}\n\n`);
      });
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/start', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.start(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/stop', tenant('conversation.control'), async (request, response, next) => {
    try {
      const conversation = await service.requireOwnedConversation(String(request.params.id), accountOf(request));
      const stopped = await runtime.stop(conversation.id, accountOf(request), runtimeInput(request));
      if (conversation.status !== 'completed') {
        // Hang up through the call capability, as this member: the provider is asked once, however often Stop is pressed.
        const callSession = await callSessions.findByConversation(conversation.accountId, conversation.id)
          ?? await callSessions.adoptConversation(conversation);
        if (callSession) {
          await new CallCapabilityClient(callApplication, appPortSessionFor(tenantOf(request)))
            .end({ callId: callSession.id, reason: 'owner_stopped' }, { idempotencyKey: `owner-stop:${conversation.id}`, traceId: requestTraceId(request) });
        }
      }
      response.json(presentRuntime(stopped));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/pause', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.pause(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/resume', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.resume(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/takeover', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.takeOver(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/return-to-assistant', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.returnToAssistant(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/interrupt', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.interrupt(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/transition-to-sms', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.transitionToSms(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  // adjust_interaction: one command, one revision, this conversation only.
  app.patch('/conversations/:id/runtime', tenant('conversation.control'), async (request, response, next) => {
    try {
      const patch = { ...(request.body ?? {}) } as Record<string, unknown>;
      const expiresAt = patch.expiresAt;
      if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(new Date(expiresAt).getTime()))) {
        throw new HttpError(400, 'expiresAt must be a valid date');
      }
      for (const key of ['commandId', 'expectedRevision', 'expiresAt']) delete patch[key];
      const conversationId = String(request.params.id);
      const conversation = await service.getConversation(conversationId);
      const snapshot = await runtime.adjust(conversationId, accountOf(request), patch as Parameters<RuntimeControlService['adjust']>[2],
        runtimeInput(request), typeof expiresAt === 'string' ? new Date(expiresAt) : undefined);
      response.json(presentRuntime(snapshot, conversation ?? undefined));
    } catch (error) {
      next(error);
    }
  });

  // Reset this conversation to the owner's defaults.
  app.delete('/conversations/:id/runtime/overrides', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.resetOverrides(String(request.params.id), accountOf(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/conversations/:id/runtime/overrides/:field', tenant('conversation.control'), async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.clearTemporaryOverride(
        String(request.params.id),
        accountOf(request),
        String(request.params.field) as Parameters<RuntimeControlService['clearTemporaryOverride']>[2],
        runtimeInput(request),
      )));
    } catch (error) {
      next(error);
    }
  });

  const presentCommand = (command: RuntimeCommand) => ({
    ...command,
    createdAt: command.createdAt.toISOString(),
    processedAt: command.processedAt?.toISOString() ?? null,
    appliedLiveAt: command.appliedLiveAt?.toISOString() ?? null,
  });

  app.get('/conversations/:id/runtime/commands', tenant('conversation.read'), async (request, response, next) => {
    try {
      response.json((await runtime.listCommands(String(request.params.id), accountOf(request))).map(presentCommand));
    } catch (error) {
      next(error);
    }
  });

  // One ordered timeline with every identifier, so a journey can be reconstructed
  // end to end: caller turn -> transcript -> AI response -> command -> owner reply -> SMS.
  app.get('/conversations/:id/audit', tenant('conversation.read'), async (request, response, next) => {
    try {
      const conversationId = String(request.params.id);
      const conversation = await service.requireOwnedConversation(conversationId, accountOf(request));
      const [runtimeEvents, commands, snapshot, attentionItems, notifications] = await Promise.all([
        runtime.listEvents(conversationId, accountOf(request)),
        runtime.listCommands(conversationId, accountOf(request)),
        runtime.getRuntimeForConversation(conversation),
        attention.list(conversation.accountId, { conversationId }),
        attention.deliveriesForConversation(conversationId),
      ]);
      const idKeys = ['callbackId', 'responseId', 'commandId', 'messageId', 'requestId', 'providerMessageId',
        'idempotencyKey', 'deliveryId', 'externalId', 'streamSid', 'callSid', 'callId', 'revision'] as const;
      const ids = (payload: Record<string, unknown>) => Object.fromEntries(idKeys
        .filter((key) => payload[key] !== undefined && payload[key] !== null)
        .map((key) => [key === 'callbackId' ? 'turnId' : key, payload[key]]));
      const timeline = [
        ...conversation.events.map((event) => ({
          at: event.occurredAt, source: 'conversation', type: event.type, eventId: event.id, ids: ids(event.payload),
          summary: typeof event.payload.text === 'string' ? event.payload.text
            : typeof event.payload.summary === 'string' ? event.payload.summary
              : typeof event.payload.question === 'string' ? event.payload.question : undefined,
        })),
        ...runtimeEvents.filter((event) => event.durable || event.type !== 'runtime.state_changed').map((event) => ({
          at: event.occurredAt, source: 'runtime', type: event.type, eventId: event.id, ids: ids(event.payload),
          summary: typeof event.payload.state === 'string' ? `state: ${event.payload.state}` : undefined,
        })),
        ...attentionItems.map((item) => ({
          at: item.createdAt, source: 'attention', type: `attention.${item.type}`, eventId: item.id,
          ids: { attentionId: item.id, ...(item.metadata.requestId ? { requestId: item.metadata.requestId } : {}), status: item.status },
          summary: item.title,
        })),
        ...notifications.map((delivery) => ({
          at: delivery.createdAt, source: 'notification', type: `notification.${delivery.status}`, eventId: delivery.id,
          ids: { notificationId: delivery.id, attentionId: delivery.attentionId, surface: delivery.surface,
            ...(delivery.deviceId ? { deviceId: delivery.deviceId } : {}), ...(delivery.providerId ? { providerId: delivery.providerId } : {}) },
          summary: delivery.error,
        })),
      ].sort((left, right) => left.at.getTime() - right.at.getTime())
        .map((entry) => ({ ...entry, at: entry.at.toISOString() }));
      response.json({
        conversationId,
        provider: conversation.provider,
        providerCallId: conversation.providerCallId,
        runtime: { conversationId, revision: snapshot.configurationRevision, state: snapshot.state },
        commands: commands.map(presentCommand),
        timeline,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations', tenant('conversation.read'), async (request, response, next) => {
    try {
      // Scoped in the query itself: another account's conversations are never loaded, let alone filtered out.
      let conversations = await service.listConversations(accountOf(request));
      if (typeof request.query.state === 'string') {
        conversations = conversations.filter((conversation) =>
          (conversation.state ?? 'voice_active') === request.query.state);
      }
      if (request.query.needsOwner === 'true') {
        conversations = conversations.filter((conversation) =>
          presentConversationSummary(conversation).needsOwner === true);
      }
      response.json(await Promise.all(conversations.map(async (conversation) => ({
        ...presentConversationSummary(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
        voice: presentVoice(conversation),
      }))));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id', tenant('conversation.read'), async (request, response, next) => {
    try {
      const accountId = accountOf(request);
      const conversation = await service.requireOwnedConversation(String(request.params.id), accountId);
      await service.markOwnerRead(conversation.id, accountId);
      const refreshed = await service.getConversation(conversation.id);
      response.json({
        ...presentConversation(refreshed!),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(refreshed!), refreshed!),
        voice: presentVoice(refreshed!),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/messages', tenant('conversation.control'), async (request, response, next) => {
    try {
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      if (!body || body.length > 2000) throw new HttpError(400, 'Message body must be between 1 and 2000 characters');
      const before = await service.requireOwnedConversation(String(request.params.id), accountOf(request));
      const key = typeof request.body?.idempotencyKey === 'string' && request.body.idempotencyKey.trim()
        ? request.body.idempotencyKey.trim()
        : `web:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const conversation = await ownerReplies.reply({
        conversationId: String(request.params.id),
        accountId: accountOf(request),
        body,
        idempotencyKey: key,
        source: 'web',
      });
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
        voice: presentVoice(conversation),
        ownerReply: {
          delivery: realtimeVoiceStatus(before).live ? 'spoken'
            : before.events.some((event) => event.type === 'sms.consent.granted') ? 'texted'
            : before.status === 'completed' ? 'recorded_after_call' : 'queued_for_voice',
        },
      });
    } catch (error) {
      next(error);
    }
  });

  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', staticAssetRateLimit, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile('index.html', { root: publicDir }, next);
  });
  for (const path of ['/signup', '/signin', '/checkout', '/setup', '/app', '/billing']) {
    app.get(path, staticAssetRateLimit, (_request, response, next) => {
      response.setHeader('Cache-Control', 'no-cache');
      response.sendFile('index.html', { root: publicDir }, next);
    });
  }
  // Deep link from a notification straight into one live conversation (the app loads it, no inbox step).
  app.get('/conversations/:id/live', staticAssetRateLimit, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile('index.html', { root: publicDir }, next);
  });
  app.get('/sw.js', staticAssetRateLimit, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Service-Worker-Allowed', '/');
    response.type('application/javascript').sendFile('sw.js', { root: publicDir }, next);
  });
  app.get(/^\/icon-(180|192|512)\.png$/, staticAssetRateLimit, (request, response, next) => {
    response.sendFile(request.path.slice(1), { root: publicDir }, next);
  });
  app.get('/manifest.webmanifest', staticAssetRateLimit, (_request, response, next) => {
    response.type('application/manifest+json').sendFile('manifest.webmanifest', { root: publicDir }, next);
  });
  app.get('/icon.svg', staticAssetRateLimit, (_request, response, next) => {
    response.sendFile('icon.svg', { root: publicDir }, next);
  });

  // The scripted (non-realtime) call pipeline: owner-authenticated, and only on the owner's own conversations.
  app.post('/conversations/:id/turns', tenant('conversation.control'), async (request, response, next) => {
    try {
      await service.requireOwnedConversation(String(request.params.id), accountOf(request));
      const callbackId =
        typeof request.body?.callbackId === 'string'
          ? request.body.callbackId
          : undefined;
      if (!callbackId) {
        throw new HttpError(400, 'Missing required field: callbackId');
      }
      const conversation = await engine.respond(String(request.params.id), {
        callbackId,
        audio: request.body?.audio,
      });
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/convert-to-text', tenant('conversation.control'), async (request, response, next) => {
    try {
      await service.requireOwnedConversation(String(request.params.id), accountOf(request));
      const conversation = await service.convertToTextConversation(String(request.params.id));
      await runtime.finalizeSmsTransition(conversation.id);
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/sms-consent', tenant('conversation.control'), async (request, response, next) => {
    try {
      await service.requireOwnedConversation(String(request.params.id), accountOf(request));
      const phone = request.body?.phoneNumber ?? request.body?.phone;
      if (typeof phone !== 'string' || !phone.trim()) {
        throw new HttpError(400, 'Missing required field: phoneNumber');
      }
      const conversation = await service.grantSmsConsent(
        String(request.params.id),
        phone,
        typeof request.body?.displayName === 'string' ? request.body.displayName : undefined,
      );
      const beforeFinalize = await runtime.getRuntimeForConversation(conversation);
      const finalizedConversation = beforeFinalize.state === 'transferring'
        ? await service.convertToTextConversation(conversation.id)
        : conversation;
      const runtimeSnapshot = beforeFinalize.state === 'transferring'
        ? await runtime.finalizeSmsTransition(finalizedConversation.id)
        : await runtime.getRuntimeForConversation(finalizedConversation);
      response.json({
        ...presentConversation(finalizedConversation),
        runtime: presentRuntime(runtimeSnapshot),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
        return;
      }

      console.error('[http] request failed', JSON.stringify({
        requestId: _request.header('x-vercel-id') ?? _request.header('x-request-id') ?? null,
        method: _request.method,
        path: _request.path,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
      }));
      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
