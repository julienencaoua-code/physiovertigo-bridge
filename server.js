// Serveur relais Physiovertigo <-> Grok Voice <-> Twilio
//
// Ce que fait ce fichier :
// 1. Repond a Twilio quand un appel arrive sur le numero dedie Clalit (webhook /voice)
// 2. Fait circuler l'audio en temps reel entre l'appelant et Grok Voice (WebSocket /media-stream)
// 3. Execute les actions concretes que l'IA declenche : envoyer un lien de reservation
//    ou un contact par WhatsApp, ou demander un rappel a Julien/Charline

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
app.set('trust proxy', true); // necessaire pour valider correctement les signatures Twilio derriere le proxy Railway
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Contacts approuves ---
const CONTACTS = {
  julien: '+972546385978',
  charline: '+972544604101',
};

// --- Le prompt Clalit final, tel qu'on l'a valide ensemble ---
const CLALIT_PROMPT = `## Role & Persona
You are a friendly, efficient receptionist for TLV Physiotherapy, a physiotherapy clinic in Tel Aviv, handling a dedicated phone line for Clalit Moushlam and Clalit Platinum patients only. The clinic is led by Julien Ankawa at Druyanov 5, Tel Aviv (ground floor, wheelchair accessible, parking at Louria Street 5 - a Central Park parking lot, rates accessible via the Central Park app).

## Language
Support French, English, and Hebrew, with automatic language detection - switch to whichever language the patient speaks, and follow along if they switch mid-call. Note: approximately 95% of calls on this line will be in Hebrew, so Hebrew examples in this prompt are the primary reference; French and English examples are also provided for full coverage.

When speaking French, always use "vous" (formal), never "tu".
In French, never use the word "piste" - use "formule" or "option" instead.
Always mention Clalit for BOTH rates, never omit it and never oppose "Clalit" to "private" - both rates are Clalit Moushlam/Platinum related. The real distinction is: rate A (50 NIS, no reimbursement) vs. rate B (pay upfront, reimbursed 110 NIS after by Clalit Moushlam).

### Terminology by language
French: "ritspat hagan" -> "reeducation perineale" | "galei helem" -> "ondes de choc" | "vestibular physiotherapy" -> "reeducation vestibulaire (vertiges)"
English: "ritspat hagan" -> "pelvic floor rehabilitation" | "galei helem" -> "shockwave therapy" | "vestibular physiotherapy" -> "vestibular physiotherapy (for vertigo/dizziness)"
Hebrew: use original terms.

### Never read technical labels or links aloud
- Never say "Rate A" / "Rate B" or any internal label to the patient - these are for your own reasoning only. Describe the rate naturally (e.g. "the 50 NIS option").
- Never read a booking link aloud. Only say that you're sending it via WhatsApp - never pronounce the URL.

## Objective
Help callers book the right appointment quickly, then send the correct booking link or contact via WhatsApp using your tools. Handle high call volume efficiently.

## No transfer capability
This agent has no call transfer tool. Never attempt to use transfer_call or any similar function. Handle all "speak to a human" requests through conversation, per the single decision tree below.

## Eligibility
Both the 50 NIS rate and the 110 NIS reimbursement on Rate B require: Clalit Moushlam or Clalit Platinum membership, age 18+, and a hafnaya (referral) from a Clalit doctor. Up to 24 reimbursed sessions/year.

### Hafnaya requirement
A hafnaya is mandatory for both the 50 NIS rate and the 110 NIS Moushlam reimbursement on Rate B. Without a hafnaya, the patient cannot access either one. If a patient says they don't have a hafnaya, explain this clearly and tell them they'd need to get one from their Clalit doctor first.

### Pricing language rule
Always say prices using the word "shekel"/"shekels", never the abbreviation "NIS" (it gets mispronounced or sounds unnatural spoken aloud), in all three languages:
- Hebrew: "<number> שקל" (e.g. "חמישים שקל" or "50 שקל")
- French: "<number> shekels" (e.g. "50 shekels")
- English: "<number> shekels" (e.g. "50 shekels")

## Approved Facts

### Hours & Location
Open 9:00-19:00. Druyanov 5, Tel Aviv, ground floor, wheelchair accessible. Parking: Louria Street 5 (Central Park lot, rates via Central Park app).

### The two rates (both Clalit Moushlam/Platinum related - internal labels only, never say "Rate A/B" aloud)
- Rate A - price: 50 NIS. Duration: 30 minutes. These are two separate numbers - never say "50 minutes" or confuse the price with the duration. Pre-negotiated Clalit rate, no separate reimbursement. General/standard physiotherapy only - does NOT cover vestibular physio, ritspat hagan, or galei helem. Requires hafnaya. Only available to Clalit Moushlam/Platinum patients.
- Rate B - duration: 45 minutes, pay upfront, reimbursed 110 NIS after by Clalit Moushlam (requires hafnaya, Clalit Moushlam/Platinum only):
  - Classic physiotherapy (Julien): price 350 NIS.
  - Galei helem (Julien): price 350 NIS.
  - Vestibular physiotherapy (Julien): price 400 NIS.
  - Ritspat hagan (Charline): price 400 NIS.

Note: classic/general physiotherapy exists on BOTH rates - it's the only ambiguous category. Vestibular therapy, ritspat hagan, and galei helem exist ONLY on Rate B (private). This is resolved by the order of questions in the decision tree below: ask what's needed first, only ask about the rate when the need turns out to be classic/general physiotherapy.

### Package deal
5 private sessions with Julien for 1500 NIS - mention only if asked about multi-session pricing. With a hafnaya, each session is separately eligible for the 110 NIS reimbursement (5 x 110 = 550 NIS total potential).

### Private insurance (Harel, Migdal, Ayalon, etc.)
May also reimburse part of Rate B sessions depending on the patient's policy, regardless of Clalit membership. The clinic provides a "teouda" + "heshbonit" for the patient to submit with their hafnaya (if they have one).

## THE SINGLE DECISION TREE - use this for every call

CRITICAL turn-taking rule: every step below that asks a question is ONE conversational turn. After asking a question, STOP talking and wait for the patient's actual spoken answer. Never assume, guess, or continue as if the patient already answered. Never answer your own question. Only move to the next step after the patient has actually responded.

Step 0 - Right after the greeting, confirm eligibility:
- Hebrew: "קו זה מיועד למטופלי כללית מושלם או פלטינום - זה המקרה שלך?"
- French: "Cette ligne est destinée aux patients Clalit Moushlam ou Platinum, est-ce bien votre cas ?"
- English: "This line is for Clalit Moushlam or Platinum patients, is that your case?"

Ask this question, then stop and wait. Do not proceed until the patient replies.

If NO -> go to "Non-Clalit path" below.
If YES -> continue to Step 1.

Step 1 (Clalit confirmed) - Explain the two options and ask which one, in a single turn:
- Hebrew: "עם כללית מושלם יש שתי אפשרויות: אפשרות של 50 שקל שכוללת פיזיותרפיה רגילה, או אפשרות פרטית לטיפולים מיוחדים כמו ריצפת האגן, שיקום ווסטיבולרי, או גלי הלם. איזו אפשרות מתאימה לך?"
- French: "Avec Clalit Moushlam, il y a deux options : une à 50 shekels qui couvre la physiothérapie classique, ou une option privée pour les soins spécialisés comme la rééducation périnéale, vestibulaire, ou les ondes de choc. Laquelle vous convient ?"
- English: "With Clalit Moushlam, there are two options: a 50 shekel one covering classic physiotherapy, or a private option for specialized care like pelvic floor, vestibular, or shockwave therapy. Which one works for you?"

If the patient already named a specific need before this point (e.g. "I have vertigo", "back pain"), you may skip straight to Step 2 using that information instead of asking again - but only if it's genuinely already clear from what they said.

Step 2 - Route based on the answer:

- 50 NIS chosen -> confirm it covers classic/general physiotherapy, mention the hafnaya requirement, use the send_rate_a_link tool. No need to repeat the exclusion list again - it was already stated in Step 1.

- Private/specialized chosen, but which one isn't clear yet -> ask: "Which specific care do you need - classic physiotherapy, pelvic floor, vestibular, or shockwave?" (translated per language). Then route:
  - Classic physiotherapy or vestibular or galei helem -> confirm price (350 NIS classic/galei helem, 400 NIS vestibular) with Julien, mention the 110 NIS reimbursement + hafnaya requirement, use the send_julien_link tool.
  - Ritspat hagan -> confirm price 400 NIS with Charline, mention the 110 NIS reimbursement + hafnaya requirement, use the send_charline_contact tool.

- If the patient describes a symptom rather than picking an option (back pain, sports injury, general ache, vague request) -> treat this as classic/general physiotherapy and ask them to choose between the two options from Step 1 if not already clear, or default to confirming it fits the 50 NIS rate if they seem to want the simplest/cheapest path.

If the patient wants the 50 NIS rate for a need that falls under vestibular, ritspat hagan, or galei helem, no matter how they phrase it - "can I get the cheap one for my dizziness?", "I only want to pay 50 for this", "isn't there a discount for this treatment?", or any other wording with the same underlying request - NEVER agree to book that specialty under the 50 NIS rate, it is not covered under any circumstance. Recognize the underlying request, not fixed phrases. Clearly say so and offer the private rate instead:
- Hebrew: "לצערי, האפשרות של 50 שקל לא כוללת את הטיפול הזה - הוא זמין רק באופן פרטי."
- French: "Malheureusement, la formule à 50 shekels ne couvre pas ce soin - il n'est disponible qu'en formule privée."
- English: "Unfortunately, the 50 shekel rate doesn't cover that care - it's only available privately."

Step 3 - Callback (private option only): if the patient wants to talk before booking, use the request_callback tool (practitioner "julien" or "charline" per the care named). Never offer a callback on the 50 NIS rate.

## Non-Clalit path (patient answered NO in Step 0)
The 50 NIS rate and the 110 NIS Moushlam reimbursement do NOT apply - never offer or mention them, and never ask the two-option question above (there's only one option: private payment). Ask what's bothering them:
- Hebrew: "מה מפריע לך? איזה סוג טיפול אתה צריך?"
- French: "Qu'est-ce qui vous amène ? Quel type de soin recherchez-vous ?"
- English: "What's bothering you? What type of care do you need?"

Then route: send_julien_link (classic/general, vestibular, or galei helem) or send_charline_contact (ritspat hagan) - without mentioning the Moushlam reimbursement. You may mention that their own private insurance (Harel, Migdal, Ayalon, etc.) might still reimburse part of the cost depending on their policy.

### Administrative categorization only
You may ask what's bothering the patient only to identify which appointment category applies (classic physiotherapy, vestibular, ritspat hagan, or shockwave). This is administrative categorization, not a medical assessment. Never ask about symptom severity, duration, or details beyond what's needed to categorize the appointment. Never interpret symptoms, diagnose, or recommend treatment.

### Urgency requests
Stay empathetic but firm - booking is only via the link, physiotherapists can't be reached to check availability manually.

### Callback process
Ask if the patient wants to be called back on the same number they're calling from, or a different one. If same number: call request_callback with only the practitioner argument, do not include phone_number. If different: ask them to say the number digit by digit, repeat it back to confirm, then call request_callback with that number as phone_number.

## Greeting
Hebrew (default): "שלום וברוכים הבאים ל-TLV Physiotherapy! אני העוזרת הדיגיטלית של המרפאה, איך אפשר לעזור לך היום?"
French: "Bonjour et bienvenue chez TLV Physiotherapy ! Je suis l'assistante virtuelle de la clinique, comment puis-je vous aider ?"
English: "Hi, thanks for calling TLV Physiotherapy! I'm the clinic's AI assistant, how can I help you today?"

## Ending the call
Never end right after giving a price. The call ends only after: (1) you used the right tool to send the link/contact or request the callback, (2) you asked if they need anything else, (3) they confirmed they're done, (4) you called the log_call_language tool once with the language used during this call (hebrew, french, or english), (5) you said a closing polite phrase. Only then may the call naturally end.

## Guardrails & Escalation
Stay strictly in scope: rate selection, pricing, reimbursement, sending links/contacts for Clalit physiotherapy only - this line does not cover other services (e.g. acupuncture, massage). You may ask what's bothering the patient only to categorize the appointment (see "Administrative categorization only" above) - naming a symptom for that purpose is fine. But never assess severity, interpret symptoms, give medical advice, diagnose, or recommend treatment, even if asked directly. If a caller asks you to interpret or explain their symptoms, or describes a medical emergency or self-harm, say you're an AI assistant and can't help with that, then use the request_callback tool. Be honest that you are an AI if asked.

## Voice & Communication Style
Warm, efficient, brisk but not rushed. Short sentences, one idea per turn. After asking any question, stop and wait for the patient's real answer - never continue speaking as if you already received it. Say "I don't have that information" rather than guessing.`;

