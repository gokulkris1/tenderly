import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

/**
 * The authenticated eTenders account client (Beta).
 *
 * eTenders has no public API for buyer messaging, so with the user's own
 * credentials this client walks the documented ePPS flow:
 *
 *   1. POST the login form            → a session cookie
 *   2. open the CfT workspace page    → find the Messaging link
 *   3. open Messaging                 → the exchange list for that CfT
 *   4. POST the compose form          → a new clarification sent to the buyer
 *
 * HONESTY RAIL: this client has been written against the documented flow and
 * is exercised only against synthetic fixtures. It has never been verified
 * against the live portal, and nothing here may claim otherwise — connection
 * status moves to "ok"/"failed" only after a real attempt, and a send that
 * the portal does not confirm is a failure, never a fabricated success.
 *
 * Every step fails loudly and specifically rather than guessing: a wrong
 * password is PORTAL_AUTH_FAILED, a redesigned page is PORTAL_LAYOUT_CHANGED,
 * and anything else is PORTAL_UNAVAILABLE. The password is never logged.
 */

const ETENDERS_HOSTS = new Set(["www.etenders.gov.ie", "etenders.gov.ie"]);
const LOGIN_PAGE_URL = "https://www.etenders.gov.ie/epps/home.do";
const USER_AGENT = "TenderlyBidAssistant/0.1 (+user-authorised portal messaging; low-rate)";
const MAX_HTML_BYTES = 6 * 1024 * 1024;

export type PortalErrorCode = "PORTAL_AUTH_FAILED" | "PORTAL_LAYOUT_CHANGED" | "PORTAL_UNAVAILABLE";

export class PortalError extends Error {
  readonly code: PortalErrorCode;
  constructor(code: PortalErrorCode, message: string) {
    super(message);
    this.name = "PortalError";
    this.code = code;
  }
}

export type PortalSession = {
  /** The Cookie header value for subsequent requests. */
  cookies: string;
  /** Who the session belongs to (the login name, never the password). */
  email: string;
};

/** One message in a CfT's messaging exchange, as listed by the portal. */
export type PortalMessage = {
  /** The portal's own message identifier, when the page exposes one. */
  messageId: string | null;
  direction: "out" | "in";
  subject: string;
  body: string;
  sentOn: string;
};

type FetchImpl = typeof fetch;

function assertPortalUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new PortalError("PORTAL_UNAVAILABLE", "The eTenders address could not be read"); }
  if (url.protocol !== "https:" || !ETENDERS_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new PortalError("PORTAL_UNAVAILABLE", "Portal messaging is restricted to https://www.etenders.gov.ie");
  }
  return url;
}

/** The CfT workspace page for one notice. */
export function cftWorkspaceUrl(resourceId: string) {
  return `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(resourceId)}`;
}

