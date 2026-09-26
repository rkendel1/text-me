import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { toDataURL } from 'qrcode';

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
import type { OwnerChannel } from './owner/channel.js';
import { OwnerDeviceService } from './owner/device.js';
import type { MacMessagesAdapter } from './owner/mac-messages-adapter.js';
import { OwnerConfigurationService, type OwnerConfigurationPatch } from './owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, type OwnerMessageDeliveryStore } from './owner/delivery.js';
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
  ownerChannel?: OwnerChannel;
  ownerDeviceService?: OwnerDeviceService;
  ownerMessagesAdapter?: MacMessagesAdapter;
  ownerConfigurationService?: OwnerConfigurationService;
  ownerDeliveryStore?: OwnerMessageDeliveryStore;
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
  const ownerDevices = options.ownerDeviceService ?? new OwnerDeviceService();
  const ownerConfiguration = options.ownerConfigurationService ?? new OwnerConfigurationService();
  const ownerDeliveries = options.ownerDeliveryStore ?? new InMemoryOwnerMessageDeliveryStore();
  const ownerDeviceRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const service = new ConversationService(
    options.repository, messaging, options.ownerPhone, ownerId, options.ownerChannel,
  );
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

  app.post('/owner/devices/pair', ownerAuth, async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        (request as Request & { ownerId?: string }).ownerId!,
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
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

  app.post('/owner/devices/pair/qr', ownerAuth, async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        (request as Request & { ownerId?: string }).ownerId!,
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
      );
      response.status(201).json({
        deviceId: result.device.id,
        pairingUri: result.pairingUri,
        qrDataUrl: await toDataURL(result.pairingUri, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 256,
        }),
        expiresAt: result.expiresAt.toISOString(),
      });
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
    const authorization = request.header('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const device = await ownerDevices.authenticate(token);
    if (!device || device.id !== String(request.params.id)) throw new HttpError(401, 'Device authentication required');
    return { device, token };
  };

  app.get('/owner/devices/:id/status', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json(device);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.post('/owner/devices/:id/heartbeat', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      if (!options.ownerMessagesAdapter?.checkCapabilities) throw new HttpError(501, 'Messages capability checks are unavailable');
      response.json(await ownerDevices.heartbeat(
        token,
        await options.ownerMessagesAdapter.checkCapabilities(),
      ));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Device authentication required'));
    }
  });

  app.get('/owner/devices/:id/messages/chats', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      if (!options.ownerMessagesAdapter) throw new HttpError(501, 'Messages chat discovery is unavailable');
      const chats = await ownerDevices.discoverChats(token, options.ownerMessagesAdapter);
      response.json(chats.map(({ id, service, displayName, address }) => ({ id, service, displayName, address })));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Chat discovery failed'));
    }
  });

  app.post('/owner/devices/:id/messages/chat', ownerDeviceRateLimit, ownerAuth, async (request, response, next) => {
    try {
      const service = request.body?.service;
      const chatId = request.body?.chatId;
      if ((service !== 'imessage' && service !== 'sms') || typeof chatId !== 'string' || !chatId.trim()) {
        throw new HttpError(400, 'chatId and service are required');
      }
      response.json(await ownerDevices.authorizeChat(
        (request as Request & { ownerId?: string }).ownerId!, String(request.params.id), chatId, service,
      ));
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
      const delivery = await ownerDeliveries.claimReplyTarget(device.id, externalId);
      if (!delivery) throw new HttpError(409, 'No owner delivery is awaiting a reply');
      await options.repository.appendEvent(delivery.conversationId, 'owner.message.received', {
        deliveryId: delivery.id,
        externalId,
        body,
        source: 'macos_messages',
      }, new Date());
      const conversation = await engine.respondToOwner(
        delivery.conversationId,
        body,
        `macos:${device.id}:${externalId}`,
        'macos_messages',
      );
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Owner reply failed'));
    }
  });

  app.get('/owner/configuration', ownerAuth, async (request, response) => {
    response.json(await ownerConfiguration.get((request as Request & { ownerId?: string }).ownerId!));
  });

  app.patch('/owner/configuration', ownerAuth, async (request, response, next) => {
    try {
      response.json(await ownerConfiguration.update(
        (request as Request & { ownerId?: string }).ownerId!,
        request.body as OwnerConfigurationPatch,
      ));
    } catch (error) {
      next(new HttpError(400, error instanceof Error ? error.message : 'Invalid configuration'));
    }
  });

  app.get('/owner/devices/:id/configuration', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json({
        deviceId: device.id,
        ownerId: device.ownerId,
        configuration: await ownerConfiguration.get(device.ownerId),
      });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.get('/owner/devices', ownerAuth, async (request, response, next) => {
    try {
      const devices = await ownerDevices.list((request as Request & { ownerId?: string }).ownerId!);
      response.json(devices);
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/:id/revoke', ownerAuth, async (request, response, next) => {
    try {
      await ownerDevices.revoke(
        (request as Request & { ownerId?: string }).ownerId!,
        String(request.params.id),
      );
      response.status(204).send();
    } catch (error) {
      next(new HttpError(404, error instanceof Error ? error.message : 'Device not found'));
    }
  });

  app.post('/owner/devices/:id/primary', ownerAuth, async (request, response, next) => {
    try {
      const device = await ownerDevices.setPrimary(
        (request as Request & { ownerId?: string }).ownerId!,
        String(request.params.id),
      );
      response.json(device);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Device cannot be primary'));
    }
  });

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
main{height:100vh;display:grid;grid-template-columns:minmax(260px,34%) 1fr;max-width:1180px;margin:auto;background:white}
aside{border-right:1px solid #dfe4ea;overflow:auto}h1,h2{font-size:1.15rem;margin:0;padding:1rem;border-bottom:1px solid #dfe4ea}
button{border:0;border-radius:6px;background:#1769aa;color:white;padding:.65rem 1rem;font-weight:600;cursor:pointer}
button.secondary{background:#eef3f8;color:#17202a}.controls{display:grid;gap:.75rem;padding:1rem;border-bottom:1px solid #dfe4ea}.pairing{padding:0 1rem 1rem}.pairing img{max-width:100%;border:1px solid #dfe4ea;border-radius:10px;background:white}.pairing code{display:block;word-break:break-all;font-size:.8rem;color:#59636e}.item{display:block;width:100%;text-align:left;background:white;color:inherit;border-radius:0;border-bottom:1px solid #edf0f2;padding:1rem}
.item.active{background:#eaf4ff}.item strong,.item span{display:block}.item span{color:#59636e;font-size:.9rem;margin-top:.3rem}
#thread{display:flex;flex-direction:column;min-width:0}.messages{padding:1rem;overflow:auto;flex:1}.message{max-width:75%;padding:.7rem .9rem;margin:.6rem 0;border-radius:12px;background:#eef1f4}.message.owner{margin-left:auto;background:#d9f2d9}.message.assistant{margin-right:auto;background:#fff3cd}.role{font-size:.75rem;font-weight:700;color:#59636e}
form{display:flex;gap:.5rem;padding:1rem;border-top:1px solid #dfe4ea}input{flex:1;padding:.7rem;border:1px solid #c7ced6;border-radius:6px}
@media(max-width:650px){main{display:block}.detail{display:none}main.open aside{display:none}main.open .detail{display:flex;height:100vh}.detail h2{display:flex;justify-content:space-between}.back{display:block}}
</style></head><body><main id="app"><aside><h1>Conversations</h1><div class="controls"><button id="pairButton">Pair Mac Messages</button><button class="secondary" id="devicesButton">Connected Devices</button></div><div class="pairing" id="pairing"></div><div id="devices"></div><div id="list">Loading…</div></aside><section class="detail" id="thread"><h2>Select a conversation</h2></section></main>
<script>
const app=document.querySelector('#app'),list=document.querySelector('#list'),thread=document.querySelector('#thread'),pairing=document.querySelector('#pairing'),token=localStorage.getItem('ownerToken')||'';
const headers=token?{Authorization:'Bearer '+token}:{},jsonHeaders={...headers,'Content-Type':'application/json'};let selected;
async function loadList(){const r=await fetch('/conversations',{headers});if(r.status===401){list.textContent='Sign in to view conversations.';return}const data=await r.json();list.innerHTML='';data.forEach(c=>{const b=document.createElement('button');b.className='item';b.innerHTML='<strong>'+((c.participant&&c.participant.name)||c.caller)+'</strong><span>'+c.preview+'</span><span>'+(c.needsOwner?'● Needs your response':c.unread?'New activity':'')+'</span>';b.onclick=()=>loadConversation(c.id);list.appendChild(b)})}
async function loadConversation(id){selected=id;const r=await fetch('/conversations/'+id,{headers});if(!r.ok){thread.innerHTML='<h2>Conversation unavailable</h2>';return}const c=await r.json();app.classList.add('open');thread.innerHTML='<h2><button class="back" onclick="app.classList.remove(\\'open\\')">Back</button>'+((((c.participants||[]).find(p=>p.role==='caller')||{}).displayName)||c.caller)+'</h2><div class="messages">'+(c.messages||[]).map(m=>'<div class="message '+m.role+'"><div class="role">'+(m.role==='owner'?'Randy':m.role[0].toUpperCase()+m.role.slice(1))+'</div>'+m.body+'</div>').join('')+'</div><form><input placeholder="Type a message…" required maxlength="2000"><button>Send</button></form>';thread.querySelector('form').onsubmit=sendMessage}
async function sendMessage(e){e.preventDefault();const input=e.target.querySelector('input'),button=e.target.querySelector('button');button.disabled=true;const r=await fetch('/conversations/'+selected+'/messages',{method:'POST',headers:jsonHeaders,body:JSON.stringify({body:input.value})});if(r.ok)loadConversation(selected);else alert('Could not deliver response. Please retry.');button.disabled=false}
async function loadDevices(){const r=await fetch('/owner/devices',{headers});if(!r.ok)return;const data=await r.json();document.querySelector('#devices').innerHTML=data.map(d=>'<div class="item"><strong>'+d.name+'</strong><span>'+(d.status==='active'?'Connected ✓':d.status)+'</span><span>Messages '+(d.health?.messagesAccess?'✓':'—')+' · Chat '+(d.health?.authorizedChat?'✓':'—')+' · '+d.setupStatus+'</span></div>').join('')}
async function pairDevice(){pairing.innerHTML='Generating QR…';const r=await fetch('/owner/devices/pair/qr',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'Mac Messages'})});if(r.status===401){pairing.textContent='Sign in to pair a Mac.';return}if(!r.ok){pairing.textContent='Could not create pairing QR.';return}const data=await r.json();pairing.innerHTML='<p>Scan this QR from the Mac bridge to pair this device.</p><img alt="Mac pairing QR" src="'+data.qrDataUrl+'"><p>Expires: '+new Date(data.expiresAt).toLocaleString()+'</p><code>'+data.pairingUri+'</code>'}
document.querySelector('#pairButton').onclick=pairDevice;document.querySelector('#devicesButton').onclick=loadDevices;loadList();loadDevices();setInterval(loadList,15000);setInterval(loadDevices,15000);
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
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
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