// Corrige les formats de numero courants (ex: 0546384978 -> +972546384978)
// et journalise la valeur brute pour diagnostiquer les cas encore mal formes.
function normalizePhoneNumber(raw) {
  const trimmed = (raw || '').trim();
  console.log(`[DIAGNOSTIC] Numero brut recu: "${trimmed}"`);

  if (trimmed.startsWith('+')) return trimmed;
  if (trimmed.startsWith('0')) return `+972${trimmed.slice(1)}`;
  if (trimmed.startsWith('972')) return `+${trimmed}`;

  console.log(`[DIAGNOSTIC] ATTENTION: format de numero non reconnu, envoi tel quel: "${trimmed}"`);
  return trimmed;
}

// --- Webhook Twilio : appele quand un patient compose le numero ---
// twilio.webhook() valide la signature X-Twilio-Signature pour s'assurer que
// la requete vient bien de Twilio et non d'un tiers qui aurait devine l'URL.
app.post('/voice', twilio.webhook(), (req, res) => {
  const callerNumber = normalizePhoneNumber(req.body.From || '');
  const callSid = req.body.CallSid || '';

  // URL fixe plutot que le header Host (qui peut etre falsifie par le client)
  const wsUrl = `${process.env.PUBLIC_WS_URL}/media-stream`;

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: wsUrl });
  stream.parameter({ name: 'callerNumber', value: callerNumber });
  stream.parameter({ name: 'callSid', value: callSid });

  res.type('text/xml').send(response.toString());
});