async function fetchPage(fetchImpl: FetchImpl, url: string, session?: PortalSession): Promise<{ html: string; url: string }> {
  assertPortalUrl(url);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        ...(session ? { Cookie: session.cookies } : {}),
      },
      signal: AbortSignal.timeout(18_000),
      redirect: "follow",
    });
  } catch (error) {
    throw new PortalError("PORTAL_UNAVAILABLE", `eTenders could not be reached: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new PortalError("PORTAL_UNAVAILABLE", `eTenders returned HTTP ${response.status}`);
  const finalUrl = assertPortalUrl(response.url || url).toString();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_HTML_BYTES) throw new PortalError("PORTAL_UNAVAILABLE", "eTenders returned an unexpectedly large page");
  return { html: bytes.toString("utf8"), url: finalUrl };
}

/** Reads Set-Cookie headers into one Cookie header value. */
function sessionFrom(response: Response, email: string): PortalSession {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  const cookies = raw.map((entry) => entry.split(";")[0]).filter(Boolean).join("; ");
  if (!cookies) {
    // A login answer with no session cookie means the portal did not accept
    // the sign-in or the flow changed underneath us; we cannot tell which.
    throw new PortalError("PORTAL_AUTH_FAILED", "eTenders did not start a session — check the email and password");
  }
  return { cookies, email };
}

/** Every hidden field on a form, exactly as the page published it. */
function hiddenFields($: cheerio.CheerioAPI, form: cheerio.Cheerio<AnyNode>): Record<string, string> {
  const fields: Record<string, string> = {};
  form.find("input[type=hidden]").each((_index, input) => {
    const name = $(input).attr("name");
    if (name) fields[name] = $(input).attr("value") ?? "";
  });
  return fields;
}

/**
 * Signs in. The form is discovered on the page rather than hard-coded: the
 * day eTenders renames a field, this fails as PORTAL_LAYOUT_CHANGED instead of
 * silently posting nothing.
 */
export async function portalLogin(
  credentials: { email: string; password: string },
  options: { fetchImpl?: FetchImpl } = {},
): Promise<PortalSession> {
  const doFetch = options.fetchImpl ?? fetch;
  const page = await fetchPage(doFetch, LOGIN_PAGE_URL);
  const $ = cheerio.load(page.html);
  const form = $("form").filter((_i, candidate) => {
    const action = $(candidate).attr("action") ?? "";
    return /login|signin|j_security_check/i.test(action) || $(candidate).find("input[type=password]").length > 0;
  }).first();
  if (!form.length) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "The eTenders sign-in form was not found — the login page layout may have changed");
  }
  const action = new URL(form.attr("action") ?? "", page.url);
  const userField = form.find("input[type=email], input[name*=user], input[name*=email], input[name*=login]").first().attr("name");
  const passField = form.find("input[type=password]").first().attr("name");
  if (!userField || !passField) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "The eTenders sign-in form fields were not recognised — the layout may have changed");
  }

  const body = new URLSearchParams({
    ...hiddenFields($, form),
    [userField]: credentials.email,
    [passField]: credentials.password,
  });
  let response: Response;
  try {
    response = await doFetch(action.toString(), {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(18_000),
    });
  } catch (error) {
    throw new PortalError("PORTAL_UNAVAILABLE", `eTenders could not be reached: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (!response.ok) throw new PortalError("PORTAL_UNAVAILABLE", `eTenders sign-in returned HTTP ${response.status}`);
  const html = await response.text();

  // The portal answers a bad password with the login page again, usually with
  // an error notice. A session cookie is the positive signal; a returned
  // password field is the negative one.
  const result = cheerio.load(html);
  if (result("input[type=password]").length > 0) {
    throw new PortalError("PORTAL_AUTH_FAILED", "eTenders returned the sign-in page again — the credentials were not accepted");
  }
  return sessionFrom(response, credentials.email);
}

/**
 * The messaging exchange for one CfT.
 *
 * Rows are read from the messaging table defensively: a row that carries no
 * date-shaped cell is not a message and is skipped, so a page redesign yields
 * an explicit PORTAL_LAYOUT_CHANGED rather than a pile of nonsense records.
 */
export function parseMessagingListHtml(html: string): PortalMessage[] {
  const $ = cheerio.load(html);
  const table = $("table").filter((_i, candidate) => /message|subject|from/i.test($(candidate).text())).first();
  if (!table.length) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "The messaging page has no recognisable message table — the layout may have changed");
  }
  const messages: PortalMessage[] = [];
  table.find("tr").each((_index, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;
    const texts = cells.map((_i, cell) => $(cell).text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()).get();
    const dateIndex = texts.findIndex((text) => /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}/.test(text));
    if (dateIndex < 0) return; // header or decoration, not a message
    const link = $(row).find("a[href]").first();
    const href = link.attr("href") ?? "";
    const messageId = /(?:messageId|message_id|msgId)=(\d+)/.exec(href)?.[1] ?? null;
    const subject = link.text().replace(/\s+/g, " ").trim() || texts[dateIndex === 0 ? 1 : 0] || "";
    // The exchange has two parties: a sender named as the contracting side is
    // the buyer, anything else is treated as the account's own message. When
    // the portal does not mark the sender clearly, this is best-effort and the
    // row still says it came from the portal rather than pretending certainty.
    const who = `${texts.join(" ")} ${$(row).attr("class") ?? ""}`.toLowerCase();
    const direction: "out" | "in" =
      /contracting|buyer|authority/.test(who) || $(row).hasClass("incoming") ? "in" : "out";
    messages.push({
      messageId,
      direction,
      subject,
      body: texts.filter((_text, index) => index !== dateIndex).join(" — "),
      sentOn: texts[dateIndex],
    });
  });
  return messages;
}

/**
 * Lists the exchange for one CfT: workspace page → Messaging link → list.
 * A CfT page without a messaging link is a layout change, not an empty inbox.
 */
