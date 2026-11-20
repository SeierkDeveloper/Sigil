// The small round marks that say where something came from: which kind of app,
// and which kind of source a memory has. Icons only; the words stay next to them.

import type { AppKind, SourceKind } from "@sigil/core";
import { CardIcon, ChatGptIcon, ClaudeIcon, CursorIcon, EditorIcon, ExtensionIcon, GlobeIcon, McpIcon } from "@/components/icons";

const APP_ICONS: Record<AppKind, typeof ClaudeIcon> = {
  "claude-desktop": ClaudeIcon,
  cursor: CursorIcon,
  chatgpt: ChatGptIcon,
  other: McpIcon,
  extension: ExtensionIcon,
  web: GlobeIcon,
};

const SOURCE_ICONS: Record<SourceKind, typeof ClaudeIcon> = {
  note: EditorIcon,
  chatgpt: ChatGptIcon,
  claude: ClaudeIcon,
  app: McpIcon,
  web: GlobeIcon,
  profile: CardIcon,
};

export function AppMark({ kind, className = "" }: { kind?: AppKind; className?: string }) {
  const Icon = (kind && APP_ICONS[kind]) || McpIcon;
  return (
    <span className={`mark ${className}`.trim()} data-kind={kind ?? "gone"} aria-hidden="true">
      <Icon />
    </span>
  );
}

export function SourceMark({ kind, className = "" }: { kind: SourceKind; className?: string }) {
  const Icon = SOURCE_ICONS[kind] ?? EditorIcon;
  return (
    <span className={`mark ${className}`.trim()} data-source={kind} aria-hidden="true">
      <Icon />
    </span>
  );
}
