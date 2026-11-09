// Type declarations for tdweb (TDLib's web client, third_party/td/example/web/tdweb), which ships none.
// The options are those documented in tdweb's src/index.js.

declare module 'tdweb' {
  export type TdObject = { '@type': string; [field: string]: unknown };

  export type TdClientOptions = {
    onUpdate?: (update: TdObject) => void;
    instanceName?: string;
    isBackground?: boolean;
    jsLogVerbosityLevel?: 'error' | 'warning' | 'info' | 'log' | 'debug';
    logVerbosityLevel?: number;
    useDatabase?: boolean;
    readOnly?: boolean;
  };

  export class TdClient {
    constructor(options: TdClientOptions);
    send(query: TdObject): Promise<TdObject>;
  }

  /**
   * The package's CommonJS exports. tdweb is a webpack bundle of an ES module, so they are { default: TdClient }.
   * An ES module package ("type": "module") receives CommonJS exports as its default import, by Node's rule, which
   * esbuild follows.
   */
  const commonJsExports: { default: typeof TdClient };
  export default commonJsExports;
}
