// Minimal ambient declarations for untyped runtime dependencies.
// html-to-text v10 ships no TypeScript declarations and there is no
// @types/html-to-text. This mirrors the runtime API we use.
declare module "html-to-text" {
  export interface HtmlToTextOptions {
    wordwrap?: boolean | number | null;
    [key: string]: unknown;
  }
  export function convert(html: string, options?: HtmlToTextOptions): string;
  export function compile(options?: HtmlToTextOptions): (html: string) => string;
  export const htmlToText: typeof convert;
}
