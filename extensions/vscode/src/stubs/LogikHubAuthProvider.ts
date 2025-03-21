import * as vscode from "vscode";

export class LogikHubAuthenticationProvider
  implements vscode.AuthenticationProvider
{
  // An event emitter to notify when sessions change.
  private _onDidChangeSessions: vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions: vscode.Event<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent> =
    this._onDidChangeSessions.event;

  // In-memory session storage.
  private sessions: vscode.AuthenticationSession[] = [];

  // Return available sessions, optionally filtered by scopes.
  async getSessions(
    scopes?: string[],
  ): Promise<vscode.AuthenticationSession[]> {
    if (scopes && scopes.length) {
      return this.sessions.filter((session) =>
        scopes.every((scope) => session.scopes.includes(scope)),
      );
    }
    return this.sessions;
  }

  // Create a new session by triggering the sign-in process.
  async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
    // Trigger a sign-in process. Replace this with your actual LogikHub sign-in logic.
    const accessToken = await loginhubSignIn();
    const account = {
      id: "user@logikhub",
      label: "LogikHub User",
    };

    // Create a new session with a unique id.
    const session = {
      id: Date.now().toString(), // simple unique session ID for demo purposes
      scopes,
      accessToken,
      account: account,
    } as vscode.AuthenticationSession;

    // Store and emit session change.
    this.sessions.push(session);
    this._onDidChangeSessions.fire({
      added: [session],
      removed: [],
      changed: [],
    });
    return session;
  }

  // Remove an existing session.
  async removeSession(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex(
      (session) => session.id === sessionId,
    );
    if (index > -1) {
      const removed = this.sessions.splice(index, 1);
      this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
    }
  }
}

// Simulated LogikHub sign-in process.
// Replace this with your actual sign-in logic, such as presenting a login UI or calling LogikHub's API.
async function loginhubSignIn(): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("sample-logikhub-access-token");
    }, 1000);
  });
}

// Activation function for your extension.
export function activate(context: vscode.ExtensionContext) {
  const provider = new LogikHubAuthenticationProvider();

  // Register the authentication provider.
  const providerDisposable =
    vscode.authentication.registerAuthenticationProvider(
      "logikhub", // Identifier used for getSession calls.
      "LogikHub", // Display name.
      provider,
      { supportsMultipleAccounts: false },
    );

  context.subscriptions.push(providerDisposable);
}

// This method is called when your extension is deactivated.
export function deactivate() {}
