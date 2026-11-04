import { useState } from "react";
import type { PortalConnection } from "@tenderly/shared";

const STATUS_LABELS: Record<PortalConnection["status"], string> = {
  disabled: "Disabled",
  untested: "Not verified",
  ok: "Connected",
  failed: "Failed",
};

/**
 * Linking the workspace's own eTenders account so clarifications can be sent
 * and synced from Tenderly. The copy is deliberately plain about the terms:
 * the user's own account, messages sent as them, their responsibility.
 */
export function PortalConnectionCard({ portal, state, busy, error, onConnect, onDisconnect, isDemo }: {
  portal: PortalConnection | null;
  state: "loading" | "ready" | "error";
  busy: boolean;
  error?: string;
  onConnect: (email: string, password: string) => void;
  onDisconnect: () => void;
  isDemo: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const disabled = portal?.status === "disabled";

  return (
    <section className="panel settings-list portal-card" data-testid="portal-connection">
      <div>
        <span>
          <strong>eTenders portal connection (Beta)</strong>
          <small>Send and sync tender clarifications through your own eTenders account.</small>
        </span>
        {state === "loading" && <span className="portal-status-badge status-untested">Checking…</span>}
        {state === "ready" && portal && (
          <span className={`portal-status-badge status-${portal.status}`} data-testid="portal-status">{STATUS_LABELS[portal.status]}</span>
        )}
      </div>

      <p className="portal-copy">
        Uses your own eTenders account. Credentials are encrypted; messages are sent as you. You are responsible for your portal credentials.
      </p>

      {state === "error" && (
        <p className="auth-error" role="alert">{error || "Could not load the portal connection status."}</p>
      )}

      {state === "ready" && disabled && (
        <p className="portal-disabled" data-testid="portal-disabled">Not enabled on this server</p>
      )}

      {state === "ready" && portal && !disabled && (
        <>
          {portal.connected ? (
            <>
              <div className="portal-facts">
                <span><strong>Signed in as</strong><small>{portal.email ?? "eTenders account"}</small></span>
                {portal.verifiedAt && <span><strong>Verified</strong><small>{new Date(portal.verifiedAt).toLocaleString()}</small></span>}
                {portal.lastSyncAt && <span><strong>Last sync</strong><small>{new Date(portal.lastSyncAt).toLocaleString()}</small></span>}
              </div>
              {portal.status === "failed" && portal.error && (
                <p className="auth-error" role="alert" data-testid="portal-error">{portal.error}</p>
              )}
              <div>
                <span />
                <button className="quiet-btn" onClick={onDisconnect} disabled={busy}>{busy ? "Disconnecting…" : "Disconnect"}</button>
              </div>
            </>
          ) : (
            <form
              className="portal-connect"
              onSubmit={(event) => {
                event.preventDefault();
                if (email.trim() && password) {
                  onConnect(email.trim(), password);
                  setPassword("");
                }
              }}
            >
              {portal.status === "failed" && portal.error && (
                <p className="auth-error" role="alert" data-testid="portal-error">{portal.error}</p>
              )}
              <label>Email<input type="email" aria-label="eTenders account email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || isDemo} required autoComplete="username" /></label>
              <label>Password<input type="password" aria-label="eTenders account password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy || isDemo} required autoComplete="current-password" /></label>
              <div>
                <span />
                <button className="continue-btn" type="submit" disabled={busy || isDemo || !email.trim() || !password}>{busy ? "Connecting…" : "Connect portal"}</button>
              </div>
            </form>
          )}
        </>
      )}

      {error && state !== "error" && <p className="auth-error" role="alert" data-testid="portal-action-error">{error}</p>}
      {isDemo && <p className="portal-demo-note">Demo workspace — the form is illustrative; connect the live API to link a real account.</p>}
    </section>
  );
}
