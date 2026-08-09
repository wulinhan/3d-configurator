// Sending the one email this service sends.
//
// Sign-in and invitations both go out as a link. Everything else a merchant
// needs, they see in the Studio.

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Development, and the tests: nothing leaves the process. The link is
 * printed so a local sign-in is a copy-paste away. */
export function consoleMailer(log: (line: string) => void = console.log): Mailer & { sent: Array<{ to: string; text: string }> } {
  const sent: Array<{ to: string; text: string }> = [];
  return {
    sent,
    async send(message) {
      sent.push({ to: message.to, text: message.text });
      log(`[mail] ${message.to}: ${message.subject}\n${message.text}`);
    },
  };
}

/**
 * Resend, over plain fetch.
 *
 * One provider, ten lines, no SDK. If you move to SES or Postmark, the
 * `Mailer` interface above is the whole contract — this function is the
 * example, not the commitment.
 */
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(message) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: message.to, subject: message.subject, text: message.text }),
      });
      if (!res.ok) throw new Error(`mail send failed: ${res.status} ${await res.text()}`);
    },
  };
}

export function shareEmail(projectName: string, byEmail: string, role: 'editor' | 'viewer', appBase: string): { subject: string; text: string } {
  return {
    subject: `${byEmail} shared "${projectName}" with you`,
    text: `${byEmail} shared the product "${projectName}" with you in the configurator Studio`
      + (role === 'editor' ? ', with permission to edit it.' : ', to view and try out.')
      + `\n\nSign in with this email address to open it:\n${appBase}\n\n`
      + 'If you were not expecting this, you can ignore this email.',
  };
}

export function signInEmail(link: string, orgName?: string): { subject: string; text: string } {
  return orgName
    ? {
      subject: `You have been invited to ${orgName}`,
      text: `You have been invited to work on ${orgName} in the configurator Studio.\n\n${link}\n\n`
        + 'The link works once and expires in 15 minutes. If you were not expecting it, ignore this email.',
    }
    : {
      subject: 'Your sign-in link',
      text: `Here is your sign-in link for the configurator Studio.\n\n${link}\n\n`
        + 'It works once and expires in 15 minutes. If you did not ask for it, ignore this email.',
    };
}
