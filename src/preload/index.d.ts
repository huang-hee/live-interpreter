import type { InterpreterApi } from '../shared/types'

declare global {
  interface Window {
    api: InterpreterApi
  }
}