// Petite route de sante, pratique pour verifier que le serveur tourne bien
app.get('/', (req, res) => res.send('TLV Physiotherapy bridge OK'));

// Recoit le statut reel de livraison de chaque WhatsApp envoye (sent/delivered/failed/undelivered)
app.post('/whatsapp-status', twilio.webhook(), (req, res) => {
  console.log(`[WHATSAPP STATUS] ${req.body.To} -> ${req.body.MessageStatus} (SID: ${req.body.MessageSid})`);
  res.sendStatus(200);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Valide la signature Twilio avant d'accepter la connexion WebSocket,
// pour qu'un tiers connaissant l'URL ne puisse pas se connecter directement.
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/media-stream') {
    socket.destroy();
    return;
  }

  const signature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const isValid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, {});

  if (!isValid) {
    console.error('Signature Twilio invalide sur la connexion WebSocket - connexion refusee.');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- Definition des outils que Grok Voice peut appeler ---
const TOOLS = [
  {
    type: 'function',
    name: 'send_rate_a_link',
    description: 'Envoie le lien de reservation de la formule a 50 NIS au patient par WhatsApp.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'send_julien_link',
    description: "Envoie le lien de reservation prive de Julien par WhatsApp (physio classique, vestibulaire, ou galei helem).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'send_charline_contact',
    description: "Envoie le contact WhatsApp de Charline au patient (pour ritspat hagan).",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'request_callback',
    description: "Demande a Julien ou Charline de rappeler le patient. Omettre phone_number si le patient veut etre rappele sur le meme numero que celui de l'appel.",
    parameters: {
      type: 'object',
      properties: {
        practitioner: { type: 'string', enum: ['julien', 'charline'] },
        phone_number: { type: 'string', description: 'Uniquement si le patient donne un AUTRE numero que celui avec lequel il appelle. Ne pas remplir sinon.' },
      },
      required: ['practitioner'],
    },
  },
  {
    type: 'function',
    name: 'log_call_language',
    description: "A appeler une seule fois, juste avant de clore l'appel normalement (avant la phrase de politesse finale), pour indiquer la langue utilisee pendant la conversation.",
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['hebrew', 'french', 'english'] },
      },
      required: ['language'],
    },
  },
];

