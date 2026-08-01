# Serveur relais Physiovertigo (Clalit) — Twilio ↔ Grok Voice

Ce serveur reçoit les appels du numéro Twilio dédié Clalit, les relie à l'agent
vocal Grok Voice, et envoie les liens/contacts par WhatsApp pendant l'appel.

## 1. Déployer sur Railway (gratuit pour commencer)

1. Créez un compte sur [railway.app](https://railway.app).
2. Cliquez **New Project → Deploy from GitHub repo** (il faudra d'abord
   pousser ce dossier sur un repo GitHub à vous — même un repo privé et vide
   fonctionne), ou utilisez **New Project → Empty Project** puis glissez ce
   dossier via leur CLI (`railway up`).
3. Une fois déployé, Railway vous donne une URL publique du type
   `https://votre-projet.up.railway.app`.

## 2. Configurer les variables d'environnement

Dans Railway, onglet **Variables**, ajoutez celles listées dans `.env.example` :

- `XAI_API_KEY` — récupérée sur console.x.ai
- `TWILIO_ACCOUNT_SID` et `TWILIO_AUTH_TOKEN` — console.twilio.com
- `TWILIO_WHATSAPP_FROM` — votre numéro WhatsApp Twilio (sandbox pour tester,
  ou numéro WhatsApp Business approuvé pour la prod)

## 3. Brancher le numéro Twilio dédié Clalit

Une fois le numéro israélien acheté et approuvé :

1. Console Twilio → **Phone Numbers → Manage → Active Numbers**.
2. Cliquez sur le numéro Clalit.
3. Dans **Voice Configuration → A call comes in**, sélectionnez **Webhook**
   et collez : `https://votre-projet.up.railway.app/voice`
4. Méthode : **HTTP POST**. Sauvegardez.

## 4. Tester

Appelez le numéro Clalit depuis un téléphone — l'appel doit être décroché
par l'agent vocal, dans la langue que vous parlez.

## Ce que fait chaque outil pendant l'appel

| Outil appelé par l'IA | Action réelle |
|---|---|
| `send_rate_a_link` | WhatsApp au patient avec le lien 50 NIS |
| `send_julien_link` | WhatsApp au patient avec le lien privé de Julien |
| `send_charline_contact` | WhatsApp au patient avec le numéro de Charline |
| `request_callback` | WhatsApp à Julien ou Charline avec le numéro à rappeler |

## Limites connues de cette première version

- Le prompt est codé en dur dans `server.js` — pour le modifier, il faut
  éditer le fichier et redéployer (pas d'interface de modification à chaud).
- Pas de journal d'appels/transcriptions sauvegardé — à ajouter plus tard si
  vous voulez analyser les appels passés.
- `TWILIO_WHATSAPP_FROM` doit être un numéro WhatsApp valide et approuvé
  pour envoyer des messages hors fenêtre de 24h (templates Meta requis en
  production, le sandbox suffit pour les tests).
