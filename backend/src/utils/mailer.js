const nodemailer = require('nodemailer');

// Gmail SMTP using an app password (SMTP_USER and SMTP_PASS in .env).
// Without them, development emails are printed to the console instead.
const transporter = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  })
  : null;

const isProduction = () => process.env.NODE_ENV === 'production';

// The demo accounts use made-up addresses on real domains such as
// kenya-airways.com. MAIL_DEV_REDIRECT sends every email to one inbox you
// control. Outside production, nothing is ever sent without it, so a test
// email can never reach a real person by accident.
async function sendMail({ to, subject, text, html }) {
  const redirect = process.env.MAIL_DEV_REDIRECT;
  const finalTo = redirect || to;
  const finalSubject = redirect ? `[for ${to}] ${subject}` : subject;
  const configured = Boolean(process.env.BREVO_API_KEY || transporter);

  if (!configured || (!isProduction() && !redirect)) {
    if (isProduction()) {
      // Never print message bodies in production: they can contain sign-in links
      console.warn(`[email not sent: email is not configured] to ${to}: ${subject}`);
    } else {
      console.log(`\n[email not sent: ${configured ? 'set MAIL_DEV_REDIRECT to send in development' : 'email not configured'}]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    }
    return false;
  }

  // Brevo's HTTPS API, for hosts that block outgoing SMTP (such as Render's free plan).
  // MAIL_FROM must be a sender address verified in Brevo.
  if (process.env.BREVO_API_KEY) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'AlumNet', email: process.env.MAIL_FROM || process.env.SMTP_USER },
        to: [{ email: finalTo }],
        subject: finalSubject,
        textContent: text,
        htmlContent: html || undefined
      })
    });
    if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${await res.text()}`);
    return true;
  }

  await transporter.sendMail({
    from: `"AlumNet" <${process.env.SMTP_USER}>`,
    to: finalTo,
    subject: finalSubject,
    text,
    html
  });
  return true;
}

// Simple branded HTML wrapper so emails look like they come from a real product
function emailLayout(title, bodyHtml) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#15201C;">
    <div style="font-weight:700;font-size:18px;margin-bottom:20px;">
      <span style="display:inline-block;background:#C8102E;color:#fff;border-radius:50%;width:28px;height:28px;line-height:28px;text-align:center;font-size:12px;margin-right:8px;">KQ</span>AlumNet
    </div>
    <h2 style="font-size:20px;margin:0 0 12px;">${title}</h2>
    ${bodyHtml}
    <p style="color:#6E7A75;font-size:12px;margin-top:28px;">Kenya Airways Alumni Network. If you did not expect this email, you can ignore it.</p>
  </div>`;
}

module.exports = { sendMail, emailLayout };
