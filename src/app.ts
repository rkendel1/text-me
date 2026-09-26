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
  ownerId?: string;
  ownerAuthToken?: string;
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
  const ownerId = options.ownerId ?? process.env.OWNER_ID ?? 'owner';
  const service = new ConversationService(options.repository, messaging, options.ownerPhone, ownerId);
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

  const ownerAuth = (request: Request, _response: Response, next: NextFunction): void => {
    if (!options.ownerAuthToken) {
      (request as Request & { ownerId?: string }).ownerId = ownerId;
      next();
      return;
    }
    const authorization = request.header('Authorization');
    if (authorization !== 'Bearer ' + options.ownerAuthToken) {
      next(new HttpError(401, 'Authentication required'));
      return;
    }
    (request as Request & { ownerId?: string }).ownerId = ownerId;
    next();
  };

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

  app.get('/conversations', ownerAuth, async (request, response, next) => {
    try {
      let conversations = await service.listConversations();
      conversations = conversations.filter((conversation) =>
        !conversation.ownerId || conversation.ownerId === (request as Request & { ownerId?: string }).ownerId);
      if (typeof request.query.state === 'string') {
        conversations = conversations.filter((conversation) =>
          (conversation.state ?? 'voice_active') === request.query.state);
      }
      if (request.query.needsOwner === 'true') {
        conversations = conversations.filter((conversation) =>
          presentConversationSummary(conversation).needsOwner === true);
      }
      response.json(conversations.map(presentConversationSummary));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id', ownerAuth, async (request, response, next) => {
    try {
      const authenticatedOwner = (request as Request & { ownerId?: string }).ownerId!;
      const conversation = options.ownerAuthToken
        ? await service.requireOwnedConversation(String(request.params.id), authenticatedOwner)
        : await service.getConversation(String(request.params.id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      if (options.ownerAuthToken) await service.markOwnerRead(conversation.id, authenticatedOwner);
      const refreshed = await service.getConversation(conversation.id);
      response.json(presentConversation(refreshed!));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/messages', ownerAuth, async (request, response, next) => {
    try {
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      if (!body || body.length > 2000) throw new HttpError(400, 'Message body must be between 1 and 2000 characters');
      if (options.ownerAuthToken) {
        await service.requireOwnedConversation(
          String(request.params.id),
          (request as Request & { ownerId?: string }).ownerId!,
        );
      } else if (!await service.getConversation(String(request.params.id))) {
        throw new HttpError(404, 'Conversation not found');
      }
      const key = typeof request.body?.idempotencyKey === 'string' && request.body.idempotencyKey.trim()
        ? request.body.idempotencyKey.trim()
        : `web:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const conversation = await engine.respondToOwner(String(request.params.id), body, key);
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_request, response) => {
    response.type('html').send(`<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conversations</title><style>
*{box-sizing:border-box}body{margin:0;font:16px system-ui;color:#17202a;background:#f5f7fa}
main{height:100vh;display:grid;grid-template-columns:minmax(240px,32%) 1fr;max-width:1100px;margin:auto;background:white}
aside{border-right:1px solid #dfe4ea;overflow:auto}h1,h2{font-size:1.15rem;margin:0;padding:1rem;border-bottom:1px solid #dfe4ea}
button{border:0;border-radius:6px;background:#1769aa;color:white;padding:.65rem 1rem;font-weight:600}
.item{display:block;width:100%;text-align:left;background:white;color:inherit;border-radius:0;border-bottom:1px solid #edf0f2;padding:1rem}
.item.active{background:#eaf4ff}.item strong,.item span{display:block}.item span{color:#59636e;font-size:.9rem;margin-top:.3rem}
#thread{display:flex;flex-direction:column;min-width:0}.messages{padding:1rem;overflow:auto;flex:1}.message{max-width:75%;padding:.7rem .9rem;margin:.6rem 0;border-radius:12px;background:#eef1f4}.message.owner{margin-left:auto;background:#d9f2d9}.message.assistant{margin-right:auto;background:#fff3cd}.role{font-size:.75rem;font-weight:700;color:#59636e}
form{display:flex;gap:.5rem;padding:1rem;border-top:1px solid #dfe4ea}input{flex:1;padding:.7rem;border:1px solid #c7ced6;border-radius:6px}
@media(max-width:650px){main{display:block}.detail{display:none}main.open aside{display:none}main.open .detail{display:flex;height:100vh}.detail h2{display:flex;justify-content:space-between}.back{display:block}aside h1{position:sticky;top:0;background:white}.item{padding:1.2rem 1rem}}
</style></head><body><main id="app"><aside><h1>Conversations</h1><div id="list">Loading…</div></aside><section class="detail" id="thread"><h2>Select a conversation</h2></section></main>
<script>
const app=document.querySelector('#app'),list=document.querySelector('#list'),thread=document.querySelector('#thread'),token=localStorage.getItem('ownerToken')||'';
const headers=token?{Authorization:'Bearer '+token}:{};
let selected;
async function loadList(){const r=await fetch('/conversations',{headers});if(r.status===401){list.textContent='Sign in to view conversations.';return}const data=await r.json();list.innerHTML='';data.forEach(c=>{const b=document.createElement('button');b.className='item';b.innerHTML='<strong>'+((c.participant&&c.participant.name)||c.caller)+'</strong><span>'+c.preview+'</span><span>'+(c.needsOwner?'● Needs your response':c.unread?'New activity':'')+'</span>';b.onclick=()=>loadConversation(c.id);list.appendChild(b)})}
async function loadConversation(id){selected=id;const r=await fetch('/conversations/'+id,{headers});if(!r.ok){thread.innerHTML='<h2>Conversation unavailable</h2>';return}const c=await r.json();app.classList.add('open');thread.innerHTML='<h2><button class="back" onclick="app.classList.remove(\\'open\\')">Back</button>'+((c.participants||[]).find(p=>p.role==='caller')||{}).displayName||c.caller+'</h2><div class="messages">'+(c.messages||[]).map(m=>'<div class="message '+m.role+'"><div class="role">'+(m.role==='owner'?'Randy':m.role[0].toUpperCase()+m.role.slice(1))+'</div>'+m.body+'</div>').join('')+'</div><form><input placeholder="Type a message…" required maxlength="2000"><button>Send</button></form>';thread.querySelector('form').onsubmit=sendMessage}
async function sendMessage(e){e.preventDefault();const input=e.target.querySelector('input'),button=e.target.querySelector('button');button.disabled=true;const r=await fetch('/conversations/'+selected+'/messages',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({body:input.value})});if(r.ok)loadConversation(selected);else alert('Could not deliver response. Please retry.');button.disabled=false}
loadList();setInterval(loadList,15000);
</script></body></html>`);
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
