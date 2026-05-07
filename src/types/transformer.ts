import { LLMProvider, UnifiedChatRequest } from "./llm.js";

export interface TransformerOptions {
  [key: string]: any;
}

export interface TransformerContext {
  [key: string]: any;
}

export type Transformer = {
  transformRequestIn?: (
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext,
  ) => Promise<Record<string, any>>;
  transformResponseIn?: (
    response: Response,
    context?: TransformerContext,
  ) => Promise<Response>;

  transformRequestOut?: (
    request: any,
    context: TransformerContext,
  ) => Promise<UnifiedChatRequest>;
  transformResponseOut?: (
    response: Response,
    context: TransformerContext,
  ) => Promise<Response>;

  endPoint?: string;
  name?: string;
  auth?: (
    request: any,
    provider: LLMProvider,
    context: TransformerContext,
  ) => Promise<any>;

  logger?: any;
};
