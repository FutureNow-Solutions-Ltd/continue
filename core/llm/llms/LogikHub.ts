import * as vscode from "vscode";
import LogikHubAuthProvider from "../../../extensions/vscode/src/stubs/LogikHubAuthProvider";
import { CompletionOptions, LLMOptions } from "../../index.js";
import { BaseLLM } from "../index.js";
import { streamSse } from "../stream.js";

// This static variable ensures we register the auth provider only once.
let authProviderRegistered = false;

class LogikHub extends BaseLLM {
  static providerName = "logikhub";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://127.0.0.1:8080/",
  };

  /**
   * Ensures that there is a valid bearer token by lazily registering
   * the LogikHub authentication provider (if necessary) and obtaining a session.
   */
  private async ensureAuthenticated(scopes: string[]): Promise<void> {
    // Register the LogikHub authentication provider if not already registered.
    if (!authProviderRegistered) {
      vscode.authentication.registerAuthenticationProvider(
        "logikhub", // This identifier must match when using getSession.
        "LogikHub", // Display name.
        new LogikHubAuthProvider(),
        { supportsMultipleAccounts: false },
      );
      authProviderRegistered = true;
    }
    // If the authorization header is missing or empty, get a session.
    if (!this.requestOptions?.headers?.Authorization) {
      const session = await vscode.authentication.getSession(
        "logikhub",
        scopes,
        { createIfNone: true },
      );
      this.requestOptions = this.requestOptions || {};
      this.requestOptions.headers = {
        ...this.requestOptions.headers,
        Authorization: `Bearer ${session.accessToken}`,
      };
    }
  }

  /**
   * Maps the completion options to the parameters expected by the LogikHub API.
   */
  private _convertArgs(options: CompletionOptions, prompt: string) {
    return {
      text: prompt, // The prompt to be completed
      version: "C",
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_k: options.topK,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      min_p: options.minP,
      mirostat: options.mirostat,
      stop: options.stop,
      stream: true, // Always stream since we call complete_v2 as a streaming API
    };
  }

  /**
   * Makes a POST call to the complete_v2 endpoint of LogikHub and streams the response.
   */
  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    // Ensure the user is authenticated; specify the necessary scopes.
    await this.ensureAuthenticated(["logikhub.read", "logikhub.write"]);

    const headers = {
      "Content-Type": "application/json",
      // Security/authentication headers omitted during early development.
      ...this.requestOptions?.headers,
    };

    // Construct the URL for the complete_v2 endpoint
    const endpoint = new URL("/v2/completions", this.apiBase);
    const body = JSON.stringify(this._convertArgs(options, prompt));

    const response = await this.fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal,
    });

    /*
    // Stream the response using streamSse and yield text chunks when available.
    for await (const chunk of streamSse(response)) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
    */

    let accumulated = "";
    // Stream the response using streamSse and yield only the new text chunks.
    for await (const chunk of streamSse(response)) {
      if (chunk.text) {
        // Calculate the new text that wasn't seen in the previous chunk
        const delta = chunk.text.substring(accumulated.length);
        accumulated = chunk.text;
        if (delta) {
          yield delta;
        }
      }
    }
  }
}

export default LogikHub;
