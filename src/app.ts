import express, { type NextFunction, type Request, type Response } from 'express';

import { HttpError } from './errors.js';
import { presentConversation, presentConversationSummary } from './http/presenters.js';
import type { ConversationRepository } from './repositories/conversation-repository.js';
import { ConversationService } from './services/conversation-service.js';
import { FakeTelephonyProvider } from './telephony/fake-provider.js';
import type { TelephonyProvider } from './telephony/provider.js';
import { TwilioProvider } from './telephony/twilio-provider.js';
import { FakeConversationModel } from './conversation/fake-model.js';
import type { ConversationModel } from './conversation/model.js';
import { ConversationEngine } from './services/conversation-engine.js';
import { FakeSpeechProvider } from './speech/fake-provider.js';
import type { SpeechProvider } from './speech/provider.js';
import { FakeVoiceProvider } from './voice/fake-provider.js';
import type { VoiceProvider } from './voice/provider.js';
import type { MessagingProvider } from './messaging/provider.js';
import { FakeMessagingProvider } from './messaging/fake-provider.js';
import twilio from 'twilio';

export interface AppOptions {
  repository: ConversationRepository;
  providers?: TelephonyProvider[];
  includeFakeProviderRoutes?: boolean;
  speechProvider?: SpeechProvider;
  conversationModel?: ConversationModel;
  voiceProvider?: VoiceProvider;
  messagingProvider?: MessagingProvider;
  ownerPhone?: string;
  twilioAuthToken?: string;
}

function createProviderMap(
  providers: TelephonyProvider[],
): Map<string, TelephonyProvider> {
  return new Map(providers.map((provider) => [provider.name, provider]));
}

function registerIncomingCallRoute(
  app: express.Express,
  path: string,
  provider: TelephonyProvider,
  service: ConversationService,
): void {
  app.post(path, async (request, response, next) => {
    try {
      const incomingCall = provider.parseIncomingCall(request.body);
      const conversation = await service.incomingCall(incomingCall);
      const providerResponse = provider.answerCall(conversation);
      await service.answerCall(conversation.id, incomingCall.payload);
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
): void {
  app.post(path, async (request, response, next) => {
    try {
      const statusUpdate = provider.parseStatusUpdate(request.body);
      const conversation = await service.updateCallStatus(statusUpdate);
      response.status(200).json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const providers = createProviderMap(
    options.providers ?? [new TwilioProvider(), new FakeTelephonyProvider()],
  );
  const messaging = options.messagingProvider ?? new FakeMessagingProvider();
  const service = new ConversationService(options.repository, messaging, options.ownerPhone);
  const engine = new ConversationEngine(
    options.repository,
    options.speechProvider ?? new FakeSpeechProvider(),
    options.conversationModel ?? new FakeConversationModel(),
    options.voiceProvider ?? new FakeVoiceProvider(),
    messaging,
  );
  const fakeRoutesEnabled = options.includeFakeProviderRoutes ?? true;

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  if (options.twilioAuthToken) {
    app.use((request, _response, next) => {
      if (!request.path.startsWith('/webhooks/twilio/')) return next();
      const signature = request.header('X-Twilio-Signature');
      const url = `${request.protocol}://${request.get('host')}${request.originalUrl}`;
      if (!signature || !twilio.validateRequest(options.twilioAuthToken!, signature, url, request.body)) {
        next(new HttpError(403, 'Invalid webhook signature'));
        return;
      }
      next();
    });
  }

  const twilioProvider = providers.get('twilio');
  if (!twilioProvider) {
    throw new Error('Twilio provider is required');
  }

  registerIncomingCallRoute(app, '/webhooks/twilio/voice', twilioProvider, service);
  registerStatusRoute(app, '/webhooks/twilio/status', twilioProvider, service);

  app.post('/webhooks/twilio/sms', async (request, response, next) => {
    try {
      if (!twilioProvider.parseIncomingSms) throw new HttpError(501, 'SMS is not supported');
      const message = twilioProvider.parseIncomingSms(request.body);
      const conversation = await service.receiveSms(message);
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });

  if (fakeRoutesEnabled) {
    const fake = providers.get('fake');
    if (fake) {
      registerIncomingCallRoute(app, '/webhooks/fake/voice', fake, service);
      registerStatusRoute(app, '/webhooks/fake/status', fake, service);
    }
  }

  app.get('/conversations', async (_request, response, next) => {
    try {
      const conversations = await service.listConversations();
      response.json(conversations.map(presentConversationSummary));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id', async (request, response, next) => {
    try {
      const conversation = await service.getConversation(request.params.id);

      if (!conversation) {
        throw new HttpError(404, 'Conversation not found');
      }

      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/turns', async (request, response, next) => {
    try {
      const callbackId =
        typeof request.body?.callbackId === 'string'
          ? request.body.callbackId
          : undefined;
      if (!callbackId) {
        throw new HttpError(400, 'Missing required field: callbackId');
      }
      const conversation = await engine.respond(request.params.id, {
        callbackId,
        audio: request.body?.audio,
      });

      app.post('/conversations/:id/convert-to-text', async (request, response, next) => {
        try {
          const conversation = await service.convertToTextConversation(request.params.id);
          response.json(presentConversation(conversation));
        } catch (error) {
          next(error);
        }
      });

      app.post('/conversations/:id/sms-consent', async (request, response, next) => {
        try {
          const phone = request.body?.phoneNumber ?? request.body?.phone;
          if (typeof phone !== 'string' || !phone.trim()) {
            throw new HttpError(400, 'Missing required field: phoneNumber');
          }
          const conversation = await service.grantSmsConsent(
            request.params.id,
            phone,
            typeof request.body?.displayName === 'string' ? request.body.displayName : undefined,
          );
          response.json(presentConversation(conversation));
        } catch (error) {
          next(error);
        }
      });
      response.json(presentConversation(conversation));
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
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
