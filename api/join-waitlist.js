// Serverless function: verifies a Cloudflare Turnstile token, then inserts
// the sign-up into Supabase using the service-role key (bypasses RLS).
// The public anon key is no longer permitted to insert directly — see
// the RLS policy change that accompanies this function.
//
// Two sign-up types share this endpoint:
//   type: "waitlist" (default) — email, who_for
//   type: "gift"               — email (giver), first_name (recipient),
//                                relationship. No relative contact details.
// Gift reservations also trigger a confirmation email to the giver via Resend.
// Schema changes this needs are in db/waitlist-gift-migration.sql.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHO_FOR = ['me', 'parent_or_grandparent', 'both'];
const RELATIONSHIPS = ['Mum', 'Dad', 'Nan', 'Grandad', 'Other'];
const FIRST_NAME_RE = /^[\p{L}][\p{L}' -]{0,49}$/u;

// Defensive: strips a leading BOM and surrounding whitespace. Some env var
// tooling (notably piping values through PowerShell into `vercel env add`)
// can prepend a UTF-8 BOM character, which silently breaks URL parsing and
// bearer-token auth without any obvious error at the point of failure.
const clean = (v) => {
  let s = (v || '').trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip leading BOM if present
  return s.trim();
};

// Email copy and branding follow the landing page: paper background, card,
// ink text, amber and harbour accents, Newsreader headings with Georgia
// fallback, Public Sans body with Arial fallback.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const SAMPLE_MESSAGE = "I've reserved you a place in Memory Companion. Each week you'll get a friendly phone call where you can share your stories, and we'll keep them safe for the family to enjoy for years. Calls start in early 2027, and you don't need an app, just a phone.";

function giftEmail(firstName) {
  const name = firstName;
  const subject = `Your Memory Companion gift for ${name}`;

  const text = [
    `Thank you for reserving a beta place for ${name}.`,
    '',
    `We'll be in touch in January to confirm the start date and set up their calls. Calls only happen if ${name} agrees.`,
    '',
    `If you'd like to tell them now, you could send this:`,
    '',
    `"${SAMPLE_MESSAGE}"`,
    '',
    'Thanks,',
    'Lee',
    'Memory Companion',
    'memorycompanion.co.uk',
  ].join('\n');

  const n = escapeHtml(name);
  const msg = escapeHtml(SAMPLE_MESSAGE);
  const html = `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F3EEE4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3EEE4;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFDF9;border-radius:18px;padding:36px 36px 32px;font-family:'Public Sans',Arial,Helvetica,sans-serif;color:#2A2724;font-size:17px;line-height:1.65;">
      <tr><td style="padding-bottom:24px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:30px;height:30px;border-radius:50%;background:#B9822E;background-image:linear-gradient(160deg,#B9822E 0%,#3F6B70 100%);font-size:0;line-height:0;">&nbsp;</td>
          <td style="padding-left:10px;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:500;color:#2A2724;">Memory Companion</td>
        </tr></table>
      </td></tr>
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;font-weight:500;color:#2A2724;padding-bottom:18px;">Your gift for ${n} is reserved.</td></tr>
      <tr><td style="padding-bottom:16px;color:#2A2724;">We'll be in touch in January to confirm the start date and set up their calls. Calls only happen if ${n} agrees.</td></tr>
      <tr><td style="padding-bottom:12px;color:#5B564E;">If you'd like to tell them now, you could send this:</td></tr>
      <tr><td style="padding:0 0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="border-left:3px solid #B9822E;padding:6px 0 6px 18px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:18px;line-height:1.6;color:#2A2724;">${msg}</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding-bottom:4px;">Thanks,</td></tr>
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#2A2724;">Lee</td></tr>
      <tr><td style="font-size:14px;color:#5B564E;padding-top:4px;">Memory Companion</td></tr>
      <tr><td style="border-top:1px solid #E2D8C6;padding-top:18px;margin-top:20px;font-size:13px;color:#5B564E;">
        <a href="https://memorycompanion.co.uk" style="color:#2C4C50;text-decoration:none;">memorycompanion.co.uk</a>
        &nbsp;·&nbsp; Calls are private to your family.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

async function sendGiftEmail(to, firstName) {
  const apiKey = clean(process.env.RESEND_API_KEY);
  const from = clean(process.env.GIFT_EMAIL_FROM) || 'Memory Companion <hello@memorycompanion.co.uk>';
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const { subject, text, html } = giftEmail(firstName);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!resp.ok) {
    throw new Error(`Resend responded ${resp.status}: ${await resp.text()}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const {
    type = 'waitlist',
    email,
    who_for,
    first_name,
    relationship,
    utm_source,
    utm_medium,
    utm_campaign,
    turnstileToken
  } = body || {};

  if (type !== 'waitlist' && type !== 'gift') {
    return res.status(400).json({ success: false, error: 'invalid_type' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ success: false, error: 'invalid_email' });
  }
  if (type === 'waitlist' && !WHO_FOR.includes(who_for)) {
    return res.status(400).json({ success: false, error: 'invalid_who_for' });
  }
  if (type === 'gift') {
    if (typeof first_name !== 'string' || !FIRST_NAME_RE.test(first_name.trim())) {
      return res.status(400).json({ success: false, error: 'invalid_first_name' });
    }
    if (!RELATIONSHIPS.includes(relationship)) {
      return res.status(400).json({ success: false, error: 'invalid_relationship' });
    }
  }
  if (typeof turnstileToken !== 'string' || !turnstileToken) {
    return res.status(400).json({ success: false, error: 'missing_turnstile_token' });
  }

  try {
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: clean(process.env.TURNSTILE_SECRET_KEY),
        response: turnstileToken,
        remoteip: req.headers['x-forwarded-for'] || ''
      })
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.success) {
      return res.status(400).json({ success: false, error: 'turnstile_failed' });
    }
  } catch (err) {
    console.error('Turnstile verification error', err);
    return res.status(502).json({ success: false, error: 'turnstile_unreachable' });
  }

  const row = {
    type,
    email: email.trim(),
    utm_source: utm_source || null,
    utm_medium: utm_medium || null,
    utm_campaign: utm_campaign || null,
  };
  if (type === 'waitlist') {
    row.who_for = who_for;
  } else {
    row.recipient_first_name = first_name.trim();
    row.relationship = relationship;
  }

  try {
    const supabaseUrl = clean(process.env.SUPABASE_URL);
    const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/waitlist`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });

    if (insertRes.status === 201) {
      if (type === 'gift') {
        // The reservation is saved at this point. If the email fails, log it
        // so it can be resent by hand; don't ask the giver to try again.
        try {
          await sendGiftEmail(row.email, row.recipient_first_name);
        } catch (err) {
          console.error('Gift confirmation email failed', err);
        }
        return res.status(200).json({ success: true, duplicate: false });
      }
      return res.status(200).json({ success: true, duplicate: false });
    }
    if (insertRes.status === 409 && type === 'waitlist') {
      return res.status(200).json({ success: true, duplicate: true });
    }

    const errText = await insertRes.text();
    console.error('Supabase insert failed', insertRes.status, errText);
    return res.status(502).json({ success: false, error: 'db_error' });
  } catch (err) {
    console.error('Supabase insert error', err);
    return res.status(502).json({ success: false, error: 'db_unreachable' });
  }
}
