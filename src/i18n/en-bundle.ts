import { en } from './en.ts'
import { enAiAppearance } from './en-ai-appearance.ts'
import { enStudio } from './en-studio.ts'
import { enStarpetWorkspace } from './en-starpet-workspace.ts'
import { enData } from './en-data.ts'
import { enUpdates } from './en-updates.ts'
import { enPrivacy } from './en-privacy.ts'
import { enHandwriting } from './en-handwriting.ts'
import { enTelemetry } from './en-telemetry.ts'
import { enStats } from './en-stats.ts'
import { enMarkdown } from './en-markdown.ts'
import { backendEn, backendPatterns } from './backend.ts'

export const enModules: Record<string, Record<string, string>> = {
  en,
  enAiAppearance,
  enStudio,
  enStarpetWorkspace,
  enData,
  enUpdates,
  enPrivacy,
  enHandwriting,
  enTelemetry,
  enStats,
  enMarkdown,
  backendEn,
}

export const enCatalog: Record<string, string> = {
  ...en,
  ...enAiAppearance,
  ...enStudio,
  ...enStarpetWorkspace,
  ...enData,
  ...enUpdates,
  ...enPrivacy,
  ...enHandwriting,
  ...enTelemetry,
  ...enStats,
  ...enMarkdown,
  ...backendEn,
}

export { backendPatterns }
