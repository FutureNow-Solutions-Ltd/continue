import axios, { AxiosInstance } from "axios";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
} from "openai/resources/index";
import readline from "readline";
import { LogikHubConfig } from "../types.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  RerankCreateParams,
} from "./base.js";

export class LogikHubApi implements BaseLlmApi {
  private apiBase: string = "https://localhost:8080/";
  private token: string | null = null;
  private client: AxiosInstance;

  constructor(protected config: LogikHubConfig) {
    this.apiBase = config.apiBase ?? this.apiBase;
    if (!this.apiBase.endsWith("/")) {
      this.apiBase += "/";
    }
    // Initialise Axios client with base URL
    this.client = axios.create({
      baseURL: this.apiBase,
    });
  }

  // Sign-in logic is kept for completeness, though security is not a current focus.
  async signIn(username: string, password: string): Promise<void> {
    try {
      const response = await this.client.post("/signin", {
        username,
        password,
      });
      this.token = response.data.token;
      this.client.defaults.headers.common["Authorization"] =
        `Bearer ${this.token}`;
    } catch (error: any) {
      throw new Error("LogikHub sign-in failed: " + error.message);
    }
  }

  // For non-streaming chat completions, LogikHub forces streaming so we throw
  async chatCompletionNonStream(
    body: any,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    throw new Error(
      "Method not implemented. LogikHub endpoint only supports streaming.",
    );
  }

  // The implemented streaming method connects with LogikHub's complete_v2 endpoint
  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    // Transform the incoming body as needed for LogikHub's API.
    // Assume modifyChatBody is a helper method that converts ChatCompletion parameters
    // from Continue into LogikHub’s expected format.
    const payload = {
      ...this.modifyChatBody(body),
      version: "C", // Always use version "C"
    };

    try {
      // Call the complete_v2 endpoint with responseType set to "stream"
      const response = await this.client.post("v2/complete_v2", payload, {
        responseType: "stream",
        signal,
      });

      // Create a readline interface to process the streamed response line-by-line.
      const rl = readline.createInterface({
        input: response.data,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0) continue;
        try {
          const chunk: ChatCompletionChunk = JSON.parse(trimmedLine);
          yield chunk;
        } catch (parseError: any) {
          // Handle or log parsing errors for individual chunks as needed.
          console.error("Error parsing chunk:", parseError);
        }
      }
    } catch (error: any) {
      throw new Error("LogikHub chat stream error: " + error.message);
    }
  }

  // Placeholder for the transform helper. In a complete implementation, this function
  // would convert Continue's chat request format into the format expected by LogikHub.
  protected modifyChatBody(
    body: ChatCompletionCreateParamsStreaming,
  ): Record<string, any> {
    // For example purposes, assume the body has a messages field and other parameters.
    // You might want to extract the prompt text from the conversation.
    return {
      prompt: body.messages?.map((msg) => msg.content).join("\n") || "",
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      // include any other necessary parameters
    };
  }

  async completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    throw new Error("Method not implemented.");
  }
  async *completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion, any, unknown> {
    throw new Error("Method not implemented.");
  }
  async *fimStream(
    body: any,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    throw new Error("Method not implemented.");
  }

  async embed(body: any): Promise<any> {
    throw new Error("Method not implemented.");
  }

  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    throw new Error("Method not implemented.");
  }

  list(): Promise<any[]> {
    throw new Error("Method not implemented.");
  }
}
