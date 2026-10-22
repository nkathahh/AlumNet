/*
 * Automatic checks on opportunities and events before an admin reviews them.
 * Each rule looks for a pattern common in job scams in Kenya: asking for a
 * fee, moving the conversation to WhatsApp, promising guaranteed jobs or
 * asking for ID or bank details. The admin always decides; these checks
 * only put the riskiest posts first and say why.
 */

// Phrases that say the opposite of a scam ("there is no fee", "we will never
// ask you to pay") are removed before the payment rule runs, so honest posts
// that warn applicants are not flagged
const REASSURANCES = [
  /\b(no|zero|free\s+of|without\s+(any\s+)?|not\s+charge\s+(any\s+)?|never\s+charges?\s+(any\s+)?)\s*(application|registration|processing|placement|training|interview|recruitment|hidden)?\s*(fees?|charges?|payments?)\b/gi,
  /\b(never|not|don'?t|do\s+not|will\s+not|won'?t)\s+(ever\s+)?(ask|request|require)\s+(you\s+|applicants\s+|candidates\s+)?(to\s+)?(pay|for\s+(money|payment|a\s+fee|fees))\b[^.!?\n]*/gi,
  /\b(do\s+not|don'?t|never)\s+(pay|send\s+money)\b[^.!?\n]*/gi,
  /\b(hakuna|bila)\s+(ada|malipo)\b/gi
];

// Undo simple disguises scammers use to slip past filters:
// "f.e.e" -> "fee", "registr4tion" -> "registration"
function normalise(text) {
  const leet = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's' };
  return String(text || '')
    .replace(/\b(?:[a-z][.\-*_ ]){2,}[a-z]\b/gi, (m) => m.replace(/[.\-*_ ]/g, ''))
    .replace(/(?<=[a-z])[013458@$](?=[a-z])/gi, (c) => leet[c] || c);
}

const RULES = [
  { level: 'high', label: 'Asks applicants to pay (fee, M-Pesa or deposit)',
    re: new RegExp([
      String.raw`\b(registration|processing|application|training|placement|medical|interview|clearance|uniform|recruitment)\s+fees?\b`,
      String.raw`\bpay(ment)?\s+(of\s+)?(ksh|kes|sh\.?|usd|\$)\s*\d`,
      String.raw`\b(pay|send|lipa|tuma|via|through|using|kupitia)\b[^.\n]{0,40}m-?\s?pesa\b`,
      String.raw`\bm-?\s?pesa\s+(till|pay\s?bill|number|no\.?)\b`,
      String.raw`\bpay\s?bill\b`, String.raw`\btill\s+(number|no\.?)\b`,
      String.raw`\bsend\s+(money|cash)\b`,
      String.raw`\b(pay|make|send|refundable)\s+(a\s+)?deposit\b|\bdeposit\s+of\s+(ksh|kes|sh|usd|\$)`,
      String.raw`\brefundable\b`,
      // Swahili: "pay", "fee", "send money", "entry fee"
      String.raw`\blipa\b|\bada\s+ya\s+(usajili|maombi|mafunzo|kazi)\b|\btuma\s+pesa\b|\bkiingilio\b`
    ].join('|'), 'i') },
  { level: 'high', label: 'Asks for ID, passport, bank or PIN details',
    re: /\b(id|passport)\s+(copy|copies|number|no\.?)\b|\bcopy\s+of\s+(your\s+)?(id|passport)\b|\bbank\s+(details|account|statement)\b|\bpin\s+(number|no)\b|\bsend\s+(your\s+)?(id|passport|documents)\b|\bnambari\s+ya\s+kitambulisho\b/i },
  { level: 'medium', label: 'Moves the conversation off AlumNet (WhatsApp or Telegram)',
    re: /whats\s?app|\btelegram\b|\bdm\s+me\b|\binbox\s+me\b|\bcontact\s+me\s+directly\b|\bnitumie\s+ujumbe\b/i },
  { level: 'medium', label: 'Promises that sound too good (guaranteed job, no interview)',
    re: /\bguarantee(d)?\s+(job|employment|placement|visa|income)\b|\bno\s+(interview|experience|qualifications?)\s+(needed|required)\b|\bearn\s+(ksh|kes|\$|usd)?\s*[\d,]+\s*(per|a|every)\s+(day|week|hour)\b|\bwork\s+from\s+home\s+and\s+earn\b|\bkazi\s+ya\s+uhakika\b|\bbila\s+uzoefu\b/i },
  { level: 'medium', label: 'Creates pressure to act fast',
    re: /\b(urgent(ly)?\s+hiring|limited\s+slots|only\s+\d+\s+slots|apply\s+(today|now)\s+or|first\s+come\s+first\s+served|haraka\s+sana)\b/i },
  { level: 'low', label: 'Includes a personal phone number in the text',
    re: /(\+?254|\b0)\s?7\d{2}\s?\d{3}\s?\d{3}\b|(\+?254|\b0)\s?1\d{2}\s?\d{3}\s?\d{3}\b/ }
];