export async function listPortalMessages(
  session: PortalSession,
  resourceId: string,
  options: { fetchImpl?: FetchImpl } = {},
): Promise<PortalMessage[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const workspace = await fetchPage(doFetch, cftWorkspaceUrl(resourceId), session);
  const messagingUrl = findMessagingLink(workspace.html, workspace.url);
  const page = await fetchPage(doFetch, messagingUrl, session);
  if (/sign in|log in|password/i.test(page.html.slice(0, 2000)) && cheerio.load(page.html)("input[type=password]").length > 0) {
    throw new PortalError("PORTAL_AUTH_FAILED", "The portal session was not accepted — sign in again");
  }
  return parseMessagingListHtml(page.html);
}

function findMessagingLink(html: string, baseUrl: string): string {
  const $ = cheerio.load(html);
  const href = $("a[href]").filter((_i, link) => {
    const target = $(link).attr("href") ?? "";
    return /messag/i.test(target) || /messag/i.test($(link).text());
  }).first().attr("href");
  if (!href) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "No messaging link on the CfT workspace page — the layout may have changed");
  }
  return assertPortalUrl(new URL(href, baseUrl).toString()).toString();
}

/**
 * Sends one clarification message through the CfT's compose form.
 *
 * The form's own hidden fields are echoed back untouched — they carry the CfT
 * reference the portal expects, and guessing them is how messages land on the
 * wrong competition. A response that shows no confirmation and no message
 * table is treated as a layout change: we do not know what happened, so we
 * say that rather than claim the buyer received anything.
 */
export async function sendPortalMessage(
  session: PortalSession,
  resourceId: string,
  message: { subject: string; body: string },
  options: { fetchImpl?: FetchImpl } = {},
): Promise<{ messageId: string | null }> {
  const doFetch = options.fetchImpl ?? fetch;
  const workspace = await fetchPage(doFetch, cftWorkspaceUrl(resourceId), session);
  const messagingUrl = findMessagingLink(workspace.html, workspace.url);
  const listPage = await fetchPage(doFetch, messagingUrl, session);

  const $ = cheerio.load(listPage.html);
  const form = $("form").filter((_i, candidate) => {
    const action = $(candidate).attr("action") ?? "";
    const hasBody = $(candidate).find("textarea").length > 0;
    return hasBody && (/messag|compose|reply/i.test(action) || $(candidate).find("input[name*=subject]").length > 0);
  }).first();
  if (!form.length) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "No compose form on the messaging page — the layout may have changed");
  }
  const subjectField = form.find("input[name*=subject], input[name*=title]").first().attr("name");
  const bodyField = form.find("textarea").first().attr("name");
  if (!subjectField || !bodyField) {
    throw new PortalError("PORTAL_LAYOUT_CHANGED", "The compose form fields were not recognised — the layout may have changed");
  }

  const action = new URL(form.attr("action") ?? "", listPage.url);
  const response = await doFetch(assertPortalUrl(action.toString()).toString(), {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookies,
    },
    body: new URLSearchParams({ ...hiddenFields($, form), [subjectField]: message.subject, [bodyField]: message.body }),
    redirect: "follow",
    signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new PortalError("PORTAL_UNAVAILABLE", `eTenders messaging returned HTTP ${response.status}`);
  const result = await response.text();
  if (/invalid|incorrect|not accepted|error has occurred/i.test(result) && !/sent|received|success/i.test(result)) {
    throw new PortalError("PORTAL_UNAVAILABLE", "eTenders reported an error sending the message");
  }
  const confirmed = /message (has been )?sent|successfully|received by/i.test(result);
  if (!confirmed) {
    // The portal's confirmation text is unknown to us; a page that simply
    // shows the exchange again is only proof when the new subject appears.
    try {
      const listed = parseMessagingListHtml(result);
      if (!listed.some((entry) => entry.subject === message.subject)) {
        throw new PortalError("PORTAL_LAYOUT_CHANGED", "The portal did not confirm the message was sent");
      }
      return { messageId: listed.find((entry) => entry.subject === message.subject)?.messageId ?? null };
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError("PORTAL_LAYOUT_CHANGED", "The portal did not confirm the message was sent");
    }
  }
  return { messageId: /(?:messageId|message_id|msgId)=(\d+)/.exec(result)?.[1] ?? null };
}
