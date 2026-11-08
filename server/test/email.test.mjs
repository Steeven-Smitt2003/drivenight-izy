import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrevoEmailSender } from '../src/email/brevo.mjs';

test('Brevo sender sends a plain-text verification email from the configured sender', async () => {
  let request;
  const send = createBrevoEmailSender({
    apiKey: 'test-secret',
    senderEmail: 'verification@example.test',
    senderName: 'DriveNight',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 201 };
    },
  });

  await send({ to: 'user@example.test', code: '048251', purpose: 'signup' });

  assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['api-key'], 'test-secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    sender: { email: 'verification@example.test', name: 'DriveNight' },
    to: [{ email: 'user@example.test' }],
    subject: 'Votre code de vérification DriveNight',
    textContent: [
      'Votre code de vérification DriveNight est : 048251',
      '',
      'Ce code expire dans 5 minutes et ne peut être utilisé qu’une seule fois.',
      'Si vous n’avez pas demandé ce code, ignorez cet e-mail.',
    ].join('\n'),
  });
});

test('Brevo sender does not expose provider response bodies on failure', async () => {
  const send = createBrevoEmailSender({
    apiKey: 'test-secret',
    senderEmail: 'verification@example.test',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });

  await assert.rejects(
    send({ to: 'user@example.test', code: '048251', purpose: 'signup' }),
    (error) => error.message === 'EMAIL_PROVIDER_REJECTED' && error.status === 401,
  );
});
