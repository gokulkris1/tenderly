import { log } from "./logging.js";

/**
 * Outbound email, behind one function.
 *
 * The transactional provider has not been chosen yet — that is TLY-35, and it
 * is a decision with contractual and data-processing consequences that does not
 * belong inside a feature story. Everything that needs to send mail sends it
 * through here, so choosing the provider is one file, and nothing else has to
 * know.
 *
 * Until then the "sent" message is written to the server log and the send is
 * reported as undelivered, which is the honest answer: an invitation that was
 * never emailed must not be described to the user as one that was.
 */

export type Email = {
  to: string;
  subject: string;
  text: string;
};

export type SendResult = {
  /** True only when a provider actually accepted the message. */
  delivered: boolean;
  /** Which transport handled it: "log" until TLY-35 lands. */
  transport: string;
};

/** Set in tests so an assertion can be made about what would have been sent. */
type Recorder = (email: Email) => void;
let recorder: Recorder | null = null;

/** Records outbound mail instead of sending it. Returns the messages captured. */
export function captureEmail(): { sent: Email[]; stop: () => void } {
  const sent: Email[] = [];
  recorder = (email) => sent.push(email);
  return { sent, stop: () => { recorder = null; } };
}

/** True when a provider is configured and mail actually leaves the building. */
export function mailConfigured() {
  return false;
}

export async function sendEmail(email: Email): Promise<SendResult> {
  recorder?.(email);
  // Subject and recipient, never the body: an invitation link in a log file is
  // a way into somebody's workspace.
  log("info", { event: "email", to: email.to, subject: email.subject, transport: "log" });
  return { delivered: false, transport: "log" };
}
