import { escapeHtml } from '~/lib/html';

export const NOREPLY_SENDER: EmailAddress = {
  email: 'noreply@fairportdrama.com',
  name: 'Fairport Drama Club',
};

/**
 * Error codes that a retry can plausibly resolve. Everything else is a
 * permanent failure where retrying only wastes quota and delays the error
 * reaching a human.
 */
const RETRYABLE_CODES = new Set([
  'E_RATE_LIMIT_EXCEEDED',
  'E_DELIVERY_FAILED',
  'E_INTERNAL_SERVER_ERROR',
]);

export interface EmailFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

export type EmailResult = { ok: true; messageId: string } | EmailFailure;

/**
 * Sends transactional mail, returning a result rather than throwing.
 *
 * Callers decide what a failure means. That is deliberate: an invite whose
 * email failed should still leave the invite row in place so an admin can
 * resend, rather than rolling back and losing the record of who was invited.
 */
export async function sendEmail(
  binding: SendEmail,
  message: Omit<EmailMessageBuilder, 'from'> & { from?: EmailAddress },
): Promise<EmailResult> {
  try {
    const result = await binding.send({
      ...message,
      from: message.from ?? NOREPLY_SENDER,
    } as EmailMessageBuilder);
    return { ok: true, messageId: result.messageId };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'E_UNKNOWN';
    const message =
      error instanceof Error ? error.message : 'Unknown email delivery error';

    return {
      ok: false,
      code,
      message:
        code === 'E_SENDER_NOT_VERIFIED'
          ? 'fairportdrama.com is not onboarded for Email Sending. Run: wrangler email sending enable fairportdrama.com'
          : message,
      retryable: RETRYABLE_CODES.has(code),
    };
  }
}

/**
 * Minimal HTML shell for transactional mail. Inline styles only - email
 * clients strip <style> blocks and have no access to the site's stylesheet.
 */
export function emailShell(headline: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#cc0000;">${escapeHtml(headline)}</h1>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #e7e5e4;margin:32px 0 16px;" />
      <p style="margin:0;font-size:12px;color:#78716c;">
        Fairport High School Drama Club
      </p>
    </div>
  </body>
</html>`;
}
