export function createBrevoEmailSender({
  apiKey,
  senderEmail,
  senderName = 'DriveNight',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey && !senderEmail) return null;
  if (!apiKey || !senderEmail || typeof fetchImpl !== 'function') {
    throw new Error('Brevo e-mail requires an API key, a verified sender, and fetch.');
  }

  return async ({ to, code, purpose }) => {
    const subject = purpose === 'email-change'
      ? 'Confirmez votre nouvelle adresse e-mail DriveNight'
      : 'Votre code de vérification DriveNight';
    const text = [
      `Votre code de vérification DriveNight est : ${code}`,
      '',
      'Ce code expire dans 5 minutes et ne peut être utilisé qu’une seule fois.',
      'Si vous n’avez pas demandé ce code, ignorez cet e-mail.',
    ].join('\n');

    let response;
    try {
      response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { email: senderEmail, name: senderName },
          to: [{ email: to }],
          subject,
          textContent: text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('EMAIL_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const error = new Error('EMAIL_PROVIDER_REJECTED');
      error.status = response.status;
      throw error;
    }
  };
}
