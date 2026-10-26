/// <reference types="vite/client" />
import type { CallNotesApi } from '../../shared/api'

declare global {
  interface Window {
    callNotes: CallNotesApi
  }
}