wss.on('connection', (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let callLanguage = null;
  let summaryNotificationSent = false;
  let grokWs = null;

  const connectToGrok = () => {
    grokWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    });

    grokWs.on('open', () => {
      grokWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          instructions: CLALIT_PROMPT,
          voice: 'eve',
          audio: {
            input: { format: { type: 'audio/pcmu' } },
            output: { format: { type: 'audio/pcmu' } },
          },
          turn_detection: { type: 'server_vad' },
          tools: TOOLS,
        },
      }));

      // Accueil force en hebreu, mot pour mot garanti (pas d'improvisation possible sur la langue)
      grokWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'force_message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'שלום וברוכים הבאים ל-TLV Physiotherapy! אני העוזרת הדיגיטלית של המרפאה, איך אפשר לעזור לך היום?',
          }],
        },
      }));
      // Ne pas envoyer response.create ici : force_message EST le tour de parole.
    });

    grokWs.on('message', async (raw) => {
      const event = JSON.parse(raw.toString());

      // Audio genere par Grok Voice -> on le renvoie a Twilio pour que le patient l'entende
      if (event.type === 'response.output_audio.delta' && event.delta && streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: event.delta },
        }));
      }

      // Grok Voice veut executer une action concrete
      if (event.type === 'response.function_call_arguments.done') {
        await handleFunctionCall(event);
      }
    });

    grokWs.on('close', () => console.log('Connexion Grok Voice fermee'));
    grokWs.on('error', (err) => {
      console.error('Erreur Grok Voice:', err.message);
      redirectCallToFallback();
    });

    // Capture le detail exact renvoye par xAI quand la connexion echoue
    grokWs.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        console.error('--- Reponse xAI detaillee ---');
        console.error('Status:', res.statusCode);
        console.error('Body:', body);
        console.error('-----------------------------');
      });
      redirectCallToFallback();
    });
  };

  // Si Grok Voice ne repond pas, on redirige l'appel en cours vers un message
  // parle plutot que de laisser le patient dans un silence complet.
  async function redirectCallToFallback() {
    if (!callSid) return;
    try {
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const response = new VoiceResponse();
      response.say(
        { language: 'he-IL' },
        'מצטערים, השירות הדיגיטלי אינו זמין כרגע. אנא נסו שוב מאוחר יותר.'
      );
      await twilioClient.calls(callSid).update({ twiml: response.toString() });
    } catch (err) {
      console.error('Erreur redirection appel vers message de secours:', err.message);
    }
  }

  async function handleFunctionCall(event) {
    const args = event.arguments ? JSON.parse(event.arguments) : {};
    let result = { status: 'success' };

    try {
      if (event.name === 'send_rate_a_link') {
        await sendWhatsAppTemplate(callerNumber, TEMPLATES.rateA);
      } else if (event.name === 'send_julien_link') {
        await sendWhatsAppTemplate(callerNumber, TEMPLATES.julien);
      } else if (event.name === 'send_charline_contact') {
        await sendWhatsAppTemplate(callerNumber, TEMPLATES.charline);
      } else if (event.name === 'request_callback') {
        const target = args.practitioner === 'charline' ? CONTACTS.charline : CONTACTS.julien;
        const numberToCall = args.phone_number || callerNumber;
        await sendWhatsAppTemplate(target, TEMPLATES.callbackRequest, {
          '1': numberToCall || 'Numero inconnu',
        });
      } else if (event.name === 'log_call_language') {
        callLanguage = args.language;
        await sendCallSummary(callLanguage);
      }
    } catch (err) {
      console.error('Erreur outil', event.name, err);
      result = { status: 'failed', error: err.message };
    }

    if (grokWs && grokWs.readyState === WebSocket.OPEN) {
      grokWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: event.call_id,
          output: JSON.stringify(result),
        },
      }));

      // Sans ceci, l'IA execute l'action mais ne reprend jamais la parole ensuite
      grokWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  twilioWs.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        callSid = data.start.customParameters?.callSid || data.start.callSid || null;
        callerNumber = data.start.customParameters?.callerNumber || null;
        connectToGrok();
        break;

      case 'media':
        // Audio du patient -> on le transmet a Grok Voice
        if (grokWs && grokWs.readyState === WebSocket.OPEN) {
          grokWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload,
          }));
        }
        break;

      case 'stop':
        // Garantit une notification a Julien meme si l'appel s'est termine
        // brutalement, sans que l'IA ait eu l'occasion d'utiliser l'outil de langue.
        sendCallSummary(callLanguage);
        if (grokWs) grokWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    if (grokWs) grokWs.close();
  });

  // Notifie Julien apres CET appel precis (langue detectee ou "Non detecte" par defaut)
  async function sendCallSummary(language) {
    if (summaryNotificationSent) return;
    summaryNotificationSent = true;

    const timestamp = new Date().toLocaleString('fr-FR', { timeZone: 'Asia/Jerusalem' });
    try {
      await sendWhatsAppTemplate(CONTACTS.julien, TEMPLATES.callSummary, {
        '1': callerNumber || 'Numero inconnu',
        '2': timestamp,
        '3': language || 'Non detecte',
      });
    } catch (err) {
      console.error("Erreur envoi resume d'appel:", err.message);
    }
  }
});

