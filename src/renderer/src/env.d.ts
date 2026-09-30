/// <reference types="vite/client" />

interface Window {
  /** 只在引擎窗口里有 */
  __engine?: import('./engine/engine').Engine
}
