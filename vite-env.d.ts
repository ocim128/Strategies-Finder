/// <reference types="vite/client" />

declare interface ImportMetaEnv {
    readonly VITE_TWELVE_DATA_API_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

declare module '*.txt?raw' {
    const content: string;
    export default content;
}
