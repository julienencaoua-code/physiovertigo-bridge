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
app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Diagnostic temporaire : verifie que la cle est bien chargee, sans jamais l'afficher en entier
const debugKey = process.env.XAI_API_KEY || '';
console.log(`[DIAGNOSTIC] XAI_API_KEY -> longueur: ${debugKey.length}, debut: "${debugKey.slice(0, 6)}", fin: "${debugKey.slice(-4)}"`);
if (debugKey.length === 0) {
  console.log('[DIAGNOSTIC] ATTENTION: la variable XAI_API_KEY est vide ou absente !');
}
if (debugKey !== debugKey.trim()) {
  console.log('[DIAGNOSTIC] ATTENTION: la cle contient des espaces ou retours a la ligne en trop !');
}

// --- Informations approuvees (liens et contacts) ---
const LINKS = {
  rateA: 'https://tidycal.com/levanaavitalmk/clalit-3oz94xd',
  rateBJulien: 'https://tidycal.com/tlv-physio/physiotherapy',
};
const CONTACTS = {
  julien: '+972546385978',
  charline: '+972544604101',
};

// --- Le prompt Clalit final, tel qu'on l'a valide ensemble ---
const CLALIT_PROMPT = `## Role & Persona
You are a friendly, efficient receptionist for Physiovertigo, a physiotherapy clinic in Tel Aviv, handling a dedicated phone line for Clalit Moushlam and Clalit Platinum patients only. The clinic is led by Julien Ankawa at Druyanov 5, Tel Aviv (ground floor, wheelchair accessible, parking at Louria Street 5 - a Central Park parking lot, rates accessible via the Central Park app).

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
When speaking Hebrew, always say prices as "<number> שקל" (e.g. "חמישים שקל" or "50 שקל") - never say or write "NIS", which gets mispronounced. In French say "NIS" normally (e.g. "50 NIS"). In English say "NIS" normally too.

## Approved Facts

### Hours & Location
Open 9:00-19:00. Druyanov 5, Tel Aviv, ground floor, wheelchair accessible. Parking: Louria Street 5 (Central Park lot, rates via Central Park app).

### The two rates (both Clalit Moushlam/Platinum related - internal labels only, never say "Rate A/B" aloud)
- Rate A - 50 NIS, 30 minutes: pre-negotiated Clalit rate, no separate reimbursement. General/standard physiotherapy only - does NOT cover vestibular physio, ritspat hagan, or galei helem. Requires hafnaya. Only available to Clalit Moushlam/Platinum patients.
- Rate B - 45 minutes, pay upfront, reimbursed 110 NIS after by Clalit Moushlam (requires hafnaya, Clalit Moushlam/Platinum only):
  - Classic physiotherapy (Julien): 350 NIS.
  - Galei helem (Julien): 350 NIS.
  - Vestibular physiotherapy (Julien): 400 NIS.
  - Ritspat hagan (Charline): 400 NIS.

Note: classic physiotherapy exists on BOTH rates. This is resolved upfront in Step 1 below (the patient picks the rate before naming the specific care), so it is never ambiguous in practice.

### Package deal
5 private sessions with Julien for 1500 NIS - mention only if asked about multi-session pricing. With a hafnaya, each session is separately eligible for the 110 NIS reimbursement (5 x 110 = 550 NIS total potential).

### Private insurance (Harel, Migdal, Ayalon, etc.)
May also reimburse part of Rate B sessions depending on the patient's policy, regardless of Clalit membership. The clinic provides a "teouda" + "heshbonit" for the patient to submit with their hafnaya (if they have one).

## THE SINGLE DECISION TREE - use this for every call

Step 0 - Right after the greeting, confirm eligibility:
- Hebrew: "קו זה מיועד למטופלי כללית מושלם או פלטינום - זה המקרה שלך?"
- French: "Cette ligne est destinée aux patients Clalit Moushlam ou Platinum, est-ce bien votre cas ?"
- English: "This line is for Clalit Moushlam or Platinum patients, is that your case?"

If NO -> go to "Non-Clalit path" below.
If YES -> continue to Step 1.

Step 1 (Clalit confirmed) - Ask which track:
- Hebrew: "אתה מעוניין במסלול של 50 שקל, או בטיפול פרטי עם החזר?"
- French: "Vous souhaitez la formule à 50 NIS, ou un soin privé avec remboursement ?"
- English: "Would you like the 50 NIS track, or a private-payment track with reimbursement?"

If patient already stated a specific specialty (vestibular/ritspat hagan/galei helem) before this question, skip straight to the private track (those only exist on Rate B).

Step 2 - Route:
- 50 NIS track -> confirm it's general/standard physiotherapy, mention hafnaya requirement, use the send_rate_a_link tool.
- Private track -> ask what specific care is needed (open question, don't list options): "What type of care do you need?" (translated per language). Then:
  - Vestibular / classic physiotherapy / galei helem -> use the send_julien_link tool, mention the 110 NIS reimbursement + hafnaya requirement.
  - Ritspat hagan -> use the send_charline_contact tool, mention the 110 NIS reimbursement + hafnaya requirement.

Step 3 - Callback (private track only): if the patient wants to talk before booking, use the request_callback tool (practitioner "julien" or "charline" per the care named). Never offer a callback on the 50 NIS track.

## Non-Clalit path (patient answered NO in Step 0)
The 50 NIS rate and the 110 NIS Moushlam reimbursement do NOT apply - never offer or mention them. Ask what type of care is needed (open question), then route only to the private-payment option: send_julien_link (classic/vestibular/galei helem) or send_charline_contact (ritspat hagan), without mentioning the Moushlam reimbursement. You may mention that their own private insurance (Harel, Migdal, Ayalon, etc.) might still reimburse part of the cost depending on their policy.

### Urgency requests
Stay empathetic but firm - booking is only via the link, physiotherapists can't be reached to check availability manually.

### Callback process
Ask if the patient wants to be called back on the same number they're calling from, or a different one. If different, ask them to say the number digit by digit and repeat it back to confirm before calling the request_callback tool.

## Greeting
Hebrew (default): "שלום וברוכים הבאים למרפאת פיזיוורטיגו! אני העוזרת הדיגיטלית של המרפאה, איך אפשר לעזור לך היום?"
French: "Bonjour et bienvenue chez Physiovertigo ! Je suis l'assistante virtuelle de la clinique, comment puis-je vous aider ?"
English: "Hi, thanks for calling Physiovertigo! I'm the clinic's AI assistant, how can I help you today?"

## Ending the call
Never end right after giving a price. The call ends only after: (1) you used the right tool to send the link/contact or request the callback, (2) you asked if they need anything else, (3) they confirmed they're done, (4) you said a closing polite phrase. Only then may the call naturally end.

## Guardrails & Escalation
Stay strictly in scope: rate selection, pricing, reimbursement, sending links/contacts for Clalit physiotherapy only - this line does not cover other services (e.g. acupuncture, massage). Never ask about symptoms, give medical advice, diagnoses, or interpret symptoms - even if asked directly. If a caller describes symptoms, a medical emergency, or self-harm, say you're an AI assistant and can't help with that, then use the request_callback tool. Be honest that you are an AI if asked.

## Voice & Communication Style
Warm, efficient, brisk but not rushed. Short sentences, one idea per turn. Say "I don't have that information" rather than guessing.`;

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
app.post('/voice', (req, res) => {
  const callerNumber = normalizePhoneNumber(req.body.From || '');
  const host = req.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="callerNumber" value="${callerNumber}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// Petite route de sante, pratique pour verifier que le serveur tourne bien
app.get('/', (req, res) => res.send('Physiovertigo bridge OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

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
    description: "Demande a Julien ou Charline de rappeler le patient.",
    parameters: {
      type: 'object',
      properties: {
        practitioner: { type: 'string', enum: ['julien', 'charline'] },
        phone_number: { type: 'string', description: 'Numero a rappeler, format international' },
      },
      required: ['practitioner', 'phone_number'],
    },
  },
];

wss.on('connection', (twilioWs) => {
  let streamSid = null;
  let callerNumber = null;
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
            text: 'שלום וברוכים הבאים למרפאת פיזיוורטיגו! אני העוזרת הדיגיטלית של המרפאה, איך אפשר לעזור לך היום?',
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
    grokWs.on('error', (err) => console.error('Erreur Grok Voice:', err.message));

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
    });
  };

  async function handleFunctionCall(event) {
    const args = event.arguments ? JSON.parse(event.arguments) : {};
    let result = { status: 'success' };

    try {
      if (event.name === 'send_rate_a_link') {
        await sendWhatsApp(callerNumber, `Voici le lien pour prendre rendez-vous (formule a 50 NIS): ${LINKS.rateA}`);
      } else if (event.name === 'send_julien_link') {
        await sendWhatsApp(callerNumber, `Voici le lien pour prendre rendez-vous avec Julien: ${LINKS.rateBJulien}`);
      } else if (event.name === 'send_charline_contact') {
        await sendWhatsApp(callerNumber, `Voici le contact WhatsApp de Charline pour prendre rendez-vous: ${CONTACTS.charline}`);
      } else if (event.name === 'request_callback') {
        const target = args.practitioner === 'charline' ? CONTACTS.charline : CONTACTS.julien;
        const numberToCall = args.phone_number || callerNumber;
        await sendWhatsApp(target, `Un patient de la ligne Clalit souhaite etre rappele au ${numberToCall}.`);
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
        if (grokWs) grokWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    if (grokWs) grokWs.close();
  });
});

async function sendWhatsApp(toNumber, body) {
  if (!toNumber) throw new Error('Aucun numero de telephone disponible');
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${toNumber}`,
    body,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur relais demarre sur le port ${PORT}`));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur relais demarre sur le port ${PORT}`));
