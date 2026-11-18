/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_OPERATOR_EMAIL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
