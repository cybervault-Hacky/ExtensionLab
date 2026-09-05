/**
 * Email abstraction. Providers only receive fully rendered messages; they
 * never see templates, tokens in structured form, or user records.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSendResult {
  ok: boolean;
  /** Provider-specific id; only ever logged as a redacted field. */
  providerMessageId?: string;
  /** True when the failure is transient and worth retrying. */
  transient?: boolean;
  /** Internal detail for logs; never shown to users. */
  detail?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage, options: { from: string }): Promise<EmailSendResult>;
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}
