// Outgoing email (sign-in codes, reset and invite links).
// Production: Mailjet's Send API v3.1 over HTTPS, with the same API key and secret as the
// SMTP login used by Pedro's other apps. MAIL_MODE=log prints messages to the Worker log
// instead (local development). With neither configured, nothing can be sent and the app
// says so; password sign-in still works.

export interface MailEnv {
  MAILJET_API_KEY?: string;
  MAILJET_API_SECRET?: string;
  MAIL_FROM?: string;   // "Sprigboard <noreply@example.com>": a sender validated in Mailjet
  MAIL_MODE?: string;   // "log" for local development
}

export interface Mail { to: string; subject: string; text: string; html: string; replyTo?: string; fromName?: string }

export function mailEnabled(env: MailEnv): boolean {
  return env.MAIL_MODE === "log" || !!(env.MAILJET_API_KEY && env.MAILJET_API_SECRET && env.MAIL_FROM);
}

export function parseFrom(from: string): { Email: string; Name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { Email: m[2].trim(), ...(m[1] ? { Name: m[1].replace(/^"|"$/g, "") } : {}) } : { Email: from.trim() };
}

/** Sends one message. Never throws; returns false when it couldn't be sent. */
export async function sendMail(env: MailEnv, mail: Mail, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (env.MAIL_MODE === "log") {
    console.log(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    return true;
  }
  if (!mailEnabled(env)) return false;
  try {
    const res = await fetchImpl("https://api.mailjet.com/v3.1/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_API_SECRET}`)}`,
      },
      body: JSON.stringify({
        Messages: [{ From: mail.fromName ? { ...parseFrom(env.MAIL_FROM!), Name: mail.fromName } : parseFrom(env.MAIL_FROM!), To: [{ Email: mail.to }], ...(mail.replyTo ? { ReplyTo: { Email: mail.replyTo } } : {}), Subject: mail.subject, TextPart: mail.text, HTMLPart: mail.html }],
      }),
    });
    if (!res.ok) console.error(`mail failed: ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("mail failed", e);
    return false;
  }
}