const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|ow\.ly|shorturl\.at|tiny\.cc)$/i;
const FREE_MAIL = /@(gmail|yahoo|outlook|hotmail|ymail|aol|icloud|proton(mail)?)\./i;

function linkChecks(link, company) {
  const flags = [];
  if (!link) return flags;
  const value = String(link).trim();
  const claimsKq = /kenya\s*airways|\bkq\b/i.test(company || '');

  if (/^[^\s@]+@[^\s@]+$/.test(value)) {
    if (claimsKq && !/@kenya-airways\.com$/i.test(value)) {
      flags.push({ level: 'high', label: 'Says it is Kenya Airways but the apply email is not @kenya-airways.com' });
    } else if (FREE_MAIL.test(value)) {
      flags.push({ level: 'low', label: 'Applications go to a personal email address' });
    }
    return flags;
  }

  let url;
  try { url = new URL(value); } catch { return [{ level: 'medium', label: 'The application link is not a valid web address' }]; }
  const host = url.hostname.replace(/^www\./, '');
  if (url.protocol !== 'https:') flags.push({ level: 'medium', label: 'The application link is not secure (http, not https)' });
  if (SHORTENERS.test(host)) flags.push({ level: 'medium', label: `The link is shortened (${host}), so the real site is hidden` });
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) flags.push({ level: 'high', label: 'The link goes to a bare IP address, not a named website' });
  if (/wa\.me|whatsapp\.com|t\.me/i.test(host)) flags.push({ level: 'medium', label: 'The link opens a WhatsApp or Telegram chat' });
  if (claimsKq && !/(^|\.)kenya-airways\.com$/i.test(host)) {
    flags.push({ level: 'high', label: `Says it is Kenya Airways but links to ${host}` });
  }
  return flags;
}

const ORDER = { low: 1, medium: 2, high: 3 };

/*
 * fields: { title, description, company, location, link }
 * returns { level: 'low'|'medium'|'high', flags: [{ level, label }] }
 */
function scanPost(fields) {
  const raw = [fields.title, fields.company, fields.description, fields.location].filter(Boolean).join('\n');
  const text = REASSURANCES.reduce((t, re) => t.replace(re, ' '), normalise(raw));
  const flags = RULES.filter((r) => r.re.test(text)).map(({ level, label }) => ({ level, label }));
  flags.push(...linkChecks(fields.link, fields.company));

  let level = 'low';
  const highs = flags.filter((f) => f.level === 'high').length;
  const mediums = flags.filter((f) => f.level === 'medium').length;
  if (highs || mediums >= 2) level = 'high';
  else if (mediums || flags.length >= 2) level = 'medium';
  flags.sort((a, b) => ORDER[b.level] - ORDER[a.level]);
  return { level, flags };
}

// Messages and profile text have no link or company to check
function scanText(text) {
  return scanPost({ description: text });
}

module.exports = { scanPost, scanText };
