// Type declaration for Electron's <webview> custom element (real embedded
// browser for the floating workspace). Kept in a module file so the
// `declare module 'react'` block augments React instead of replacing it.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}

export {};