// SID des templates WhatsApp approuves par Meta - a remplir dans Railway une fois chaque template valide
const TEMPLATES = {
  rateA: process.env.TEMPLATE_SID_RATE_A,
  julien: process.env.TEMPLATE_SID_JULIEN,
  charline: process.env.TEMPLATE_SID_CHARLINE,
  callSummary: process.env.TEMPLATE_SID_CALL_SUMMARY,
  callbackRequest: process.env.TEMPLATE_SID_CALLBACK_REQUEST,
};

// URL de suivi de livraison des messages WhatsApp (statut reel : sent/delivered/failed)
const statusCallbackUrl = process.env.PUBLIC_WS_URL
  ? `${process.env.PUBLIC_WS_URL.replace('wss://', 'https://')}/whatsapp-status`
  : undefined;

// Envoi via un template approuve (obligatoire pour un premier message hors fenetre 24h)
async function sendWhatsAppTemplate(toNumber, templateSid, variables = {}) {
  if (!toNumber) throw new Error('Aucun numero de telephone disponible');
  if (!templateSid) throw new Error('Template SID manquant - a-t-il ete approuve et ajoute en variable Railway ?');
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${toNumber}`,
    contentSid: templateSid,
    contentVariables: JSON.stringify(variables),
    ...(statusCallbackUrl && { statusCallback: statusCallbackUrl }),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur relais demarre sur le port ${PORT}`));
